#!/usr/bin/env node
// Regenerates examples/serverless-orders from the built packages (run `pnpm build` first).
//   node scripts/example-project.mjs          write the files
// The example tests import buildExample() and compare it with the committed files.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateForSession } from '../packages/generator-cdk/dist/index.js';
import { ReconstructionService, WorkspaceStore } from '../packages/reconstruction/dist/index.js';
import { buildServerlessOrdersSnapshot } from '../packages/testing/dist/index.js';

export const EXAMPLE_ANSWERS = {
  'q-shared-shared-events': 'reference',
  'q-lambda-source-orders-api': 'infra-only',
  'q-stateful-orders-api': 'recreate-retain',
  'q-possible-access-orders-handler-orders-table': 'document-as-possible',
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const exampleDir = join(root, 'examples', 'serverless-orders');

/** Deterministic: fixed clock and session IDs, so the committed expected output is reproducible byte for byte. */
export async function buildExample() {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-example-'));
  try {
    let n = 0;
    const service = new ReconstructionService(new WorkspaceStore(dir), {
      clock: { now: () => new Date('2026-01-20T09:00:00Z') },
      newId: () => `example${++n}`,
    });
    const snapshot = buildServerlessOrdersSnapshot();
    const session = service.startSession(snapshot, { applicationId: 'orders-api' });
    service.submit(
      session.id,
      Object.entries(EXAMPLE_ANSWERS).map(([questionId, optionId]) => ({
        questionId,
        answer: { kind: 'choice', optionId },
      })),
      'answers-file',
    );
    const result = await generateForSession({
      service,
      sessionId: session.id,
      output: join(dir, 'out'),
    });
    if (!result.ok) throw new Error(`Example generation failed: ${JSON.stringify(result.issues)}`);
    return {
      snapshot: `${JSON.stringify(snapshot, null, 2)}\n`,
      answers: `${JSON.stringify(EXAMPLE_ANSWERS, null, 2)}\n`,
      files: result.project.files,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = await buildExample();
  mkdirSync(exampleDir, { recursive: true });
  writeFileSync(join(exampleDir, 'snapshot.json'), built.snapshot);
  writeFileSync(join(exampleDir, 'answers.json'), built.answers);
  const expected = join(exampleDir, 'expected', 'orders-api');
  rmSync(expected, { recursive: true, force: true });
  for (const file of built.files) {
    const target = join(expected, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  console.log(`wrote ${exampleDir}`);
}
