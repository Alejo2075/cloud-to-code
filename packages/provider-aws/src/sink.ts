import {
  sanitizeTags,
  sanitizeValue,
  buildResourceId,
  type CloudResource,
  type Diagnostic,
  type Evidence,
  type Relationship,
  type RelationshipKind,
} from '@cloud-to-code/core';
import { resourceFromArn } from './arn.js';
import type { Sender } from './guard/sender.js';
import { classifyError, errorMessage, evidenceId, mapLimit } from './util.js';

export const CONCURRENCY = 5;
export const CALL_TIMEOUT_MS = 30_000;

/** Collects what one collector observed. Everything added is sanitized immediately. */
export class Sink {
  readonly resources = new Map<string, CloudResource>();
  readonly relationships: Relationship[] = [];
  readonly evidence = new Map<string, Evidence>();
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    readonly accountId: string,
    private readonly now: Date,
  ) {}

  evidenceFor(source: string, detail: string): string {
    const id = evidenceId(source, detail);
    if (!this.evidence.has(id)) {
      this.evidence.set(id, {
        id,
        kind: 'aws-observed',
        source,
        collectedAt: this.now.toISOString(),
        detail: String(sanitizeValue(detail)).slice(0, 300),
      });
    }
    return id;
  }

  addResource(params: {
    type: string;
    region: string;
    physicalId: string;
    displayName?: string;
    arn?: string;
    properties: Record<string, unknown>;
    tags?: Record<string, string> | undefined;
    operation: string;
  }): CloudResource {
    const id = buildResourceId({
      accountId: this.accountId,
      region: params.region,
      type: params.type,
      physicalId: params.physicalId,
    });
    const resource: CloudResource = {
      id,
      type: params.type,
      accountId: this.accountId,
      region: params.region,
      physicalId: params.physicalId,
      ...(params.arn ? { arn: params.arn } : {}),
      displayName:
        String(sanitizeValue(params.displayName ?? params.physicalId)).slice(0, 256) ||
        params.physicalId,
      observedProperties: sanitizeValue(dropUndefined(params.properties)) as Record<
        string,
        unknown
      >,
      tags: sanitizeTags(params.tags),
      evidenceIds: [this.evidenceFor(params.operation, params.physicalId)],
      diagnostics: [],
    };
    this.resources.set(id, resource);
    return resource;
  }

  relate(
    from: string,
    to: string,
    kind: RelationshipKind,
    confidence: Relationship['confidence'],
    source: string,
    detail: string,
  ): void {
    this.relationships.push({
      from,
      to,
      kind,
      confidence,
      evidenceIds: [this.evidenceFor(source, detail)],
    });
  }

  /** Relate to an ARN when it maps to a supported resource type; otherwise note it. */
  relateToArn(
    from: string,
    arn: string | undefined,
    kind: RelationshipKind,
    confidence: Relationship['confidence'],
    source: string,
    detail: string,
  ): boolean {
    if (!arn) return false;
    const target = resourceFromArn(arn, this.accountId);
    if (!target) {
      this.diag({
        code: 'unsupported-target',
        severity: 'info',
        message: `${kind} target ${arn} is of an unsupported type and was not linked.`,
        resourceId: from,
      });
      return false;
    }
    this.relate(from, target.id, kind, confidence, source, detail);
    return true;
  }

  diag(d: Diagnostic): void {
    this.diagnostics.push(d);
  }
}

/** Per-collector context: bounded concurrency, per-call timeout, cancellation and soft failure. */
export class CollectContext {
  constructor(
    readonly sink: Sink,
    readonly service: string,
    readonly region: string,
    readonly sender: Sender,
    readonly signal: AbortSignal | undefined,
  ) {}

  get accountId(): string {
    return this.sink.accountId;
  }

  send<T>(command: object): Promise<T> {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const abortSignal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    return this.sender.send<T>(command, { abortSignal });
  }

  map<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    return mapLimit(items, CONCURRENCY, fn);
  }

  /**
   * Run an optional sub-call (tags, backups...). Access denial, throttling and not-found become diagnostics so
   * one missing permission never aborts discovery; cancellation is always re-thrown.
   */
  async soft<T>(what: string, fn: () => Promise<T>, resourceId?: string): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.handle(error, what, resourceId);
      return undefined;
    }
  }

  handle(error: unknown, what: string, resourceId?: string): void {
    const kind = classifyError(error);
    if (kind === 'aborted' || this.signal?.aborted) throw error;
    const base = {
      service: this.service,
      region: this.region,
      ...(resourceId ? { resourceId } : {}),
    };
    if (kind === 'not-found') return;
    if (kind === 'access-denied') {
      this.sink.diag({
        ...base,
        code: 'access-denied',
        severity: 'warning',
        message: `Access denied for ${what}. Data from this call is missing; absence of evidence is not evidence of absence.`,
        remediation: 'Grant the read-only permissions listed in docs/security.md for this service.',
      });
    } else if (kind === 'throttled') {
      this.sink.diag({
        ...base,
        code: 'throttled',
        severity: 'warning',
        message: `${what} was throttled even after retries; results may be incomplete.`,
      });
    } else {
      this.sink.diag({
        ...base,
        code: 'collector-error',
        severity: 'error',
        message: `${what} failed: ${errorMessage(error)}`,
      });
    }
  }
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
