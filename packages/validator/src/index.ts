import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { sha256Hex } from '@cloud-to-code/core';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface ValidationReport {
  directory: string;
  checks: Check[];
  summary: 'passed' | 'passed-with-warnings' | 'failed';
  /** Residual risks that remain whatever the checks say. Always non-empty. */
  residualRisks: string[];
  /** Plain statement of what the checks do and do not prove. */
  notice: string;
}

export interface ValidateOptions {
  /** Run the TypeScript compiler (`tsc --noEmit`). Default true. */
  typecheck?: boolean;
  /** Run `cdk synth` from the project's own node_modules. Default false: it executes the project's code. */
  synth?: boolean;
  /** Allow synth although files differ from the manifest (you vouch for the code). */
  trust?: boolean;
  timeoutMs?: number;
}

export const VALIDATION_NOTICE =
  'These checks confirm the project is well-formed, compiles and (optionally) synthesizes. Passing does NOT prove that the template is equivalent to the running infrastructure, that ownership is correct, or that anything can be safely imported or deployed. Stateful and shared resources always need manual review.';

const REQUIRED = [
  'bin/app.ts',
  'cdk.json',
  'package.json',
  'tsconfig.json',
  '.c2c/manifest.json',
  'reports/coverage.json',
  'reports/migration-plan.md',
  'README.md',
];

interface Manifest {
  schemaVersion?: string;
  files?: { path: string; sha256: string }[];
  resources?: unknown[];
}

interface Coverage {
  summary?: Record<string, number>;
  unresolved?: { resourceId: string; property: string; reason: string }[];
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Environment passed to child processes. Only a few neutral variables are kept; HOME/USERPROFILE point at a
 * throwaway empty directory and the shared AWS credential/config files are pointed at the null device, so the
 * usual file-based credential locations are not reachable by default. This reduces, but does not eliminate,
 * exposure: code you choose to execute still runs as your OS user.
 */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv = process.env,
  home?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  const fakeHome = home ?? mkdtempSync(join(tmpdir(), 'c2c-home-'));
  env['HOME'] = fakeHome;
  env['USERPROFILE'] = fakeHome;
  env['AWS_SHARED_CREDENTIALS_FILE'] = devNull;
  env['AWS_CONFIG_FILE'] = devNull;
  env['CI'] = 'true';
  env['CDK_DISABLE_VERSION_CHECK'] = '1';
  env['CDK_CLI_TELEMETRY'] = 'false';
  env['NO_COLOR'] = '1';
  return env;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const home = mkdtempSync(join(tmpdir(), 'c2c-home-'));
    const cleanup = () => rmSync(home, { recursive: true, force: true });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: scrubbedEnv(process.env, home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const collect = (d: Buffer) => {
      if (output.length < 20_000) output += d.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      resolvePromise({ code: null, output: String(error), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      resolvePromise({ code, output: output.trim(), timedOut });
    });
  });
}

function checkStructure(dir: string): Check {
  const missing = REQUIRED.filter((f) => !existsSync(join(dir, f)));
  return missing.length === 0
    ? {
        id: 'structure',
        title: 'Project structure',
        status: 'pass',
        detail: 'All required files are present.',
      }
    : {
        id: 'structure',
        title: 'Project structure',
        status: 'fail',
        detail: `Missing: ${missing.join(', ')}`,
      };
}

function checkManifest(dir: string): { check: Check; modified: string[] } {
  const manifest = readJson<Manifest>(join(dir, '.c2c', 'manifest.json'));
  if (!manifest?.files) {
    return {
      check: {
        id: 'manifest',
        title: 'Manifest integrity',
        status: 'fail',
        detail: '.c2c/manifest.json is missing or unreadable.',
      },
      modified: [],
    };
  }
  const modified: string[] = [];
  const missing: string[] = [];
  for (const f of manifest.files) {
    const path = join(dir, f.path);
    if (!existsSync(path)) missing.push(f.path);
    else if (sha256Hex(readFileSync(path, 'utf8')) !== f.sha256) modified.push(f.path);
  }
  if (missing.length > 0) {
    return {
      check: {
        id: 'manifest',
        title: 'Manifest integrity',
        status: 'fail',
        detail: `Files listed in the manifest are missing: ${missing.join(', ')}`,
      },
      modified,
    };
  }
  if (modified.length > 0) {
    return {
      check: {
        id: 'manifest',
        title: 'Manifest integrity',
        status: 'warn',
        detail: `Edited since generation (expected if you customized them): ${modified.join(', ')}`,
      },
      modified,
    };
  }
  return {
    check: {
      id: 'manifest',
      title: 'Manifest integrity',
      status: 'pass',
      detail: `${manifest.files.length} files match the generated hashes.`,
    },
    modified,
  };
}

function checkCoverage(dir: string): { check: Check; risks: string[] } {
  const coverage = readJson<Coverage>(join(dir, 'reports', 'coverage.json'));
  if (!coverage?.summary) {
    return {
      check: {
        id: 'coverage',
        title: 'Coverage and unresolved items',
        status: 'fail',
        detail: 'reports/coverage.json is missing or unreadable.',
      },
      risks: [],
    };
  }
  const s = coverage.summary;
  const unresolved = coverage.unresolved ?? [];
  const risks = [
    ...(s['unresolved']
      ? [
          `${s['unresolved']} property(ies) are unresolved and need manual work (reports/coverage.json).`,
        ]
      : []),
    ...(s['not-mapped']
      ? [`${s['not-mapped']} observed property(ies) were not reproduced; behavior may differ.`]
      : []),
    ...(s['approximated'] ? [`${s['approximated']} property(ies) are approximated.`] : []),
  ];
  const detail = `${s['preserved'] ?? 0} preserved, ${s['approximated'] ?? 0} approximated, ${s['intentionally-omitted'] ?? 0} intentionally omitted, ${s['not-mapped'] ?? 0} not mapped, ${s['unresolved'] ?? 0} unresolved; ${unresolved.length} manual item(s).`;
  return {
    check: {
      id: 'coverage',
      title: 'Coverage and unresolved items',
      status: unresolved.length > 0 || (s['not-mapped'] ?? 0) > 0 ? 'warn' : 'pass',
      detail,
    },
    risks,
  };
}

function resolveBin(dir: string, name: string): string | undefined {
  const local = join(dir, 'node_modules', '.bin', name);
  return existsSync(local) ? local : undefined;
}

async function checkTypecheck(dir: string, timeoutMs: number): Promise<Check> {
  const title = 'TypeScript typecheck';
  let tsc: string | undefined;
  try {
    tsc = createRequire(join(dir, 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    tsc = undefined;
  }
  if (!tsc) {
    return {
      id: 'typecheck',
      title,
      status: 'skipped',
      detail:
        'typescript is not installed for this project. Run `npm install` in the project directory first (this tool never installs packages).',
    };
  }
  const result = await run(process.execPath, [tsc, '--noEmit', '-p', join(dir, 'tsconfig.json')], {
    cwd: dir,
    timeoutMs,
  });
  if (result.timedOut)
    return { id: 'typecheck', title, status: 'fail', detail: `Timed out after ${timeoutMs} ms.` };
  return result.code === 0
    ? {
        id: 'typecheck',
        title,
        status: 'pass',
        detail: 'The project compiles with no type errors.',
      }
    : {
        id: 'typecheck',
        title,
        status: 'fail',
        detail: result.output.slice(0, 4000) || `tsc exited with ${String(result.code)}`,
      };
}

async function checkSynth(
  dir: string,
  modified: string[],
  manifestStatus: CheckStatus,
  options: ValidateOptions,
  timeoutMs: number,
): Promise<Check> {
  const title = 'cdk synth';
  if (!options.synth) {
    return {
      id: 'synth',
      title,
      status: 'skipped',
      detail:
        "Not requested. `cdk synth` executes the project's TypeScript, so it only runs with --synth.",
    };
  }
  // Fail closed: execute only code verified against the manifest, unless the developer vouches for it.
  if (manifestStatus !== 'pass' && !options.trust) {
    return {
      id: 'synth',
      title,
      status: 'skipped',
      detail: `Refusing to execute code that could not be verified against the generated manifest (${manifestStatus}${modified.length > 0 ? `: ${modified.join(', ')}` : ''}). Review it, then pass --trust to run it anyway.`,
    };
  }
  const cdk = resolveBin(dir, 'cdk');
  if (!cdk) {
    return {
      id: 'synth',
      title,
      status: 'skipped',
      detail:
        'aws-cdk is not installed for this project. Run `npm install` in the project directory first.',
    };
  }
  const result = await run(cdk, ['synth', '--quiet', '--no-version-reporting'], {
    cwd: dir,
    timeoutMs,
  });
  if (result.timedOut)
    return { id: 'synth', title, status: 'fail', detail: `Timed out after ${timeoutMs} ms.` };
  return result.code === 0
    ? {
        id: 'synth',
        title,
        status: 'pass',
        detail:
          'The app synthesizes a CloudFormation template (AWS credential variables and the usual credential files were withheld from the process). This is not a safety proof.',
      }
    : {
        id: 'synth',
        title,
        status: 'fail',
        detail: result.output.slice(0, 4000) || `cdk exited with ${String(result.code)}`,
      };
}

export async function validateProject(
  directory: string,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const dir = resolve(directory);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  const timeoutMs = options.timeoutMs ?? 300_000;
  const checks: Check[] = [];
  const structure = checkStructure(dir);
  checks.push(structure);
  const manifest = checkManifest(dir);
  checks.push(manifest.check);
  const coverage = checkCoverage(dir);
  checks.push(coverage.check);
  if (options.typecheck !== false) checks.push(await checkTypecheck(dir, timeoutMs));
  checks.push(await checkSynth(dir, manifest.modified, manifest.check.status, options, timeoutMs));

  const failed = checks.some((c) => c.status === 'fail');
  const warned = checks.some((c) => c.status === 'warn' || c.status === 'skipped');
  return {
    directory: dir,
    checks,
    summary: failed ? 'failed' : warned ? 'passed-with-warnings' : 'passed',
    residualRisks: [
      ...coverage.risks,
      'Recreated stateful resources start empty; existing data is not migrated.',
      'Shared resources are referenced by ARN and must exist and behave as expected in the target account.',
      'IAM policies are copied from observation; review them for least privilege.',
      'Equivalence with the running infrastructure is not verified.',
    ],
    notice: VALIDATION_NOTICE,
  };
}

export * from './adoption.js';
