/**
 * The ONLY AWS SDK commands Cloud to Code may send. Every entry is a read-only List/Get/Describe call that
 * returns metadata. Deliberately absent: anything that reads data or code (GetObject, ListObjects, Scan, Query,
 * GetItem, ReceiveMessage, GetFunction which returns a code download URL, GetSecretValue, Invoke), anything that
 * mutates, and account-wide crawls (ListRoles). Changing this list needs a second reviewer (CODEOWNERS).
 */
export type ServiceKey =
  'sts' | 'lambda' | 'apigatewayv2' | 'dynamodb' | 'sqs' | 'eventbridge' | 's3' | 'iam';

export const ALLOWED_COMMANDS: Readonly<Record<ServiceKey, readonly string[]>> = {
  sts: ['GetCallerIdentityCommand'],
  lambda: ['ListFunctionsCommand', 'ListEventSourceMappingsCommand', 'ListTagsCommand'],
  apigatewayv2: [
    'GetApisCommand',
    'GetRoutesCommand',
    'GetIntegrationsCommand',
    'GetStagesCommand',
  ],
  dynamodb: [
    'ListTablesCommand',
    'DescribeTableCommand',
    'DescribeTimeToLiveCommand',
    'DescribeContinuousBackupsCommand',
    'ListTagsOfResourceCommand',
  ],
  sqs: ['ListQueuesCommand', 'GetQueueAttributesCommand', 'ListQueueTagsCommand'],
  eventbridge: [
    'ListEventBusesCommand',
    'ListRulesCommand',
    'ListTargetsByRuleCommand',
    'ListTagsForResourceCommand',
  ],
  s3: [
    'ListBucketsCommand',
    'GetBucketLocationCommand',
    'GetBucketVersioningCommand',
    'GetBucketEncryptionCommand',
    'GetPublicAccessBlockCommand',
    'GetBucketNotificationConfigurationCommand',
    'GetBucketTaggingCommand',
  ],
  iam: [
    'GetRoleCommand',
    'ListRolePoliciesCommand',
    'GetRolePolicyCommand',
    'ListAttachedRolePoliciesCommand',
    'ListRoleTagsCommand',
  ],
};

/** Commands that must never be reachable even if someone adds them to the list by mistake. */
export const NEVER_ALLOWED: readonly string[] = [
  'GetObjectCommand',
  'ListObjectsCommand',
  'ListObjectsV2Command',
  'ScanCommand',
  'QueryCommand',
  'GetItemCommand',
  'BatchGetItemCommand',
  'ReceiveMessageCommand',
  'GetFunctionCommand',
  'InvokeCommand',
  'GetSecretValueCommand',
  'GetParameterCommand',
  'ListRolesCommand',
];

const READ_ONLY_PREFIX = /^(Get|List|Describe)[A-Z]/;

export class ForbiddenAwsOperationError extends Error {
  constructor(
    readonly service: string,
    readonly command: string,
  ) {
    super(`Refusing to send ${command} to ${service}: not in the read-only allowlist.`);
    this.name = 'ForbiddenAwsOperationError';
  }
}

export function isAllowed(service: ServiceKey, command: string): boolean {
  return (
    (ALLOWED_COMMANDS[service] ?? []).includes(command) &&
    READ_ONLY_PREFIX.test(command) &&
    !NEVER_ALLOWED.includes(command)
  );
}
