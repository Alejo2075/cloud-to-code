#!/usr/bin/env node
// Copies the single source of truth for the agent skills (plugins/shared) into each host plugin.
// Plugins stay thin: they carry instructions and a manifest, never collectors, generators or question state.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const host of ['claude-code', 'codex']) {
  for (const skill of ['reconstruct', 'inspect']) {
    const target = join(root, 'plugins', host, 'skills', skill, 'SKILL.md');
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, 'plugins', 'shared', `${skill}.md`), target);
  }
}
console.log('synced skills');
