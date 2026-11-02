import { GLOBAL_REGION, buildResourceId, normalizeArn, parseArn } from '@cloud-to-code/core';

export interface ArnResource {
  id: string;
  type: string;
  physicalId: string;
}

/** Resource ID for an ARN of a supported type, or undefined. Used for relationship endpoints. */
export function resourceFromArn(rawArn: string, defaultAccount: string): ArnResource | undefined {
  const arn = normalizeArn(rawArn);
  const p = parseArn(arn);
  if (!p) return undefined;
  const make = (
    type: string,
    physicalId: string,
    region: string,
    account = p.accountId,
  ): ArnResource | undefined => {
    if (!/^\d{12}$/.test(account) || !physicalId) return undefined;
    return {
      id: buildResourceId({ accountId: account, region, type, physicalId }),
      type,
      physicalId,
    };
  };
  switch (p.service) {
    case 'lambda': {
      const m = /^function:([^:]+)$/.exec(p.resource);
      return m ? make('AWS::Lambda::Function', m[1]!, p.region) : undefined;
    }
    case 'dynamodb': {
      const m = /^table\/([^/]+)/.exec(p.resource);
      return m ? make('AWS::DynamoDB::Table', m[1]!, p.region) : undefined;
    }
    case 'sqs':
      return make('AWS::SQS::Queue', p.resource, p.region);
    case 'events': {
      const bus = /^event-bus\/(.+)$/.exec(p.resource);
      if (bus) return make('AWS::Events::EventBus', bus[1]!, p.region);
      const rule = /^rule\/(?:([^/]+)\/)?([^/]+)$/.exec(p.resource);
      if (rule) return make('AWS::Events::Rule', `${rule[1] ?? 'default'}/${rule[2]}`, p.region);
      return undefined;
    }
    case 's3': {
      const bucket = p.resource.split('/')[0];
      return bucket && !p.accountId
        ? make('AWS::S3::Bucket', bucket, GLOBAL_REGION, defaultAccount)
        : undefined;
    }
    case 'iam': {
      const m = /^role\/(?:.+\/)?([^/]+)$/.exec(p.resource);
      return m ? make('AWS::IAM::Role', m[1]!, GLOBAL_REGION) : undefined;
    }
    default:
      return undefined;
  }
}

/** Lambda function ARN embedded in an API Gateway integration URI, or the ARN itself. */
export function lambdaArnFromIntegrationUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const m =
    /(arn:[a-z-]+:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+(?::[A-Za-z0-9_$-]+)?)/.exec(uri);
  return m ? normalizeArn(m[1]!) : undefined;
}
