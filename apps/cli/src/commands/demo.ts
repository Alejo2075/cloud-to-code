import { inspectSnapshot } from '@cloud-to-code/reconstruction';
import { demoSnapshot, emit, type Context } from '../context.js';
import { ExitCode } from '../exit-codes.js';
import { renderInspection } from '../render.js';

export function runDemo(ctx: Context): number {
  const { snapshot, origin } = demoSnapshot();
  const report = inspectSnapshot(snapshot);
  const human = [
    `Cloud to Code demo - ${origin}`,
    'No AWS credentials, network or AI provider are used. Everything below is computed offline.',
    '',
    renderInspection(report),
    '',
    'Next steps:',
    '  c2c inspect --demo --diagram                 # Mermaid diagram',
    '  c2c reconstruct orders-api --demo            # answer the questions, build a plan',
    '  c2c reconstruct orders-api --demo --non-interactive --json   # see NEEDS_INPUT as JSON',
  ].join('\n');
  emit(ctx, { status: 'OK', exitCode: 0, source: origin, report }, human);
  return ExitCode.OK;
}
