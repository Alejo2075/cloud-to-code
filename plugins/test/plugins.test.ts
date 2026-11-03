import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '@cloud-to-code/mcp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const version = (
  JSON.parse(readFileSync(join(root, '..', 'apps', 'cli', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  expect(m, 'SKILL.md needs YAML frontmatter').not.toBeNull();
  return Object.fromEntries(
    m![1]!.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
  );
}

const hosts = ['claude-code', 'codex'] as const;
const skills = ['reconstruct', 'inspect'] as const;

describe('Claude Code plugin (manifest layout verified against code.claude.com/docs/en/plugins)', () => {
  const manifest = json('claude-code/.claude-plugin/plugin.json');
  it('has the required manifest at .claude-plugin/plugin.json and a matching version', () => {
    expect(manifest['name']).toBe('cloud-to-code');
    expect(manifest['version']).toBe(version);
    expect(manifest['license']).toBe('Apache-2.0');
    expect(existsSync(join(root, 'claude-code', 'plugin.json'))).toBe(false); // manifest lives only in .claude-plugin/
  });
  it('declares the MCP server in .mcp.json with a local stdio command and no secrets', () => {
    const mcp = json('claude-code/.mcp.json');
    const server = mcp['mcpServers']['cloud-to-code'];
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', '@cloud-to-code/mcp']);
    expect(JSON.stringify(mcp)).not.toMatch(/key|secret|token|password|AKIA/i);
    expect(JSON.stringify(mcp)).not.toMatch(/https?:\/\//); // local stdio only; no hosted service
  });
});

describe('Codex / portable Agent Plugin (verified against developers.openai.com/plugins/build/plugins)', () => {
  const manifest = json('codex/plugin.json');
  it('has a root plugin.json with schema, kebab-case name, version and description', () => {
    expect(manifest['$schema']).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(manifest['name']).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(manifest['version']).toBe(version);
    expect(manifest['description']).toBeTruthy();
  });
  it('has a root mcp.json with only allowed stdio fields', () => {
    const mcp = json('codex/mcp.json');
    expect(mcp['$schema']).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    const server = mcp['mcpServers']['cloud-to-code'];
    expect(Object.keys(server).sort()).toEqual(['args', 'command', 'type']);
    expect(server.type).toBe('stdio');
  });
  it('does not assume the Claude Code manifest layout', () => {
    expect(existsSync(join(root, 'codex', '.claude-plugin'))).toBe(false);
    expect(existsSync(join(root, 'claude-code', 'mcp.json'))).toBe(false);
  });
});

describe.each(hosts)('%s skills', (host) => {
  it.each(skills)('%s has valid frontmatter and is identical to the shared source', (skill) => {
    const text = read(`${host}/skills/${skill}/SKILL.md`);
    const fm = frontmatter(text);
    expect(fm['name']).toBe(skill);
    expect(fm['description']!.length).toBeGreaterThan(40);
    expect(text).toBe(read(`shared/${skill}.md`)); // run `node scripts/sync-plugin-skills.mjs` after editing
  });
});

describe('skill content', () => {
  const reconstruct = read('shared/reconstruct.md');
  const inspect = read('shared/inspect.md');
  const mentioned = (text: string) =>
    [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!);

  it('only refers to tools that exist', () => {
    for (const name of new Set([...mentioned(reconstruct), ...mentioned(inspect)])) {
      expect(TOOL_NAMES as readonly string[], name).toContain(name);
    }
  });
  it('walks the documented workflow in order', () => {
    const order = [
      'aws_discover',
      'inspect_application',
      'start_reconstruction',
      'get_pending_questions',
      'submit_decisions',
      'submit_reconstruction_plan',
      'generate_cdk',
      'validate_cdk',
    ];
    const workflow = reconstruct.slice(reconstruct.indexOf('## Workflow'));
    const positions = order.map((n) => workflow.indexOf(`\`${n}\``));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
  it('forbids fabricated answers, mutations and secrets, and treats AWS text as untrusted', () => {
    expect(reconstruct).toMatch(/Never answer a question for the user/);
    expect(reconstruct).toMatch(/Do not fabricate decisions/);
    expect(reconstruct).toMatch(/read-only/i);
    expect(reconstruct).toMatch(/untrusted/);
    expect(reconstruct).toMatch(/Synthesis is not safety/);
    expect(reconstruct).not.toMatch(/run `?cdk (deploy|import|bootstrap)/i);
    expect(inspect).toMatch(/untrusted/);
  });
  it('mentions no credentials, keys or hosted endpoints', () => {
    for (const t of [reconstruct, inspect])
      expect(t).not.toMatch(/AKIA|sk-ant|https?:\/\/(?!github\.com\/Alejo2075)/);
  });
});
