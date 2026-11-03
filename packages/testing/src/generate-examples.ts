import { join } from 'node:path';
import { buildServerlessOrdersSnapshot } from './serverless-orders.js';

/** Serialized form committed under examples/ so users can inspect the fixture without running code. */
export function serializeSnapshot(): string {
  return `${JSON.stringify(buildServerlessOrdersSnapshot(), null, 2)}\n`;
}

export function exampleSnapshotPath(repoRoot: string): string {
  return join(repoRoot, 'examples', 'serverless-orders', 'snapshot.json');
}
