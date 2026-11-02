import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const forbiddenInCore = [
  { group: ['@aws-sdk/*', '@smithy/*'], message: 'core must not import the AWS SDK.' },
  { group: ['@modelcontextprotocol/*'], message: 'core must not import the MCP SDK.' },
  {
    group: ['@anthropic-ai/*', 'openai', 'ai', '@ai-sdk/*'],
    message: 'core must not import model SDKs.',
  },
  { group: ['@cloud-to-code/*'], message: 'core must not depend on other workspace packages.' },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '.tmp/**',
      '**/golden/**',
      'examples/**/expected/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: forbiddenInCore }] },
  },
  {
    // Plugins and adapters must reuse core operations, never AWS collectors directly.
    files: ['packages/mcp/src/**/*.ts', 'apps/cli/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/client-*'],
              message: 'Adapters must go through @cloud-to-code/provider-aws.',
            },
          ],
        },
      ],
    },
  },
);
