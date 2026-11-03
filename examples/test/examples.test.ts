import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const built = existsSync(join(root, 'packages', 'generator-cdk', 'dist', 'index.js'));

// Needs the built packages (`pnpm build`); CI always builds before testing.
describe.skipIf(!built)('examples/serverless-orders', () => {
  it('the committed snapshot, answers and expected CDK project are exactly what the tools generate today', async () => {
    const { buildExample, exampleDir } = (await import(
      join(root, 'scripts', 'example-project.mjs')
    )) as {
      buildExample(): Promise<{
        snapshot: string;
        answers: string;
        files: { path: string; content: string }[];
      }>;
      exampleDir: string;
    };
    const generated = await buildExample();
    expect(readFileSync(join(exampleDir, 'snapshot.json'), 'utf8')).toBe(generated.snapshot);
    expect(readFileSync(join(exampleDir, 'answers.json'), 'utf8')).toBe(generated.answers);
    const expectedRoot = join(exampleDir, 'expected', 'orders-api');
    const onDisk = readdirSync(expectedRoot, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(expectedRoot, join(e.parentPath, e.name)))
      .sort();
    expect(onDisk).toEqual(generated.files.map((f) => f.path).sort());
    for (const f of generated.files)
      expect(readFileSync(join(expectedRoot, f.path), 'utf8'), f.path).toBe(f.content);
  }, 60_000);
});
