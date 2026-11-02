import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EvidenceGraph,
  type Answer,
  type ReconstructionPlan,
  type ReconstructionQuestion,
} from '@cloud-to-code/core';
import {
  PlanningError,
  applicationIdFor,
  parseAnswersFile,
  type PlanIssue,
  type SessionStatus,
  type SubmitItem,
} from '@cloud-to-code/reconstruction';
import {
  emit,
  note,
  resolveSessionId,
  resolveSnapshot,
  type Context,
  type SourceOptions,
} from '../context.js';
import { CliError, ExitCode } from '../exit-codes.js';
import {
  formatAnswer,
  renderDecisions,
  renderPlanSummary,
  renderQuestion,
  renderStatus,
} from '../render.js';

type Outcome = 'OK' | 'NEEDS_INPUT' | 'BLOCKED' | 'FAILED';

function readAnswersFile(ctx: Context, path: string): SubmitItem[] {
  try {
    return parseAnswersFile(JSON.parse(readFileSync(resolve(ctx.io.cwd, path), 'utf8')));
  } catch (error) {
    throw new CliError(
      `Cannot use answers file ${path}: ${(error as Error).message}`,
      ExitCode.USAGE,
      'answers-file-invalid',
    );
  }
}

export function runQuestions(ctx: Context, options: { all?: boolean }): number {
  const id = resolveSessionId(ctx);
  const pending = ctx.service.pending(id, { all: options.all === true });
  const total = pending.questions.length;
  const human =
    total === 0
      ? `${renderStatus(pending.status)}\nNo pending questions.`
      : [
          renderStatus(pending.status),
          '',
          ...pending.questions.map((q, i) => renderQuestion(q, { index: i + 1, total })),
          '',
          pending.remaining > 0
            ? `${pending.remaining} more question(s) after these (use --all to list everything).`
            : '',
          `Answer with: c2c answer <id> <option> --session ${id}`,
        ]
          .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
          .join('\n\n');
  emit(
    ctx,
    {
      status: pending.status.blocking.length > 0 ? 'NEEDS_INPUT' : 'OK',
      session: pending.status,
      questions: pending.questions,
      remaining: pending.remaining,
    },
    human,
  );
  return ExitCode.OK;
}

export function runAnswer(
  ctx: Context,
  questionId: string | undefined,
  answer: string | undefined,
  options: { note?: string; answers?: string; unknown?: boolean },
): number {
  const id = resolveSessionId(ctx);
  let items: SubmitItem[];
  let source: 'answers-file' | 'interactive-user' = 'interactive-user';
  if (options.answers) {
    items = readAnswersFile(ctx, options.answers);
    source = 'answers-file';
  } else {
    if (!questionId || (!answer && !options.unknown)) {
      throw new CliError(
        'Usage: c2c answer <questionId> <optionId> [--note text] | --unknown | --answers <file>',
        ExitCode.USAGE,
        'usage',
      );
    }
    const value: Answer =
      options.unknown || answer === 'unknown'
        ? { kind: 'unknown' }
        : { kind: 'choice', optionId: answer!, ...(options.note ? { note: options.note } : {}) };
    items = [{ questionId, answer: value }];
  }
  const result = ctx.service.submit(id, items, source);
  const lines = [
    ...result.accepted.map(
      (d) =>
        `recorded ${d.questionId} = ${formatAnswer(d.answer)}${d.redactions > 0 ? ` (${d.redactions} secret-like fragment(s) redacted)` : ''}`,
    ),
    ...result.rejected.map((r) => `rejected ${r.questionId}: ${r.error}`),
    '',
    renderStatus(result.status),
  ];
  emit(
    ctx,
    {
      status: result.rejected.length > 0 ? 'FAILED' : 'OK',
      accepted: result.accepted,
      rejected: result.rejected,
      session: result.status,
    },
    lines.join('\n'),
  );
  return result.rejected.length > 0 ? ExitCode.USAGE : ExitCode.OK;
}

export function runDecisions(ctx: Context, options: { history?: boolean }): number {
  const id = resolveSessionId(ctx);
  const { latest, history } = ctx.service.decisions(id);
  emit(
    ctx,
    { status: 'OK', latest, history },
    renderDecisions(latest, history, options.history === true),
  );
  return ExitCode.OK;
}

export interface InterviewResult {
  outcome: Outcome;
  status: SessionStatus;
  questions: ReconstructionQuestion[];
  remaining: number;
  rejected: { questionId: string; error: string }[];
  plan?: ReconstructionPlan;
  issues: PlanIssue[];
}

/**
 * Drive a session as far as it can go without inventing answers: apply an answers file, ask interactively when
 * a terminal is available, then build and verify the plan. Never waits on input in non-interactive mode.
 */
export async function runInterview(
  ctx: Context,
  sessionId: string,
  options: { answers?: string; application?: string },
): Promise<InterviewResult> {
  const svc = ctx.service;
  const rejected: InterviewResult['rejected'] = [];

  if (options.answers) {
    const result = svc.submit(sessionId, readAnswersFile(ctx, options.answers), 'answers-file');
    rejected.push(...result.rejected);
    for (const r of result.rejected) note(ctx, `rejected ${r.questionId}: ${r.error}`);
  }

  if (ctx.interactive && ctx.io.prompter) {
    const skipped = new Set<string>();
    for (;;) {
      const batch = svc.pending(sessionId).questions.filter((q) => !skipped.has(q.id));
      if (batch.length === 0) break;
      for (const [index, q] of batch.entries()) {
        const answer = await ctx.io.prompter.ask(q, { index: index + 1, total: batch.length });
        if (!answer) {
          skipped.add(q.id);
          continue;
        }
        const result = svc.submit(sessionId, [{ questionId: q.id, answer }], 'interactive-user');
        for (const r of result.rejected) {
          note(ctx, `rejected ${r.questionId}: ${r.error}`);
          skipped.add(q.id);
        }
      }
    }
  }

  const pending = svc.pending(sessionId);
  const status = pending.status;
  const base = { status, questions: pending.questions, remaining: pending.remaining, rejected };
  if (status.state === 'BLOCKED') return { ...base, outcome: 'BLOCKED', issues: [] };
  if (status.blocking.length > 0) return { ...base, outcome: 'NEEDS_INPUT', issues: [] };

  const planned = svc.plan(sessionId);
  if (!planned.plan)
    return { ...base, status: planned.status, outcome: 'FAILED', issues: planned.issues };
  return {
    ...base,
    status: planned.status,
    outcome: 'OK',
    plan: planned.plan,
    issues: planned.issues,
  };
}

const EXIT_FOR: Record<Outcome, number> = {
  OK: ExitCode.OK,
  NEEDS_INPUT: ExitCode.NEEDS_INPUT,
  BLOCKED: ExitCode.BLOCKED,
  FAILED: ExitCode.FAILED,
};

export function reportInterview(ctx: Context, sessionId: string, result: InterviewResult): number {
  const exitCode = EXIT_FOR[result.outcome];
  const humanParts: string[] = [renderStatus(result.status)];
  if (result.outcome === 'NEEDS_INPUT') {
    humanParts.push(
      '',
      'NEEDS_INPUT: these questions must be answered before a plan can be built.',
      ...result.questions.map(
        (q, i) => `\n${renderQuestion(q, { index: i + 1, total: result.questions.length })}`,
      ),
      '',
      `Answer with: c2c answer <id> <option> --session ${sessionId}   (then: c2c resume --session ${sessionId})`,
      `Or pass --answers <file>. Nothing was generated and no AWS resource was touched.`,
    );
  } else if (result.outcome === 'BLOCKED') {
    humanParts.push(
      '',
      `BLOCKED: ${result.status.stateReason ?? 'a blocking question has no usable answer'}`,
      `Revise it with: c2c answer <id> <option> --session ${sessionId}`,
    );
  } else if (result.outcome === 'FAILED') {
    humanParts.push(
      '',
      'FAILED: the plan did not pass verification:',
      ...result.issues.map((i) => `  [${i.severity}] ${i.code}: ${i.message}`),
    );
  } else if (result.plan) {
    humanParts.push(
      '',
      renderPlanSummary(result.plan),
      '',
      'Plan verified deterministically. No AWS resources were modified.',
    );
  }
  emit(
    ctx,
    {
      status: result.outcome,
      exitCode,
      session: result.status,
      questions: result.questions,
      remaining: result.remaining,
      rejected: result.rejected,
      issues: result.issues,
      ...(result.plan ? { plan: result.plan } : {}),
    },
    humanParts.join('\n'),
  );
  return exitCode;
}

export async function runResume(ctx: Context, options: { answers?: string }): Promise<number> {
  const id = resolveSessionId(ctx);
  ctx.service.resume(id);
  const result = await runInterview(ctx, id, options.answers ? { answers: options.answers } : {});
  return reportInterview(ctx, id, result);
}

export async function runReconstruct(
  ctx: Context,
  application: string | undefined,
  options: SourceOptions & { answers?: string; strategy?: string; resume?: boolean },
): Promise<number> {
  let sessionId: string;
  if (ctx.opts.session && !options.snapshot && !options.demo) {
    sessionId = ctx.opts.session;
    ctx.service.resume(sessionId);
  } else {
    const loaded = resolveSnapshot(ctx, options);
    note(ctx, `Source: ${loaded.origin}`);
    for (const w of loaded.warnings) note(ctx, `warning: ${w}`);
    if (loaded.redactions > 0)
      note(ctx, `${loaded.redactions} secret-like value(s) were redacted before storing.`);
    const strategy = (options.strategy ?? 'balanced') as 'faithful' | 'balanced' | 'modernized';
    if (!['faithful', 'balanced', 'modernized'].includes(strategy)) {
      throw new CliError(
        `Unknown strategy "${options.strategy}". Use faithful, balanced or modernized.`,
        ExitCode.USAGE,
        'usage',
      );
    }
    let applicationId = application;
    if (!applicationId) {
      const candidates = new EvidenceGraph(loaded.snapshot)
        .applicationCandidates()
        .candidates.map((c) => applicationIdFor(c.name));
      if (candidates.length === 1) applicationId = candidates[0];
      else if (ctx.interactive && ctx.io.prompter)
        applicationId = await ctx.io.prompter.chooseApplication(candidates);
      if (!applicationId) {
        throw new CliError(
          `Several application candidates found (${candidates.join(', ')}). Choose one: c2c reconstruct <application>.`,
          ExitCode.USAGE,
          'application-not-selected',
        );
      }
    }
    try {
      const session = ctx.service.startSession(loaded.snapshot, { strategy, applicationId });
      sessionId = session.id;
    } catch (error) {
      if (error instanceof PlanningError)
        throw new CliError(error.message, ExitCode.USAGE, error.code);
      throw error;
    }
    note(ctx, `Session ${sessionId} created in ${ctx.store.root}`);
  }
  const result = await runInterview(
    ctx,
    sessionId,
    options.answers ? { answers: options.answers } : {},
  );
  return reportInterview(ctx, sessionId, result);
}
