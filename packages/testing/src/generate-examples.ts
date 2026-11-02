import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServerlessOrdersSnapshot } from './serverless-orders.js';

/** Serialized form committed under examples/ so users can inspect the fixture without running code. */
export function serializeSnapshot(): string {
  return `${JSON.stringify(buildServerlessOrdersSnapshot(), null, 2)}\n`;
}

export function exampleSnapshotPath(repoRoot: string): string {
  return join(repoRoot, 'examples', 'serverless-orders', 'snapshot.json');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const target = exampleSnapshotPath(repoRoot);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeSnapshot());
  process.stdout.write(`wrote ${target}\n`);
}
