import {
  EvidenceGraph,
  sanitizeValue,
  shortHash,
  wrapUntrusted,
  type CloudSnapshot,
} from '@cloud-to-code/core';

export interface ModelContext {
  /** The exact text that would be sent to a model. */
  text: string;
  /** Digest of `text`; consent is bound to it, so changed data needs fresh consent. */
  hash: string;
  bytes: number;
  included: string[];
  excluded: string[];
  resourceCount: number;
}

/** Properties whose contents are policy documents or similar: replaced by a count, never sent. */
const REDUCED = new Set(['inlinePolicies', 'assumeRolePolicy']);

export const CONTEXT_INCLUDED = [
  'resource types, IDs, display names (marked untrusted)',
  'selected configuration (runtime, memory, timeouts, key schemas, billing modes, routes...)',
  'relationships between resources with their confidence level',
  'tags (marked untrusted)',
];

export const CONTEXT_EXCLUDED = [
  'IAM policy and trust documents (only counts are sent)',
  'Lambda environment values and code',
  'secrets, credentials, data, S3 objects, DynamoDB items',
];

/**
 * The minimized, sanitized description of a snapshot that may be shown to a model. AWS-derived text is wrapped as
 * untrusted data. Nothing is sent from here: callers show this as a preview and obtain consent first.
 */
export function buildModelContext(
  snapshot: CloudSnapshot,
  resourceIds?: readonly string[],
): ModelContext {
  const graph = new EvidenceGraph(snapshot);
  const selected = resourceIds ? new Set(resourceIds) : undefined;
  const resources = [...graph.resources.values()].filter((r) => !selected || selected.has(r.id));
  const ids = new Set(resources.map((r) => r.id));

  const body = {
    resources: resources.map((r) => {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r.observedProperties)) {
        props[k] = REDUCED.has(k) ? `[${Array.isArray(v) ? v.length : 1} item(s) omitted]` : v;
      }
      return {
        id: r.id,
        type: r.type,
        name: wrapUntrusted('name', r.displayName),
        properties: sanitizeValue(props),
        tags: Object.fromEntries(
          Object.entries(r.tags).map(([k, v]) => [k, wrapUntrusted(`tag:${k}`, v)]),
        ),
      };
    }),
    relationships: graph.relationships
      .filter((r) => ids.has(r.from) && ids.has(r.to))
      .map((r) => ({ from: r.from, to: r.to, kind: r.kind, confidence: r.confidence })),
  };
  const text = JSON.stringify(body, null, 1);
  return {
    text,
    hash: shortHash(text, 16),
    bytes: Buffer.byteLength(text),
    included: CONTEXT_INCLUDED,
    excluded: CONTEXT_EXCLUDED,
    resourceCount: resources.length,
  };
}
