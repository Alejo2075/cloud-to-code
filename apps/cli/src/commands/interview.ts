import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReconstructionPlan, ReconstructionQuestion } from '@cloud-to-code/core';
import {
  parseAnswersFile,
  type PlanIssue,
  type SessionStatus,
  type SubmitItem,
} from '@cloud-to-code/reconstruction';
import { emit, note, type Context } from '../context.js';
import { CliError, ExitCode } from '../exit-codes.js';
import { renderPlanSummary, renderQuestion, renderStatus } from '../render.js';

type Outcome = 'OK' | 'NEEDS_INPUT' | 'BLOCKED' | 'FAILED';

export function readAnswersFile(ctx: Context, path: string): SubmitItem[] {
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
