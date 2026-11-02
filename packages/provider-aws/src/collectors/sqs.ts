import {
  GetQueueAttributesCommand,
  ListQueueTagsCommand,
  ListQueuesCommand,
  type GetQueueAttributesCommandOutput,
  type ListQueueTagsCommandOutput,
  type ListQueuesCommandOutput,
} from '@aws-sdk/client-sqs';
import type { CollectContext } from '../sink.js';
import { paginate } from '../util.js';

const num = (v: string | undefined): number | undefined =>
  v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined;

export async function collectSqs(ctx: CollectContext): Promise<void> {
  const { sink, region } = ctx;
  const urls = await paginate(async (token) => {
    const out = await ctx.send<ListQueuesCommandOutput>(
      new ListQueuesCommand({ NextToken: token, MaxResults: 100 }),
    );
    return { items: out.QueueUrls ?? [], next: out.NextToken };
  });

  await ctx.map(urls, async (url) => {
    const name = url.split('/').pop() ?? url;
    const attrs = await ctx.soft<GetQueueAttributesCommandOutput>(
      `sqs:GetQueueAttributes(${name})`,
      () => ctx.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] })),
      name,
    );
    const a = attrs?.Attributes;
    if (!a?.['QueueArn']) return;
    const tags = await ctx.soft<ListQueueTagsCommandOutput>(
      `sqs:ListQueueTags(${name})`,
      () => ctx.send(new ListQueueTagsCommand({ QueueUrl: url })),
      name,
    );

    // `Policy` (the resource policy) is also returned by 'All'; it is intentionally not read into the snapshot.
    let redrive: { deadLetterTargetArn?: string; maxReceiveCount?: number } | undefined;
    if (a['RedrivePolicy']) {
      try {
        redrive = JSON.parse(a['RedrivePolicy']) as typeof redrive;
      } catch {
        sink.diag({
          code: 'unparseable-redrive-policy',
          severity: 'warning',
          message: `Redrive policy of ${name} could not be parsed.`,
          service: 'sqs',
          region,
        });
      }
    }
    const queue = sink.addResource({
      type: 'AWS::SQS::Queue',
      region,
      physicalId: name,
      arn: a['QueueArn'],
      operation: 'sqs:GetQueueAttributes',
      tags: tags?.Tags,
      properties: {
        queueName: name,
        fifoQueue: a['FifoQueue'] === 'true' ? true : false,
        contentBasedDeduplication: a['ContentBasedDeduplication'] === 'true' ? true : undefined,
        visibilityTimeout: num(a['VisibilityTimeout']),
        messageRetentionPeriod: num(a['MessageRetentionPeriod']),
        delaySeconds: num(a['DelaySeconds']),
        maximumMessageSize: num(a['MaximumMessageSize']),
        receiveMessageWaitTimeSeconds: num(a['ReceiveMessageWaitTimeSeconds']),
        sqsManagedSseEnabled:
          a['SqsManagedSseEnabled'] === undefined
            ? undefined
            : a['SqsManagedSseEnabled'] === 'true',
        kmsMasterKeyId: a['KmsMasterKeyId'],
        redrivePolicy: redrive?.deadLetterTargetArn
          ? {
              deadLetterTargetArn: redrive.deadLetterTargetArn,
              maxReceiveCount: redrive.maxReceiveCount,
            }
          : undefined,
      },
    });
    if (redrive?.deadLetterTargetArn) {
      sink.relateToArn(
        queue.id,
        redrive.deadLetterTargetArn,
        'dead-letters-to',
        'confirmed',
        'sqs:GetQueueAttributes.RedrivePolicy',
        `${name} -> dlq`,
      );
    }
  });
}
