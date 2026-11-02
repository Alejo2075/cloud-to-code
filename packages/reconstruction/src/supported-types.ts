/**
 * Resource types the CDK generator can map. The planner excludes anything else with an explicit
 * `unsupported-resource-type` unresolved entry, so unsupported resources are never silently dropped.
 */
export const SUPPORTED_GENERATION_TYPES: ReadonlySet<string> = new Set([
  'AWS::ApiGatewayV2::Api',
  'AWS::Lambda::Function',
  'AWS::IAM::Role',
  'AWS::DynamoDB::Table',
  'AWS::SQS::Queue',
  'AWS::Events::EventBus',
  'AWS::Events::Rule',
  'AWS::S3::Bucket',
]);

/** Types that hold data; ownership of these is always a human decision. */
export const STATEFUL_TYPES: ReadonlySet<string> = new Set([
  'AWS::DynamoDB::Table',
  'AWS::SQS::Queue',
  'AWS::S3::Bucket',
]);

export type ConstructGroup = 'api' | 'compute' | 'data' | 'messaging';

export const GROUP_BY_TYPE: Readonly<Record<string, ConstructGroup>> = {
  'AWS::ApiGatewayV2::Api': 'api',
  'AWS::Lambda::Function': 'compute',
  'AWS::IAM::Role': 'compute',
  'AWS::DynamoDB::Table': 'data',
  'AWS::S3::Bucket': 'data',
  'AWS::SQS::Queue': 'messaging',
  'AWS::Events::EventBus': 'messaging',
  'AWS::Events::Rule': 'messaging',
};
