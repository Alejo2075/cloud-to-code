export type Namespace =
  | 'cdk'
  | 'dynamodb'
  | 's3'
  | 'sqs'
  | 'events'
  | 'iam'
  | 'lambda'
  | 'kms'
  | 'apigwv2'
  | 'integrations'
  | 'targets'
  | 'eventsources'
  | 's3n';

export const NAMESPACE_MODULES: Record<Namespace, string> = {
  cdk: 'aws-cdk-lib',
  dynamodb: 'aws-cdk-lib/aws-dynamodb',
  s3: 'aws-cdk-lib/aws-s3',
  sqs: 'aws-cdk-lib/aws-sqs',
  events: 'aws-cdk-lib/aws-events',
  iam: 'aws-cdk-lib/aws-iam',
  lambda: 'aws-cdk-lib/aws-lambda',
  kms: 'aws-cdk-lib/aws-kms',
  apigwv2: 'aws-cdk-lib/aws-apigatewayv2',
  integrations: 'aws-cdk-lib/aws-apigatewayv2-integrations',
  targets: 'aws-cdk-lib/aws-events-targets',
  eventsources: 'aws-cdk-lib/aws-lambda-event-sources',
  s3n: 'aws-cdk-lib/aws-s3-notifications',
};

/** Line buffer for one generated construct body, tracking which CDK namespaces it needs. */
export class Out {
  private readonly buffer: string[] = [];
  readonly namespaces = new Set<Namespace>();

  use(ns: Namespace): string {
    this.namespaces.add(ns);
    return ns;
  }

  line(text = ''): void {
    this.buffer.push(text);
  }

  lines(text: string): void {
    for (const l of text.split('\n')) this.buffer.push(l);
  }

  toString(): string {
    return this.buffer.join('\n');
  }

  get length(): number {
    return this.buffer.length;
  }
}
