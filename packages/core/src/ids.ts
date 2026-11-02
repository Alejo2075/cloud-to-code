/** Region value used for services without a region (IAM, S3 bucket listing, ...). */
export const GLOBAL_REGION = 'global';

export interface ResourceIdParts {
  accountId: string;
  region: string;
  type: string;
  physicalId: string;
}

/** Stable resource ID: `account/region/type/physicalId`. */
export function buildResourceId(parts: ResourceIdParts): string {
  const { accountId, region, type, physicalId } = parts;
  if (!/^\d{12}$/.test(accountId)) throw new Error(`Invalid account ID: ${accountId}`);
  if (!region) throw new Error('Region is required (use GLOBAL_REGION for global resources)');
  if (!/^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(type)) {
    throw new Error(`Invalid resource type: ${type}`);
  }
  if (!physicalId || physicalId.includes('\n')) throw new Error('Invalid physical ID');
  return `${accountId}/${region}/${type}/${physicalId}`;
}

export function parseResourceId(id: string): ResourceIdParts | undefined {
  const m = /^(\d{12})\/([^/]+)\/([A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+)\/(.+)$/.exec(id);
  if (!m) return undefined;
  return { accountId: m[1]!, region: m[2]!, type: m[3]!, physicalId: m[4]! };
}

export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  accountId: string;
  resource: string;
}

export function parseArn(arn: string): ParsedArn | undefined {
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return undefined;
  const [, partition, service, region, accountId] = parts;
  if (!partition || !service) return undefined;
  return {
    partition,
    service,
    region: region ?? '',
    accountId: accountId ?? '',
    resource: parts.slice(5).join(':'),
  };
}

/**
 * Canonical ARN form used to join resources:
 * - Lambda version/alias qualifiers are removed (`...:function:name:live` -> `...:function:name`).
 * - Trailing slashes are removed.
 * Returns the input unchanged when it is not an ARN.
 */
export function normalizeArn(arn: string): string {
  const parsed = parseArn(arn);
  if (!parsed) return arn;
  let resource = parsed.resource.replace(/\/+$/, '');
  if (parsed.service === 'lambda' && resource.startsWith('function:')) {
    const segments = resource.split(':');
    resource = segments.slice(0, 2).join(':');
  }
  return `arn:${parsed.partition}:${parsed.service}:${parsed.region}:${parsed.accountId}:${resource}`;
}
