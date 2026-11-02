import type { GenContext } from '../context.js';
import { RuleRun, type RuleResult } from './common.js';

export function emitEventBus(ctx: GenContext, id: string): RuleResult {
  const run = new RuleRun(ctx, id, 'messaging/event-bus@1');
  const out = ctx.out;
  const v = ctx.varName(id);
  out.use('events');
  run.t.omitted(
    'name',
    'Physical name not set so the new bus cannot collide with the existing one.',
  );
  run.header();
  out.line(`const ${v} = new events.EventBus(this, ${ctx.str(ctx.logicalId(id))});`);
  run.tags(v);
  run.register('buses', v);
  return run.result('L2');
}
