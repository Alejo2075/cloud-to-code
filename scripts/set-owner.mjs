#!/usr/bin/env node
// Replaces the OWNER placeholder with your GitHub user or organization in tracked text files.
//   node scripts/set-owner.mjs my-github-name
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const owner = process.argv[2];
if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  console.error('Usage: node scripts/set-owner.mjs <github-user-or-org>');
  process.exit(2);
}
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
let changed = 0;
for (const file of files) {
  if (
    /\.(png|gif|jpg|svg)$/.test(file) ||
    file === 'pnpm-lock.yaml' ||
    file.startsWith('scripts/set-owner')
  )
    continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!/\bOWNER\b/.test(text)) continue;
  writeFileSync(
    file,
    text.replace(/github\.com\/OWNER\//g, `github.com/${owner}/`).replace(/@OWNER\b/g, `@${owner}`),
  );
  changed++;
}
console.log(`updated ${changed} files. Review with: git diff --stat`);
