import { GetCallerIdentityCommand, type GetCallerIdentityCommandOutput } from '@aws-sdk/client-sts';
import {
  computeSnapshotId,
  normalizeRelationships,
  parseSnapshot,
  sanitizeSnapshot,
  type CloudSnapshot,
  type Diagnostic,
} from '@cloud-to-code/core';
import { collectApiGateway } from './collectors/apigateway.js';
import { collectDynamoDb } from './collectors/dynamodb.js';
import { collectEventBridge } from './collectors/eventbridge.js';
import { collectIamRoles } from './collectors/iam.js';
import { collectLambda } from './collectors/lambda.js';
import { collectS3 } from './collectors/s3.js';
import { collectSqs } from './collectors/sqs.js';
import type { ServiceKey } from './guard/allowlist.js';
import type { SenderFactory } from './guard/sender.js';
import { resolvePossibleAccess, resolveSameStack } from './resolvers.js';
import { CollectContext, Sink } from './sink.js';
import { classifyError } from './util.js';

export const SUPPORTED_SERVICES = [
  'lambda',
  'apigatewayv2',
  'dynamodb',
  'sqs',
  'eventbridge',
  's3',
  'iam',
] as const;
export type DiscoverService = (typeof SUPPORTED_SERVICES)[number];

export interface DiscoverScope {
  /** Accounts discovery may read. The caller's account must be listed explicitly. */
  accountIds: string[];
  regions: string[];
  services: string[];
}

export interface DiscoverOptions {
  scope: DiscoverScope;
  senderFor: SenderFactory;
  now?: Date;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface DiscoveryResult {
  snapshot: CloudSnapshot;
  caller: { accountId: string; arn: string };
  redactions: number;
}

export class ScopeError extends Error {
  constructor(
    readonly code: 'invalid-scope' | 'account-not-in-scope' | 'credentials-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ScopeError';
  }
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

export function validateScope(scope: DiscoverScope): {
  regions: string[];
  services: DiscoverService[];
  accountIds: string[];
} {
  if (scope.accountIds.length === 0)
    throw new ScopeError('invalid-scope', 'Scope needs at least one account ID.');
  for (const a of scope.accountIds)
    if (!/^\d{12}$/.test(a)) throw new ScopeError('invalid-scope', `Invalid account ID "${a}".`);
  if (scope.regions.length === 0)
    throw new ScopeError(
      'invalid-scope',
      'Scope needs at least one region; there is no implicit account-wide crawl.',
    );
  for (const r of scope.regions)
    if (!REGION.test(r)) throw new ScopeError('invalid-scope', `Invalid region "${r}".`);
  if (scope.services.length === 0)
    throw new ScopeError(
      'invalid-scope',
      `Scope needs at least one service. Supported: ${SUPPORTED_SERVICES.join(', ')}.`,
    );
  const unknown = scope.services.filter(
    (s) => !(SUPPORTED_SERVICES as readonly string[]).includes(s),
  );
  if (unknown.length > 0)
    throw new ScopeError(
      'invalid-scope',
      `Unsupported service(s): ${unknown.join(', ')}. Supported: ${SUPPORTED_SERVICES.join(', ')}.`,
    );
  return {
    accountIds: [...new Set(scope.accountIds)].sort(),
    regions: [...new Set(scope.regions)].sort(),
    services: [...new Set(scope.services)].sort() as DiscoverService[],
  };
}

/**
 * Read-only, scoped discovery. Account, regions and services must be explicit. The caller's identity is verified
 * with STS before anything is read, and must match the declared scope. Failures of one service or region become
 * diagnostics; the result is a partial but honest snapshot.
 */
export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const scope = validateScope(options.scope);
  const now = options.now ?? new Date();
  const progress = options.onProgress ?? (() => undefined);

  let identity: GetCallerIdentityCommandOutput;
  try {
    identity = await options
      .senderFor('sts', scope.regions[0]!)
      .send<GetCallerIdentityCommandOutput>(
        new GetCallerIdentityCommand({}),
        options.signal ? { abortSignal: options.signal } : undefined,
      );
  } catch (error) {
    if (classifyError(error) === 'aborted') throw error;
    throw new ScopeError(
      'credentials-unavailable',
      `Could not verify AWS credentials with STS GetCallerIdentity: ${(error as Error).message}`,
    );
  }
  const accountId = identity.Account ?? '';
  if (!scope.accountIds.includes(accountId)) {
    throw new ScopeError(
      'account-not-in-scope',
      `The credentials belong to account ${accountId}, which is not in the declared scope (${scope.accountIds.join(', ')}). Nothing was read.`,
    );
  }
  progress(`Verified identity ${identity.Arn ?? accountId} (account ${accountId})`);

  const sink = new Sink(accountId, now);
  const ctxFor = (service: ServiceKey, region: string): CollectContext =>
    new CollectContext(sink, service, region, options.senderFor(service, region), options.signal);

  const run = async (
    service: ServiceKey,
    region: string,
    fn: (ctx: CollectContext) => Promise<void>,
  ): Promise<void> => {
    progress(`Reading ${service} in ${region}`);
    const ctx = ctxFor(service, region);
    try {
      await fn(ctx);
    } catch (error) {
      ctx.handle(error, `${service} discovery in ${region}`);
    }
  };

  for (const region of scope.regions) {
    const tasks: Promise<void>[] = [];
    if (scope.services.includes('lambda')) tasks.push(run('lambda', region, collectLambda));
    if (scope.services.includes('apigatewayv2'))
      tasks.push(run('apigatewayv2', region, collectApiGateway));
    if (scope.services.includes('dynamodb')) tasks.push(run('dynamodb', region, collectDynamoDb));
    if (scope.services.includes('sqs')) tasks.push(run('sqs', region, collectSqs));
    if (scope.services.includes('eventbridge'))
      tasks.push(run('eventbridge', region, collectEventBridge));
    await Promise.all(tasks);
  }
  if (scope.services.includes('s3')) {
    await run('s3', scope.regions[0]!, (ctx) =>
      collectS3(ctx, { regions: scope.regions }, (region) => ctxFor('s3', region)),
    );
  }
  if (scope.services.includes('iam')) {
    const roleArns = [...sink.resources.values()]
      .filter((r) => r.type === 'AWS::Lambda::Function')
      .map((r) => r.observedProperties['roleArn'])
      .filter((v): v is string => typeof v === 'string');
    await run('iam', scope.regions[0]!, (ctx) => collectIamRoles(ctx, roleArns));
  }

  resolvePossibleAccess(sink);
  resolveSameStack(sink);

  const diagnostics: Diagnostic[] = [...sink.diagnostics].sort((a, b) =>
    `${a.code}|${a.resourceId ?? ''}|${a.message}`.localeCompare(
      `${b.code}|${b.resourceId ?? ''}|${b.message}`,
    ),
  );
  const draft: CloudSnapshot = {
    schemaVersion: '1',
    id: '',
    collectedAt: now.toISOString(),
    scope: { accountIds: [accountId], regions: scope.regions, services: scope.services },
    resources: [...sink.resources.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: normalizeRelationships(sink.relationships),
    evidence: [...sink.evidence.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
  };
  draft.id = computeSnapshotId(draft);
  const sanitized = sanitizeSnapshot(draft);
  const { snapshot } = parseSnapshot(JSON.parse(JSON.stringify(sanitized.snapshot)));
  return {
    snapshot,
    caller: { accountId, arn: identity.Arn ?? '' },
    redactions: sanitized.redactions,
  };
}
