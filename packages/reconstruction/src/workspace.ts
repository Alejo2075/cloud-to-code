import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DeveloperDecisionSchema,
  ReconstructionPlanSchema,
  SessionSchema,
  defaultMigrations,
  parseSnapshot,
  type CloudSnapshot,
  type DeveloperDecision,
  type ReconstructionPlan,
  type Session,
} from '@cloud-to-code/core';

export const WORKSPACE_DIR = '.c2c';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export function assertSafeId(id: string, what = 'ID'): void {
  if (!SAFE_ID.test(id) || id.includes('..'))
    throw new WorkspaceError(`Invalid ${what}: ${JSON.stringify(id)}`);
}

/**
 * Local, resumable workspace: `<root>/.c2c/sessions/<id>/{session,snapshot,plan}.json + decisions.jsonl`.
 * Directories are 0700 and files 0600. Writes are atomic (temp file + rename). It never stores credentials:
 * only sanitized snapshots, decisions (secrets already redacted), and plans.
 */
export class WorkspaceStore {
  readonly root: string;

  constructor(projectDir: string) {
    this.root = join(resolve(projectDir), WORKSPACE_DIR);
  }

  private sessionsDir(): string {
    return join(this.root, 'sessions');
  }

  private sessionDir(id: string): string {
    assertSafeId(id, 'session ID');
    return join(this.sessionsDir(), id);
  }

  private ensureDir(dir: string): void {
    if (existsSync(dir)) {
      if (lstatSync(dir).isSymbolicLink())
        throw new WorkspaceError(`Refusing to use symlinked directory ${dir}`);
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  private readJson(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new WorkspaceError(`Cannot read ${path}: ${(error as Error).message}`);
    }
  }

  hasSession(id: string): boolean {
    return existsSync(join(this.sessionDir(id), 'session.json'));
  }

  createSession(session: Session, snapshot: CloudSnapshot): void {
    const dir = this.sessionDir(session.id);
    if (existsSync(dir)) throw new WorkspaceError(`Session ${session.id} already exists`);
    this.ensureDir(this.root);
    this.ensureDir(this.sessionsDir());
    this.ensureDir(dir);
    this.writeJson(join(dir, 'snapshot.json'), snapshot);
    this.saveSession(session);
  }

  saveSession(session: Session): void {
    this.writeJson(join(this.sessionDir(session.id), 'session.json'), session);
  }

  loadSession(id: string): Session {
    const path = join(this.sessionDir(id), 'session.json');
    if (!existsSync(path)) throw new WorkspaceError(`Session ${id} not found in ${this.root}`);
    const migrated = defaultMigrations.migrate('session', this.readJson(path), '1');
    return SessionSchema.parse(migrated);
  }

  loadSnapshot(id: string): CloudSnapshot {
    return parseSnapshot(this.readJson(join(this.sessionDir(id), 'snapshot.json'))).snapshot;
  }

  /** Replace the stored snapshot (after a re-scan). Callers reconcile decisions afterwards. */
  saveSnapshot(id: string, snapshot: CloudSnapshot): void {
    this.writeJson(join(this.sessionDir(id), 'snapshot.json'), snapshot);
  }

  appendDecision(decision: DeveloperDecision): void {
    const dir = this.sessionDir(decision.sessionId);
    appendFileSync(join(dir, 'decisions.jsonl'), `${JSON.stringify(decision)}\n`, { mode: 0o600 });
  }

  /** All decisions in recorded order (the full audit history). */
  loadDecisions(id: string): DeveloperDecision[] {
    const path = join(this.sessionDir(id), 'decisions.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return DeveloperDecisionSchema.parse(JSON.parse(line));
        } catch (error) {
          throw new WorkspaceError(
            `Corrupt decision at line ${index + 1} of ${path}: ${(error as Error).message}`,
          );
        }
      });
  }

  savePlan(id: string, plan: ReconstructionPlan): void {
    this.writeJson(join(this.sessionDir(id), 'plan.json'), plan);
  }

  loadPlan(id: string): ReconstructionPlan | undefined {
    const path = join(this.sessionDir(id), 'plan.json');
    if (!existsSync(path)) return undefined;
    return ReconstructionPlanSchema.parse(
      defaultMigrations.migrate('plan', this.readJson(path), '1'),
    );
  }

  listSessions(): Session[] {
    const dir = this.sessionsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => SAFE_ID.test(name) && existsSync(join(dir, name, 'session.json')))
      .map((name) => this.loadSession(name))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  latestSessionId(): string | undefined {
    return this.listSessions()[0]?.id;
  }
}
