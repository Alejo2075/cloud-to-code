import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSnapshot, sanitizeSnapshot, type CloudSnapshot } from '@cloud-to-code/core';
import { ReconstructionService, WorkspaceStore } from '@cloud-to-code/reconstruction';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { CliError, ExitCode } from './exit-codes.js';
import type { CliIo } from './io.js';

export interface GlobalOptions {
  json?: boolean;
  nonInteractive?: boolean;
  session?: string;
  dir?: string;
}

export interface SourceOptions {
  snapshot?: string;
  demo?: boolean;
}

export interface Context {
  io: CliIo;
  opts: GlobalOptions;
  json: boolean;
  /** Prompts allowed: a terminal, no --json, no --non-interactive. */
  interactive: boolean;
  store: WorkspaceStore;
  service: ReconstructionService;
}

const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

export function createContext(io: CliIo, opts: GlobalOptions): Context {
  const store = new WorkspaceStore(resolve(io.cwd, opts.dir ?? '.'));
  return {
    io,
    opts,
    json: opts.json === true,
    interactive: io.interactive && !opts.nonInteractive && !opts.json,
    store,
    service: new ReconstructionService(store),
  };
}

/** Print either the machine-readable value (--json) or the human text. Never both. */
export function emit(ctx: Context, json: unknown, human: string): void {
  if (ctx.json) ctx.io.stdout(`${JSON.stringify(json, null, 2)}\n`);
  else ctx.io.stdout(`${human}\n`);
}

/** Progress and hints go to stderr so --json stdout stays clean. */
export function note(ctx: Context, text: string): void {
  ctx.io.stderr(`${text}\n`);
}

export interface LoadedSnapshot {
  snapshot: CloudSnapshot;
  origin: string;
  redactions: number;
  warnings: string[];
}

/** Load, validate and sanitize a snapshot file. Sanitization happens before anything is persisted. */
export function loadSnapshotFile(ctx: Context, path: string): LoadedSnapshot {
  const full = resolve(ctx.io.cwd, path);
  let raw: unknown;
  try {
    if (statSync(full).size > MAX_SNAPSHOT_BYTES)
      throw new CliError(
        `Snapshot ${path} is larger than 50 MB.`,
        ExitCode.USAGE,
        'snapshot-too-large',
      );
    raw = JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `Cannot read snapshot ${path}: ${(error as Error).message}`,
      ExitCode.USAGE,
      'snapshot-unreadable',
    );
  }
  try {
    const { snapshot, warnings } = parseSnapshot(raw);
    const sanitized = sanitizeSnapshot(snapshot);
    return {
      snapshot: sanitized.snapshot,
      origin: path,
      redactions: sanitized.redactions,
      warnings: warnings.map((w) => w.message),
    };
  } catch (error) {
    throw new CliError(
      `Invalid snapshot ${path}: ${(error as Error).message}`,
      ExitCode.USAGE,
      'snapshot-invalid',
    );
  }
}

export function demoSnapshot(): LoadedSnapshot {
  return {
    snapshot: buildServerlessOrdersSnapshot(),
    origin: 'bundled demo fixture (synthetic)',
    redactions: 0,
    warnings: [],
  };
}

/** Resolve where the snapshot comes from: --snapshot, --demo, an explicit/latest session, in that order. */
export function resolveSnapshot(ctx: Context, source: SourceOptions): LoadedSnapshot {
  if (source.snapshot && source.demo) {
    throw new CliError(
      'Use either --snapshot or --demo, not both.',
      ExitCode.USAGE,
      'conflicting-source',
    );
  }
  if (source.snapshot) return loadSnapshotFile(ctx, source.snapshot);
  if (source.demo) return demoSnapshot();
  const id = ctx.opts.session ?? ctx.store.latestSessionId();
  if (!id) {
    throw new CliError(
      'No snapshot source. Provide --snapshot <file>, --demo, or run inside a directory with a .c2c session.',
      ExitCode.USAGE,
      'no-source',
      'Try `c2c demo` for an offline example, or `c2c inspect --demo`.',
    );
  }
  return {
    snapshot: ctx.store.loadSnapshot(id),
    origin: `session ${id}`,
    redactions: 0,
    warnings: [],
  };
}

export function resolveSessionId(ctx: Context): string {
  const id = ctx.opts.session ?? ctx.store.latestSessionId();
  if (!id) {
    throw new CliError(
      `No session found in ${ctx.store.root}.`,
      ExitCode.USAGE,
      'no-session',
      'Start one with `c2c reconstruct --demo --application orders-api`.',
    );
  }
  return id;
}
