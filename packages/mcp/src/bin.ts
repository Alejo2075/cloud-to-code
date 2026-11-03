#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { createServer } from './server.js';

// stdout is the protocol channel: all diagnostics go to stderr.
const argIndex = process.argv.indexOf('--dir');
const workspaceDir = resolve(
  argIndex >= 0
    ? (process.argv[argIndex + 1] ?? '.')
    : (process.env['C2C_WORKSPACE'] ?? process.cwd()),
);
const server = createServer({ workspaceDir });
await server.connect(new StdioServerTransport());
process.stderr.write(
  `cloud-to-code MCP server ready (workspace ${workspaceDir}). Read-only on AWS.\n`,
);
