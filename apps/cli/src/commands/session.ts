import { EvidenceGraph, type Answer } from '@cloud-to-code/core';
import { PlanningError, applicationIdFor, type SubmitItem } from '@cloud-to-code/reconstruction';
import {
  emit,
  note,
  resolveSessionId,
  resolveSnapshot,
  type Context,
  type SourceOptions,
} from '../context.js';
import { CliError, ExitCode } from '../exit-codes.js';
import { formatAnswer, renderDecisions, renderQuestion, renderStatus } from '../render.js';
import { runGenerate } from './generate.js';
import { readAnswersFile, reportInterview, runInterview } from './interview.js';

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

export async function runResume(ctx: Context, options: { answers?: string }): Promise<number> {
  const id = resolveSessionId(ctx);
  ctx.service.resume(id);
  const result = await runInterview(ctx, id, options.answers ? { answers: options.answers } : {});
  return reportInterview(ctx, id, result);
}

export async function runReconstruct(
  ctx: Context,
  application: string | undefined,
  options: SourceOptions & {
    answers?: string;
    strategy?: string;
    resume?: boolean;
    output?: string;
    overwrite?: boolean;
    ai?: boolean;
    allowExternalModel?: boolean;
  },
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
  if (options.output) {
    // Same pipeline as `c2c generate`: answers file, interview, verified plan, generation, local checks.
    return runGenerate(ctx, {
      output: options.output,
      ...(options.overwrite ? { overwrite: true } : {}),
      ...(options.ai ? { ai: true } : {}),
      ...(options.allowExternalModel ? { allowExternalModel: true } : {}),
      ...(options.answers ? { answers: options.answers } : {}),
    });
  }
  const result = await runInterview(
    ctx,
    sessionId,
    options.answers ? { answers: options.answers } : {},
  );
  return reportInterview(ctx, sessionId, result);
}
