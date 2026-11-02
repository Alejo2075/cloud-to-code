import type { GenContext } from '../context.js';
import { RuleRun, type RuleResult } from './common.js';

interface RuleTarget {
  id?: string;
  arn?: string;
  input?: unknown;
  inputPath?: string;
  inputTransformer?: unknown;
  deadLetterConfig?: unknown;
  retryPolicy?: unknown;
}

const PATTERN_KEYS: Record<string, string> = {
  source: 'source',
  'detail-type': 'detailType',
  detail: 'detail',
  account: 'account',
  region: 'region',
  resources: 'resources',
  id: 'id',
  time: 'time',
  version: 'version',
};

export function emitRule(ctx: GenContext, id: string): RuleResult {
  const run = new RuleRun(ctx, id, 'events/event-rule@1');
  const { t } = run;
  const out = ctx.out;
  const v = ctx.varName(id);
  const logical = ctx.logicalId(id);
  out.use('events');

  const props: string[] = [];
  const busName = t.take<string>('eventBusName');
  const busId = [...ctx.byId.values()].find(
    (e) =>
      e.resource.type === 'AWS::Events::EventBus' &&
      (e.resource.physicalId === busName || e.resource.displayName === busName),
  )?.resource.id;
  if (busId) props.push(`eventBus: ${ctx.ref(busId)},`);
  else if (busName && busName !== 'default') {
    run.unresolve(
      'eventBusName',
      `Event bus ${busName} is not part of this plan; the rule would be created on the default bus. Wire the bus manually.`,
    );
  }

  const state = t.take<string>('state');
  if (state === 'DISABLED') props.push('enabled: false,');
  const description = t.take<string>('description');
  if (description) props.push(`description: ${ctx.str(description)},`);

  const pattern = t.take<Record<string, unknown>>('eventPattern');
  if (pattern) {
    const mapped: Record<string, unknown> = {};
    for (const [k, value] of Object.entries(pattern)) {
      const key = PATTERN_KEYS[k];
      if (key) mapped[key] = value;
      else
        run.unresolve(
          `eventPattern.${k}`,
          'Pattern field is not representable in the L2 EventPattern; add it manually.',
        );
    }
    props.push(`eventPattern: ${ctx.value(mapped, 1)},`);
  }
  const schedule = t.take<string>('scheduleExpression');
  if (schedule) {
    out.use('events');
    props.push(`schedule: events.Schedule.expression(${ctx.str(schedule)}),`);
  }
  t.omitted('name', 'Physical name not set so the new rule cannot collide with the existing one.');

  const targets: string[] = [];
  const observed = t.take<RuleTarget[]>('targets') ?? [];
  observed.forEach((target, i) => {
    const label = `targets[${i}]`;
    if (
      target.input !== undefined ||
      target.inputPath ||
      target.inputTransformer ||
      target.deadLetterConfig ||
      target.retryPolicy
    ) {
      run.unresolve(
        label,
        'Target input transformation, dead-letter or retry settings are not mapped yet; configure them manually.',
      );
      return;
    }
    const targetId = ctx.resolveArn(target.arn);
    const type = targetId ? ctx.entry(targetId).resource.type : undefined;
    if (targetId && type === 'AWS::Lambda::Function') {
      out.use('targets');
      targets.push(`new targets.LambdaFunction(${ctx.ref(targetId)})`);
    } else if (targetId && type === 'AWS::SQS::Queue') {
      out.use('targets');
      targets.push(`new targets.SqsQueue(${ctx.ref(targetId)})`);
    } else {
      run.unresolve(
        label,
        `Target ${target.arn ?? '(unknown)'} is not a Lambda function or SQS queue in this plan; add it manually.`,
      );
    }
  });
  if (targets.length > 0) props.push(`targets: [${targets.join(', ')}],`);

  run.header();
  out.line(`const ${v} = new events.Rule(this, ${ctx.str(logical)}, {`);
  for (const p of props) out.line(`  ${p}`);
  out.line('});');
  run.tags(v);
  run.register('rules', v);
  return run.result('L2');
}
