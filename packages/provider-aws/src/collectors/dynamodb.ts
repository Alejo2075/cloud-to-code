import {
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  type DescribeContinuousBackupsCommandOutput,
  type DescribeTableCommandOutput,
  type DescribeTimeToLiveCommandOutput,
  type ListTablesCommandOutput,
  type ListTagsOfResourceCommandOutput,
} from '@aws-sdk/client-dynamodb';
import type { CollectContext } from '../sink.js';
import { paginate } from '../util.js';

export async function collectDynamoDb(ctx: CollectContext): Promise<void> {
  const { sink, region } = ctx;
  const names = await paginate(async (start) => {
    const out = await ctx.send<ListTablesCommandOutput>(
      new ListTablesCommand({ ExclusiveStartTableName: start, Limit: 100 }),
    );
    return { items: out.TableNames ?? [], next: out.LastEvaluatedTableName };
  });

  await ctx.map(names, async (name) => {
    const described = await ctx.soft<DescribeTableCommandOutput>(
      `dynamodb:DescribeTable(${name})`,
      () => ctx.send(new DescribeTableCommand({ TableName: name })),
      name,
    );
    const table = described?.Table;
    if (!table?.TableArn) return;
    const [ttl, backups, tags] = await Promise.all([
      ctx.soft<DescribeTimeToLiveCommandOutput>(
        `dynamodb:DescribeTimeToLive(${name})`,
        () => ctx.send(new DescribeTimeToLiveCommand({ TableName: name })),
        name,
      ),
      ctx.soft<DescribeContinuousBackupsCommandOutput>(
        `dynamodb:DescribeContinuousBackups(${name})`,
        () => ctx.send(new DescribeContinuousBackupsCommand({ TableName: name })),
        name,
      ),
      ctx.soft<ListTagsOfResourceCommandOutput>(
        `dynamodb:ListTagsOfResource(${name})`,
        () => ctx.send(new ListTagsOfResourceCommand({ ResourceArn: table.TableArn })),
        name,
      ),
    ]);

    const index = (i: {
      IndexName?: string;
      KeySchema?: { AttributeName?: string; KeyType?: string }[];
      Projection?: { ProjectionType?: string; NonKeyAttributes?: string[] };
      ProvisionedThroughput?: { ReadCapacityUnits?: number; WriteCapacityUnits?: number };
    }) => ({
      indexName: i.IndexName,
      keySchema: (i.KeySchema ?? []).map((k) => ({
        attributeName: k.AttributeName,
        keyType: k.KeyType,
      })),
      projection: {
        projectionType: i.Projection?.ProjectionType,
        nonKeyAttributes: i.Projection?.NonKeyAttributes,
      },
      provisionedThroughput: i.ProvisionedThroughput
        ? {
            readCapacityUnits: i.ProvisionedThroughput.ReadCapacityUnits,
            writeCapacityUnits: i.ProvisionedThroughput.WriteCapacityUnits,
          }
        : undefined,
    });
    const gsis = (table.GlobalSecondaryIndexes ?? []).map(index);
    const lsis = (table.LocalSecondaryIndexes ?? []).map(index);

    sink.addResource({
      type: 'AWS::DynamoDB::Table',
      region,
      physicalId: name,
      arn: table.TableArn,
      operation: 'dynamodb:DescribeTable',
      tags: Object.fromEntries(
        (tags?.Tags ?? []).filter((t) => t.Key).map((t) => [t.Key!, t.Value ?? '']),
      ),
      properties: {
        tableName: name,
        keySchema: (table.KeySchema ?? []).map((k) => ({
          attributeName: k.AttributeName,
          keyType: k.KeyType,
        })),
        attributeDefinitions: (table.AttributeDefinitions ?? []).map((a) => ({
          attributeName: a.AttributeName,
          attributeType: a.AttributeType,
        })),
        billingMode: table.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
        provisionedThroughput:
          (table.BillingModeSummary?.BillingMode ?? 'PROVISIONED') === 'PROVISIONED' &&
          table.ProvisionedThroughput
            ? {
                readCapacityUnits: table.ProvisionedThroughput.ReadCapacityUnits,
                writeCapacityUnits: table.ProvisionedThroughput.WriteCapacityUnits,
              }
            : undefined,
        globalSecondaryIndexes: gsis.length > 0 ? gsis : undefined,
        localSecondaryIndexes: lsis.length > 0 ? lsis : undefined,
        streamSpecification: table.StreamSpecification?.StreamEnabled
          ? { streamEnabled: true, streamViewType: table.StreamSpecification.StreamViewType }
          : undefined,
        latestStreamArn: table.StreamSpecification?.StreamEnabled
          ? table.LatestStreamArn
          : undefined,
        deletionProtectionEnabled: table.DeletionProtectionEnabled,
        pointInTimeRecoveryEnabled:
          backups?.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
            ?.PointInTimeRecoveryStatus === 'ENABLED'
            ? true
            : undefined,
        timeToLive:
          ttl?.TimeToLiveDescription?.TimeToLiveStatus === 'ENABLED'
            ? { attributeName: ttl.TimeToLiveDescription.AttributeName, enabled: true }
            : undefined,
        sseDescription:
          table.SSEDescription?.Status === 'ENABLED'
            ? {
                sseType: table.SSEDescription.SSEType,
                kmsMasterKeyArn: table.SSEDescription.KMSMasterKeyArn,
              }
            : undefined,
        tableClass: table.TableClassSummary?.TableClass,
      },
    });
  });
}
