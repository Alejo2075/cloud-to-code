import {
  ListEventSourceMappingsCommand,
  ListFunctionsCommand,
  ListTagsCommand,
  type ListEventSourceMappingsCommandOutput,
  type ListFunctionsCommandOutput,
  type ListTagsCommandOutput,
} from '@aws-sdk/client-lambda';
import { resourceFromArn } from '../arn.js';
import type { CollectContext } from '../sink.js';
import { paginate } from '../util.js';

export async function collectLambda(ctx: CollectContext): Promise<void> {
  const { sink, region } = ctx;
  const functions = await paginate(async (marker) => {
    const out = await ctx.send<ListFunctionsCommandOutput>(
      new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }),
    );
    return { items: out.Functions ?? [], next: out.NextMarker };
  });

  await ctx.map(functions, async (fn) => {
    const name = fn.FunctionName;
    const arn = fn.FunctionArn;
    if (!name || !arn) return;
    // The API returns environment variable VALUES with the configuration. Only the names are kept; the values
    // are dropped here, in memory, and never stored, logged or sent anywhere.
    const envNames = Object.keys(fn.Environment?.Variables ?? {}).sort();

    const mappings = await ctx.soft(
      `lambda:ListEventSourceMappings(${name})`,
      () =>
        paginate(async (marker) => {
          const out = await ctx.send<ListEventSourceMappingsCommandOutput>(
            new ListEventSourceMappingsCommand({ FunctionName: name, Marker: marker }),
          );
          return { items: out.EventSourceMappings ?? [], next: out.NextMarker };
        }),
      name,
    );
    const tags = await ctx.soft<ListTagsCommandOutput>(
      `lambda:ListTags(${name})`,
      () => ctx.send(new ListTagsCommand({ Resource: arn })),
      name,
    );

    const resource = sink.addResource({
      type: 'AWS::Lambda::Function',
      region,
      physicalId: name,
      arn,
      operation: 'lambda:ListFunctions',
      tags: tags?.Tags,
      properties: {
        runtime: fn.Runtime,
        handler: fn.Handler,
        memorySize: fn.MemorySize,
        timeout: fn.Timeout,
        architectures: fn.Architectures,
        packageType: fn.PackageType,
        description: fn.Description || undefined,
        roleArn: fn.Role,
        tracingMode: fn.TracingConfig?.Mode,
        ephemeralStorageSize: fn.EphemeralStorage?.Size,
        environmentVariableNames: envNames,
        layers: (fn.Layers ?? []).map((l) => l.Arn).filter(Boolean),
        vpcConfig: fn.VpcConfig?.VpcId
          ? { subnetIds: fn.VpcConfig.SubnetIds, securityGroupIds: fn.VpcConfig.SecurityGroupIds }
          : undefined,
        deadLetterConfig: fn.DeadLetterConfig?.TargetArn
          ? { targetArn: fn.DeadLetterConfig.TargetArn }
          : undefined,
        kmsKeyArn: fn.KMSKeyArn,
        fileSystemConfigs: fn.FileSystemConfigs?.length
          ? fn.FileSystemConfigs.map((f) => ({ arn: f.Arn, localMountPath: f.LocalMountPath }))
          : undefined,
        eventSourceMappings: (mappings ?? []).map((m) => ({
          eventSourceArn: m.EventSourceArn,
          batchSize: m.BatchSize,
          startingPosition: m.StartingPosition,
          enabled: m.State === 'Enabled' || m.State === 'Enabling',
          maximumBatchingWindowInSeconds: m.MaximumBatchingWindowInSeconds || undefined,
        })),
      },
    });

    if (fn.Role)
      sink.relateToArn(
        resource.id,
        fn.Role,
        'assumes-role',
        'confirmed',
        'lambda:ListFunctions.Role',
        `${name} -> role`,
      );
    for (const m of mappings ?? []) {
      if (!m.EventSourceArn) continue;
      const source = resourceFromArn(m.EventSourceArn, ctx.accountId);
      if (!source) {
        sink.diag({
          code: 'unsupported-event-source',
          severity: 'info',
          message: `${name} has an event source (${m.EventSourceArn}) of an unsupported type.`,
          resourceId: resource.id,
        });
        continue;
      }
      sink.relate(
        source.id,
        resource.id,
        'triggers',
        'confirmed',
        'lambda:ListEventSourceMappings',
        `${source.physicalId} -> ${name}`,
      );
    }
  });
}
