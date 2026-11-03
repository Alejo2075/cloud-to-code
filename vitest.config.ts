import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Resolve every workspace package to its TypeScript sources so tests do not require a prior build.
const alias: Record<string, string> = {};
for (const dir of ['packages', 'apps']) {
  const base = join(root, dir);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const entry = join(base, name, 'src', 'index.ts');
    if (existsSync(entry)) alias[`@cloud-to-code/${name}`] = entry;
  }
}

export default defineConfig({
  resolve: { alias },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'plugins/**/test/**/*.test.ts',
      'examples/**/test/**/*.test.ts',
    ],
    // The expected output of the example is a generated project with its own tests; never run it here.
    exclude: [...configDefaults.exclude, 'examples/**/expected/**', '**/.tmp/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
