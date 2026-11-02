import { renderMermaid } from '@cloud-to-code/diagram-mermaid';
import { inspectSnapshot, applicationIdFor } from '@cloud-to-code/reconstruction';
import { emit, note, resolveSnapshot, type Context, type SourceOptions } from '../context.js';
import { CliError, ExitCode } from '../exit-codes.js';
import { renderInspection } from '../render.js';

export interface InspectOptions extends SourceOptions {
  diagram?: boolean;
}

export function runInspect(
  ctx: Context,
  application: string | undefined,
  options: InspectOptions,
): number {
  const loaded = resolveSnapshot(ctx, options);
  note(ctx, `Source: ${loaded.origin}`);
  for (const w of loaded.warnings) note(ctx, `warning: ${w}`);
  if (loaded.redactions > 0)
    note(ctx, `${loaded.redactions} secret-like value(s) were redacted from the input.`);

  const report = inspectSnapshot(loaded.snapshot);
  if (application) {
    const wanted = application.toLowerCase();
    const candidate = report.candidates.find(
      (c) => applicationIdFor(c.name) === wanted || c.id === wanted,
    );
    if (!candidate) {
      throw new CliError(
        `Application "${application}" not found. Candidates: ${report.candidates.map((c) => applicationIdFor(c.name)).join(', ')}.`,
        ExitCode.USAGE,
        'application-not-found',
      );
    }
    report.candidates = [candidate];
    report.shared = report.shared.filter((s) => candidate.sharedResourceIds.includes(s.resourceId));
  }

  const diagram = options.diagram ? renderMermaid(loaded.snapshot) : undefined;
  if (diagram && !ctx.json) {
    ctx.io.stdout(diagram);
    return ExitCode.OK;
  }
  emit(
    ctx,
    { status: 'OK', exitCode: 0, source: loaded.origin, report, ...(diagram ? { diagram } : {}) },
    renderInspection(report),
  );
  return ExitCode.OK;
}
