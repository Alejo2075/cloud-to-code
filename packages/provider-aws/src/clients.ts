import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { IAMClient } from '@aws-sdk/client-iam';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import type { ServiceKey } from './guard/allowlist.js';
import { guardSender, type RawSender, type Sender, type SenderFactory } from './guard/sender.js';

export interface AwsConnection {
  /** Named profile (SSO / shared config). Omit to use the default credential provider chain. */
  profile?: string;
  /** Optional role to assume on top of the base credentials. */
  roleArn?: string;
}

/**
 * Real SDK clients with the default credential provider chain (env, profiles, IAM Identity Center...). No keys are
 * ever requested or stored by this tool. Every client is wrapped by the read-only allowlist guard.
 */
export function createSenderFactory(connection: AwsConnection = {}): SenderFactory {
  const base = fromNodeProviderChain(connection.profile ? { profile: connection.profile } : {});
  const credentials = connection.roleArn
    ? fromTemporaryCredentials({
        masterCredentials: base,
        params: {
          RoleArn: connection.roleArn,
          RoleSessionName: 'cloud-to-code',
          DurationSeconds: 3600,
        },
      })
    : base;
  const cache = new Map<string, Sender>();

  return (service: ServiceKey, region: string): Sender => {
    const key = `${service}|${region}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const config = { region, credentials, maxAttempts: 5, retryMode: 'adaptive' as const };
    const clients: Record<ServiceKey, () => RawSender> = {
      sts: () => new STSClient(config),
      lambda: () => new LambdaClient(config),
      apigatewayv2: () => new ApiGatewayV2Client(config),
      dynamodb: () => new DynamoDBClient(config),
      sqs: () => new SQSClient(config),
      eventbridge: () => new EventBridgeClient(config),
      s3: () => new S3Client(config),
      iam: () => new IAMClient(config),
    };
    const sender = guardSender(service, clients[service]());
    cache.set(key, sender);
    return sender;
  };
}
