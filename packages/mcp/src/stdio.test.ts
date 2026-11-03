import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from './index.js';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');

// Runs against the built binary (CI builds before testing); skipped when dist is absent.
describe.skipIf(!existsSync(bin))('stdio binary', () => {
  it('speaks MCP over stdio and lists the same tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c2c-stdio-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, '--dir', dir],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
