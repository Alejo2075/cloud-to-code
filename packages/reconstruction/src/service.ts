import { randomBytes } from 'node:crypto';
import {
  EvidenceGraph,
  createSession,
  shortHash,
  transitionSession,
  validateAnswer,
  type Answer,
  type CloudSnapshot,
  type DeveloperDecision,
  type ReconstructionPlan,
  type ReconstructionQuestion,
  type Session,
  type SessionState,
  type Strategy,
} from '@cloud-to-code/core';
import { MAX_QUESTIONS_PER_BATCH, computeQuestions, selectBatch } from './questions.js';
import { buildPlan, PlanningError, selectApplication } from './planner.js';
import { verifyPlan, type PlanIssue } from './verify.js';
import type { WorkspaceStore } from './workspace.js';

export type DecisionSource = DeveloperDecision['source'];

export interface Clock {
  now(): Date;
}

export interface ServiceOptions {
  clock?: Clock;
  newId?: () => string;
}

export interface QuestionState {
  question: ReconstructionQuestion;
  /** `unanswered`, `answered`, `unknown` (answered "I don't know") or `reopened` (evidence changed). */
  status: 'unanswered' | 'answered' | 'unknown' | 'reopened';
  decision?: DeveloperDecision;
}

export interface SessionStatus {
  sessionId: string;
  state: SessionState;
  stateReason?: string;
  snapshotId: string;
  applicationId?: string;
  strategy: Strategy;
  totalQuestions: number;
  answered: number;
  pending: number;
  /** Blocking questions that are unanswered, reopened or answered "unknown". */
  blocking: string[];
  /** Can a plan be built and CDK generated right now? */
  canGenerate: boolean;
}

export interface PendingResult {
  status: SessionStatus;
  /** At most 3 per batch unless `all` is requested. */
  questions: ReconstructionQuestion[];
  /** Pending questions not shown in this batch. */
  remaining: number;
  reopened: ReconstructionQuestion[];
}

export interface SubmitItem {
  questionId: string;
  answer: Answer;
}

export interface SubmitResult {
  accepted: DeveloperDecision[];
  rejected: { questionId: string; error: string }[];
  status: SessionStatus;
}

export interface PlanResult {
  plan?: ReconstructionPlan;
  issues: PlanIssue[];
  status: SessionStatus;
}

function pendingKey(state: QuestionState): boolean {
  return state.status !== 'answered';
}

/**
 * Shared application API for CLI, MCP and plugins: sessions, questions, decisions and plans. It owns state and
 * validates every answer; hosts (terminal, AI provider, agent) only render questions and relay answers.
 */
export class ReconstructionService {
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(
    readonly store: WorkspaceStore,
    options: ServiceOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.newId = options.newId ?? (() => randomBytes(4).toString('hex'));
  }

  startSession(
    snapshot: CloudSnapshot,
    options: { strategy?: Strategy; applicationId?: string } = {},
  ): Session {
    if (options.applicationId)
      selectApplication(new EvidenceGraph(snapshot), options.applicationId);
    const id = `sess-${snapshot.id.replace(/^snap-/, '').slice(0, 8)}-${this.newId()}`;
    let session = createSession({
      id,
      snapshotId: snapshot.id,
      strategy: options.strategy ?? 'balanced',
      ...(options.applicationId ? { applicationId: options.applicationId } : {}),
      now: this.clock.now(),
    });
    session = transitionSession(session, 'ANALYZING', this.clock.now());
    this.store.createSession(session, snapshot);
    this.reconcile(session.id);
    return this.store.loadSession(id);
  }

  /** Current state of every question: unanswered / answered / unknown / reopened by changed evidence. */
  questionStates(sessionId: string): QuestionState[] {
    const snapshot = this.store.loadSnapshot(sessionId);
    const session = this.store.loadSession(sessionId);
    const decisions = this.store.loadDecisions(sessionId);
    const latest = new Map<string, DeveloperDecision>();
    for (const d of decisions) latest.set(d.questionId, d);
    // When an application is selected, only its questions (and the shared resources it touches) apply.
    let scope: Set<string> | undefined;
    if (session.applicationId) {
      const app = selectApplication(new EvidenceGraph(snapshot), session.applicationId);
      scope = new Set([...app.resourceIds, ...app.sharedResourceIds]);
    }
    const all = computeQuestions(snapshot, sessionId);
    const relevant = scope
      ? all.filter((q) => q.relatedResourceIds.some((id) => scope.has(id)))
      : all;
    return relevant.map((question): QuestionState => {
      const decision = latest.get(question.id);
      if (!decision) return { question, status: 'unanswered' };
      if (decision.subjectHash !== question.subjectHash) {
        return {
          question: {
            ...question,
            reopenedBecause:
              'The AWS evidence this decision depended on changed since you answered. Please confirm or revise it.',
          },
          status: 'reopened',
          decision,
        };
      }
      return {
        question,
        status: decision.answer.kind === 'unknown' ? 'unknown' : 'answered',
        decision,
      };
    });
  }

  status(sessionId: string): SessionStatus {
    const session = this.store.loadSession(sessionId);
    const states = this.questionStates(sessionId);
    const blocking = states
      .filter((s) => s.question.priority === 'blocking' && pendingKey(s))
      .map((s) => s.question.id);
    return {
      sessionId,
      state: session.state,
      ...(session.stateReason ? { stateReason: session.stateReason } : {}),
      snapshotId: session.snapshotId,
      ...(session.applicationId ? { applicationId: session.applicationId } : {}),
      strategy: session.strategy,
      totalQuestions: states.length,
      answered: states.filter((s) => s.status === 'answered').length,
      pending: states.filter(pendingKey).length,
      blocking,
      canGenerate: blocking.length === 0 && session.state !== 'FAILED',
    };
  }

  pending(sessionId: string, options: { all?: boolean; limit?: number } = {}): PendingResult {
    const states = this.questionStates(sessionId).filter(pendingKey);
    const questions = states.map((s) => s.question);
    const batch = options.all
      ? questions
      : selectBatch(questions, options.limit ?? MAX_QUESTIONS_PER_BATCH);
    return {
      status: this.status(sessionId),
      questions: batch,
      remaining: questions.length - batch.length,
      reopened: states.filter((s) => s.status === 'reopened').map((s) => s.question),
    };
  }

  /**
   * Validate and record answers. Rejects unknown question IDs, invalid options and (for non-allowing
   * questions) "unknown". Revising a question appends a new decision that supersedes the previous one.
   */
  submit(sessionId: string, items: readonly SubmitItem[], source: DecisionSource): SubmitResult {
    const session = this.store.loadSession(sessionId);
    const byId = new Map(this.questionStates(sessionId).map((s) => [s.question.id, s]));
    const accepted: DeveloperDecision[] = [];
    const rejected: SubmitResult['rejected'] = [];
    for (const item of items) {
      const state = byId.get(item.questionId);
      if (!state) {
        rejected.push({
          questionId: item.questionId,
          error: 'No such question in this session (it may not apply to the current evidence)',
        });
        continue;
      }
      const result = validateAnswer(state.question, item.answer);
      if (!result.ok) {
        rejected.push({ questionId: item.questionId, error: result.error });
        continue;
      }
      const decision: DeveloperDecision = {
        id: `dec-${shortHash({ s: sessionId, q: item.questionId, n: this.store.loadDecisions(sessionId).length }, 10)}`,
        questionId: item.questionId,
        sessionId,
        answer: result.answer,
        source,
        recordedAt: this.clock.now().toISOString(),
        subjectHash: state.question.subjectHash,
        ...(state.decision ? { supersedes: state.decision.id } : {}),
        redactions: result.redactions,
      };
      this.store.appendDecision(decision);
      accepted.push(decision);
    }
    if (accepted.length > 0 && session.state !== 'FAILED') this.reconcile(sessionId);
    return { accepted, rejected, status: this.status(sessionId) };
  }

  /** Latest decision per question plus full history, for `c2c decisions`. */
  decisions(sessionId: string): { latest: DeveloperDecision[]; history: DeveloperDecision[] } {
    const history = this.store.loadDecisions(sessionId);
    const latest = new Map<string, DeveloperDecision>();
    for (const d of history) latest.set(d.questionId, d);
    return { latest: [...latest.values()], history };
  }

  /** Replace the snapshot after a re-scan; answered questions whose evidence changed are reopened. */
  updateSnapshot(sessionId: string, snapshot: CloudSnapshot): SessionStatus {
    this.store.saveSnapshot(sessionId, snapshot);
    const session = this.store.loadSession(sessionId);
    this.store.saveSession({
      ...session,
      snapshotId: snapshot.id,
      updatedAt: this.clock.now().toISOString(),
    });
    this.reconcile(sessionId);
    return this.status(sessionId);
  }

  /** Resume: recompute state from stored snapshot + decisions without repeating answered questions. */
  resume(sessionId: string): PendingResult {
    this.reconcile(sessionId);
    return this.pending(sessionId);
  }

  /**
   * Build and verify a deterministic plan from the stored snapshot and decisions. Never invents answers:
   * blocking questions that are unresolved make this fail with issues instead.
   */
  plan(sessionId: string, options: { applicationId?: string } = {}): PlanResult {
    const session = this.store.loadSession(sessionId);
    const status = this.status(sessionId);
    const snapshot = this.store.loadSnapshot(sessionId);
    // Only decisions whose evidence is unchanged feed the plan; reopened ones must be re-confirmed first.
    const decisions = this.questionStates(sessionId)
      .filter((s) => s.decision !== undefined && s.status !== 'reopened')
      .map((s) => s.decision!);
    if (status.blocking.length > 0) {
      return {
        issues: status.blocking.map((id) => ({
          severity: 'error' as const,
          code: 'blocking-question-unresolved',
          message: `Blocking question ${id} is unanswered, answered "I don't know", or was reopened.`,
        })),
        status,
      };
    }
    try {
      const plan = buildPlan({
        snapshot,
        decisions,
        strategy: session.strategy,
        applicationId: options.applicationId ?? session.applicationId,
      });
      const issues = verifyPlan(plan, { snapshot, decisions, blockingUnresolved: status.blocking });
      if (issues.some((i) => i.severity === 'error')) return { issues, status };
      this.store.savePlan(sessionId, plan);
      if (!session.applicationId) {
        this.store.saveSession({
          ...this.store.loadSession(sessionId),
          applicationId: plan.applicationId,
        });
      }
      this.moveTo(sessionId, 'PLANNING');
      this.moveTo(sessionId, 'READY_FOR_REVIEW');
      return { plan, issues, status: this.status(sessionId) };
    } catch (error) {
      if (error instanceof PlanningError) {
        return {
          issues: [{ severity: 'error', code: error.code, message: error.message }],
          status,
        };
      }
      throw error;
    }
  }

  /** Latest decisions whose evidence is unchanged (reopened ones must be re-confirmed first). */
  currentDecisions(sessionId: string): DeveloperDecision[] {
    return this.questionStates(sessionId)
      .filter((s) => s.decision !== undefined && s.status !== 'reopened')
      .map((s) => s.decision!);
  }

  /**
   * The plan stored for this session (for example one submitted by an agent host), but only if it still passes
   * deterministic verification against the current snapshot and decisions. Stale or invalid plans are ignored.
   */
  verifiedStoredPlan(sessionId: string): ReconstructionPlan | undefined {
    const plan = this.store.loadPlan(sessionId);
    if (!plan) return undefined;
    if (this.status(sessionId).blocking.length > 0) return undefined;
    const decisions = this.questionStates(sessionId)
      .filter((s) => s.decision !== undefined && s.status !== 'reopened')
      .map((s) => s.decision!);
    const issues = verifyPlan(plan, {
      snapshot: this.store.loadSnapshot(sessionId),
      decisions,
      blockingUnresolved: [],
    });
    return issues.some((i) => i.severity === 'error') ? undefined : plan;
  }

  /**
   * Move the session toward the state implied by the current questions: BLOCKED when a blocking question was
   * answered "I don't know", AWAITING_INPUT while anything is pending, PLANNING when nothing is.
   */
  reconcile(sessionId: string): Session {
    const states = this.questionStates(sessionId);
    const blockingUnknown = states.filter(
      (s) => s.question.priority === 'blocking' && s.status === 'unknown',
    );
    const blockingOpen = states.filter(
      (s) =>
        s.question.priority === 'blocking' &&
        (s.status === 'unanswered' || s.status === 'reopened'),
    );
    if (blockingOpen.length > 0) return this.moveTo(sessionId, 'AWAITING_INPUT');
    if (blockingUnknown.length > 0) {
      return this.moveTo(
        sessionId,
        'BLOCKED',
        `Blocking question(s) answered "I don't know": ${blockingUnknown.map((s) => s.question.id).join(', ')}. Provide an answer to continue.`,
      );
    }
    if (states.some(pendingKey)) return this.moveTo(sessionId, 'AWAITING_INPUT');
    const session = this.store.loadSession(sessionId);
    if (['READY_FOR_REVIEW', 'GENERATING', 'VALIDATING', 'COMPLETED'].includes(session.state))
      return session;
    return this.moveTo(sessionId, 'PLANNING');
  }

  setState(sessionId: string, state: SessionState, reason?: string): Session {
    return this.moveTo(sessionId, state, reason);
  }

  private moveTo(sessionId: string, target: SessionState, reason?: string): Session {
    let session = this.store.loadSession(sessionId);
    if (session.state === target && !(reason && session.stateReason !== reason)) return session;
    // Walk legal paths: from a "settled" state go through ANALYZING when no direct transition exists.
    const now = this.clock.now();
    try {
      session = transitionSession(session, target, now, reason);
    } catch {
      session = transitionSession(session, 'ANALYZING', now);
      session = transitionSession(session, target, now, reason);
    }
    this.store.saveSession(session);
    return session;
  }
}
