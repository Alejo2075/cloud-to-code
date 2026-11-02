import {
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  type GetBucketEncryptionCommandOutput,
  type GetBucketLocationCommandOutput,
  type GetBucketNotificationConfigurationCommandOutput,
  type GetBucketTaggingCommandOutput,
  type GetBucketVersioningCommandOutput,
  type GetPublicAccessBlockCommandOutput,
  type ListBucketsCommandOutput,
} from '@aws-sdk/client-s3';
import { GLOBAL_REGION } from '@cloud-to-code/core';
import type { CollectContext } from '../sink.js';
import { paginate } from '../util.js';

/** `''` means us-east-1 and `EU` means eu-west-1 in GetBucketLocation. */
export function bucketRegion(location: string | undefined): string {
  if (!location) return 'us-east-1';
  return location === 'EU' ? 'eu-west-1' : location;
}

export interface BucketScope {
  regions: readonly string[];
}

/**
 * S3 metadata only: versioning, encryption, public access block, notification configuration and tags. Objects
 * are never listed or read. Buckets live in the global namespace but are only inspected when their region is in
 * scope; the S3 calls for a bucket must use a client for the bucket's own region (`senderFor`).
 */
export async function collectS3(
  ctx: CollectContext,
  scope: BucketScope,
  senderFor: (region: string) => CollectContext,
): Promise<void> {
  const { sink } = ctx;
  const buckets = await paginate(async (token) => {
    const out = await ctx.send<ListBucketsCommandOutput>(
      new ListBucketsCommand({ ContinuationToken: token, MaxBuckets: 1000 }),
    );
    return { items: out.Buckets ?? [], next: out.ContinuationToken };
  });

  await ctx.map(buckets, async (bucket) => {
    const name = bucket.Name;
    if (!name) return;
    const loc = await ctx.soft<GetBucketLocationCommandOutput>(
      `s3:GetBucketLocation(${name})`,
      () => ctx.send(new GetBucketLocationCommand({ Bucket: name })),
    );
    if (!loc) return;
    const region = bucketRegion(loc.LocationConstraint);
    if (!scope.regions.includes(region)) return;
    const rc = senderFor(region);
    const [versioning, encryption, pab, notif, tagging] = await Promise.all([
      rc.soft<GetBucketVersioningCommandOutput>(`s3:GetBucketVersioning(${name})`, () =>
        rc.send(new GetBucketVersioningCommand({ Bucket: name })),
      ),
      rc.soft<GetBucketEncryptionCommandOutput>(`s3:GetBucketEncryption(${name})`, () =>
        rc.send(new GetBucketEncryptionCommand({ Bucket: name })),
      ),
      rc.soft<GetPublicAccessBlockCommandOutput>(`s3:GetPublicAccessBlock(${name})`, () =>
        rc.send(new GetPublicAccessBlockCommand({ Bucket: name })),
      ),
      rc.soft<GetBucketNotificationConfigurationCommandOutput>(
        `s3:GetBucketNotificationConfiguration(${name})`,
        () => rc.send(new GetBucketNotificationConfigurationCommand({ Bucket: name })),
      ),
      rc.soft<GetBucketTaggingCommandOutput>(`s3:GetBucketTagging(${name})`, () =>
        rc.send(new GetBucketTaggingCommand({ Bucket: name })),
      ),
    ]);

    const rule =
      encryption?.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
    const lambdaNotifications = (notif?.LambdaFunctionConfigurations ?? []).map((n) => {
      const filters = n.Filter?.Key?.FilterRules ?? [];
      return {
        id: n.Id,
        events: n.Events,
        prefix: filters.find((f) => f.Name?.toLowerCase() === 'prefix')?.Value,
        suffix: filters.find((f) => f.Name?.toLowerCase() === 'suffix')?.Value,
        lambdaArn: n.LambdaFunctionArn,
      };
    });
    const resource = sink.addResource({
      type: 'AWS::S3::Bucket',
      region: GLOBAL_REGION,
      physicalId: name,
      arn: `arn:aws:s3:::${name}`,
      operation: 's3:GetBucketVersioning',
      tags: Object.fromEntries(
        (tagging?.TagSet ?? []).filter((t) => t.Key).map((t) => [t.Key!, t.Value ?? '']),
      ),
      properties: {
        bucketName: name,
        bucketRegion: region,
        versioning: versioning?.Status,
        encryption: rule
          ? { sseAlgorithm: rule.SSEAlgorithm, kmsMasterKeyId: rule.KMSMasterKeyID }
          : undefined,
        publicAccessBlock: pab?.PublicAccessBlockConfiguration
          ? {
              blockPublicAcls: pab.PublicAccessBlockConfiguration.BlockPublicAcls,
              ignorePublicAcls: pab.PublicAccessBlockConfiguration.IgnorePublicAcls,
              blockPublicPolicy: pab.PublicAccessBlockConfiguration.BlockPublicPolicy,
              restrictPublicBuckets: pab.PublicAccessBlockConfiguration.RestrictPublicBuckets,
            }
          : undefined,
        notifications: lambdaNotifications.length > 0 ? lambdaNotifications : undefined,
      },
    });
    for (const n of lambdaNotifications) {
      sink.relateToArn(
        resource.id,
        n.lambdaArn,
        'notifies',
        'confirmed',
        's3:GetBucketNotificationConfiguration',
        `${name} -> function`,
      );
    }
    if ((notif?.QueueConfigurations?.length ?? 0) + (notif?.TopicConfigurations?.length ?? 0) > 0) {
      sink.diag({
        code: 'unsupported-notification',
        severity: 'info',
        message: `Bucket ${name} has queue/topic notifications, which are not recorded yet.`,
        resourceId: resource.id,
      });
    }
  });
}
