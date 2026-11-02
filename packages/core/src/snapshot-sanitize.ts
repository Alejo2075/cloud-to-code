import { redactSecrets, sanitizeTags, sanitizeValue, type SanitizeStats } from './sanitize.js';
import { computeSnapshotId } from './snapshot-integrity.js';
import type { CloudSnapshot } from './schemas/snapshot.js';

export interface SanitizedSnapshot {
  snapshot: CloudSnapshot;
  redactions: number;
}

/**
 * Sanitize a whole snapshot before it is persisted, sent to a model or returned over MCP. Display names,
 * observed properties, tags and evidence details are redacted; when anything changed the content-based
 * snapshot ID is recomputed and an info diagnostic records that redaction happened.
 */
export function sanitizeSnapshot(input: CloudSnapshot): SanitizedSnapshot {
  const stats: SanitizeStats = { redactions: 0 };
  const text = (value: string): string => {
    const r = redactSecrets(value);
    stats.redactions += r.redactions;
    return r.text.length > 256 ? `${r.text.slice(0, 256)}…` : r.text;
  };
  const resources = input.resources.map((r) => ({
    ...r,
    displayName: text(r.displayName),
    observedProperties: sanitizeValue(r.observedProperties, stats) as Record<string, unknown>,
    tags: sanitizeTags(r.tags),
  }));
  const evidence = input.evidence.map((e) =>
    e.detail === undefined ? e : { ...e, detail: text(e.detail) },
  );
  const tagChanges = input.resources.reduce(
    (n, r, i) => n + Object.entries(r.tags).filter(([k, v]) => resources[i]!.tags[k] !== v).length,
    0,
  );
  const redactions = stats.redactions + tagChanges;
  if (redactions === 0) return { snapshot: input, redactions: 0 };
  const sanitized: CloudSnapshot = {
    ...input,
    resources,
    evidence,
    diagnostics: [
      ...input.diagnostics,
      {
        code: 'sanitized-input',
        severity: 'info',
        message: `${redactions} secret-like value(s) were redacted before the snapshot was stored.`,
      },
    ],
  };
  sanitized.id = computeSnapshotId(sanitized);
  return { snapshot: sanitized, redactions };
}
