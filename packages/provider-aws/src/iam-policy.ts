import { ALLOWED_COMMANDS } from './guard/allowlist.js';

/** IAM action that authorizes each allowlisted SDK command. STS GetCallerIdentity needs no permission. */
export const IAM_ACTION_FOR_COMMAND: Readonly<Record<string, string | null>> = {
  GetCallerIdentityCommand: null,
  ListFunctionsCommand: 'lambda:ListFunctions',
  ListEventSourceMappingsCommand: 'lambda:ListEventSourceMappings',
  ListTagsCommand: 'lambda:ListTags',
  GetApisCommand: 'apigateway:GET',
  GetRoutesCommand: 'apigateway:GET',
  GetIntegrationsCommand: 'apigateway:GET',
  GetStagesCommand: 'apigateway:GET',
  ListTablesCommand: 'dynamodb:ListTables',
  DescribeTableCommand: 'dynamodb:DescribeTable',
  DescribeTimeToLiveCommand: 'dynamodb:DescribeTimeToLive',
  DescribeContinuousBackupsCommand: 'dynamodb:DescribeContinuousBackups',
  ListTagsOfResourceCommand: 'dynamodb:ListTagsOfResource',
  ListQueuesCommand: 'sqs:ListQueues',
  GetQueueAttributesCommand: 'sqs:GetQueueAttributes',
  ListQueueTagsCommand: 'sqs:ListQueueTags',
  ListEventBusesCommand: 'events:ListEventBuses',
  ListRulesCommand: 'events:ListRules',
  ListTargetsByRuleCommand: 'events:ListTargetsByRule',
  ListTagsForResourceCommand: 'events:ListTagsForResource',
  ListBucketsCommand: 's3:ListAllMyBuckets',
  GetBucketLocationCommand: 's3:GetBucketLocation',
  GetBucketVersioningCommand: 's3:GetBucketVersioning',
  GetBucketEncryptionCommand: 's3:GetEncryptionConfiguration',
  GetPublicAccessBlockCommand: 's3:GetBucketPublicAccessBlock',
  GetBucketNotificationConfigurationCommand: 's3:GetBucketNotification',
  GetBucketTaggingCommand: 's3:GetBucketTagging',
  GetRoleCommand: 'iam:GetRole',
  ListRolePoliciesCommand: 'iam:ListRolePolicies',
  GetRolePolicyCommand: 'iam:GetRolePolicy',
  ListAttachedRolePoliciesCommand: 'iam:ListAttachedRolePolicies',
  ListRoleTagsCommand: 'iam:ListRoleTags',
};

/**
 * Least-privilege read-only IAM policy for the services in scope. Derived from the allowlist, so the documented
 * policy cannot drift from what the tool can actually call. Review it; scope `Resource` down where you can.
 */
export function leastPrivilegePolicy(services?: readonly string[]): {
  Version: string;
  Statement: { Sid: string; Effect: 'Allow'; Action: string[]; Resource: string }[];
} {
  const wanted = services ? new Set(services) : undefined;
  const actions = new Set<string>();
  for (const [service, commands] of Object.entries(ALLOWED_COMMANDS)) {
    if (wanted && service !== 'sts' && !wanted.has(service)) continue;
    for (const c of commands) {
      const action = IAM_ACTION_FOR_COMMAND[c];
      if (action) actions.add(action);
    }
  }
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'CloudToCodeReadOnlyDiscovery',
        Effect: 'Allow',
        Action: [...actions].sort(),
        Resource: '*',
      },
    ],
  };
}
