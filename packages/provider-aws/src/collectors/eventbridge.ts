import {
  ListEventBusesCommand,
  ListRulesCommand,
  ListTagsForResourceCommand,
  ListTargetsByRuleCommand,
  type ListEventBusesCommandOutput,
  type ListRulesCommandOutput,
  type ListTagsForResourceCommandOutput,
  type ListTargetsByRuleCommandOutput,
} from '@aws-sdk/client-eventbridge';
import type { CollectContext } from '../sink.js';
import { paginate } from '../util.js';

export async function collectEventBridge(ctx: CollectContext): Promise<void> {
  const { sink, region } = ctx;
  const buses = await paginate(async (token) => {
    const out = await ctx.send<ListEventBusesCommandOutput>(
      new ListEventBusesCommand({ NextToken: token, Limit: 100 }),
    );
    return { items: out.EventBuses ?? [], next: out.NextToken };
  });

  for (const bus of buses) {
    const busName = bus.Name;
    if (!busName || !bus.Arn) continue;
    const busResource = sink.addResource({
      type: 'AWS::Events::EventBus',
      region,
      physicalId: busName,
      arn: bus.Arn,
      operation: 'events:ListEventBuses',
      properties: { name: busName },
    });

    const rules = await ctx.soft(
      `events:ListRules(${busName})`,
      () =>
        paginate(async (token) => {
          const out = await ctx.send<ListRulesCommandOutput>(
            new ListRulesCommand({ EventBusName: busName, NextToken: token, Limit: 100 }),
          );
          return { items: out.Rules ?? [], next: out.NextToken };
        }),
      busResource.id,
    );

    await ctx.map(rules ?? [], async (rule) => {
      if (!rule.Name || !rule.Arn) return;
      if (rule.ManagedBy) {
        sink.diag({
          code: 'managed-rule-skipped',
          severity: 'info',
          message: `Rule ${rule.Name} is managed by ${rule.ManagedBy} and was skipped.`,
          service: 'events',
          region,
        });
        return;
      }
      const targets = await ctx.soft(`events:ListTargetsByRule(${rule.Name})`, () =>
        paginate(async (token) => {
          const out = await ctx.send<ListTargetsByRuleCommandOutput>(
            new ListTargetsByRuleCommand({
              Rule: rule.Name,
              EventBusName: busName,
              NextToken: token,
              Limit: 100,
            }),
          );
          return { items: out.Targets ?? [], next: out.NextToken };
        }),
      );
      const tags = await ctx.soft<ListTagsForResourceCommandOutput>(
        `events:ListTagsForResource(${rule.Name})`,
        () => ctx.send(new ListTagsForResourceCommand({ ResourceARN: rule.Arn })),
      );
      let eventPattern: unknown;
      if (rule.EventPattern) {
        try {
          eventPattern = JSON.parse(rule.EventPattern);
        } catch {
          sink.diag({
            code: 'unparseable-event-pattern',
            severity: 'warning',
            message: `Event pattern of ${rule.Name} could not be parsed.`,
            service: 'events',
            region,
          });
        }
      }
      const resource = sink.addResource({
        type: 'AWS::Events::Rule',
        region,
        physicalId: `${busName}/${rule.Name}`,
        displayName: rule.Name,
        arn: rule.Arn,
        operation: 'events:ListRules',
        tags: Object.fromEntries(
          (tags?.Tags ?? []).filter((t) => t.Key).map((t) => [t.Key!, t.Value ?? '']),
        ),
        properties: {
          name: rule.Name,
          eventBusName: busName,
          state: rule.State,
          description: rule.Description || undefined,
          eventPattern,
          scheduleExpression: rule.ScheduleExpression,
          // Target inputs may carry data; only their presence is recorded.
          targets: (targets ?? []).map((t) => ({
            id: t.Id,
            arn: t.Arn,
            input: t.Input ? '[omitted]' : undefined,
            inputPath: t.InputPath ? '[omitted]' : undefined,
            inputTransformer: t.InputTransformer ? '[omitted]' : undefined,
            deadLetterConfig: t.DeadLetterConfig ? { arn: t.DeadLetterConfig.Arn } : undefined,
            retryPolicy: t.RetryPolicy
              ? {
                  maximumRetryAttempts: t.RetryPolicy.MaximumRetryAttempts,
                  maximumEventAgeInSeconds: t.RetryPolicy.MaximumEventAgeInSeconds,
                }
              : undefined,
          })),
        },
      });
      sink.relate(
        resource.id,
        busResource.id,
        'rule-on-bus',
        'confirmed',
        'events:ListRules',
        `${rule.Name} on ${busName}`,
      );
      for (const t of targets ?? []) {
        sink.relateToArn(
          resource.id,
          t.Arn,
          'targets',
          'confirmed',
          'events:ListTargetsByRule',
          `${rule.Name} -> target`,
        );
      }
    });
  }
}
