#!/usr/bin/env node
import { main } from './program.js';
import { ClackPrompter } from './prompter.js';

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const code = await main(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  interactive,
  ...(interactive ? { prompter: new ClackPrompter() } : {}),
});
process.exitCode = code;
