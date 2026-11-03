import type { ReconstructionPlan } from '@cloud-to-code/core';
import type {
  PlanIssue,
  ReconstructionService,
  SessionStatus,
} from '@cloud-to-code/reconstruction';
import { GENERATOR_VERSION, generateProject } from './index.js';
import { writeProject } from './write.js';
import type { GeneratedFile, GeneratedProject } from './types.js';

export interface GenerateForSessionOptions {
  service: ReconstructionService;
  sessionId: string;
  /** Directory to create. A non-empty directory is refused unless `overwrite` is true. */
  output: string;
  overwrite?: boolean;
  /** Extra files (for example advisory reports) written next to the generated project. */
  extraFiles?: readonly GeneratedFile[];
  /** Local checks run on the written project; failing moves the session to FAILED. */
  validate?: (directory: string) => Promise<{ failed: boolean }>;
}

export type GenerateForSessionResult =
  | { ok: false; issues: PlanIssue[]; status: SessionStatus }
  | {
      ok: true;
      plan: ReconstructionPlan;
      project: GeneratedProject;
      written: string[];
      validationFailed: boolean;
      status: SessionStatus;
    };

/**
 * The single generation pipeline shared by the CLI and the MCP server: use an agent-submitted plan only if it still
 * verifies, otherwise rebuild the deterministic plan; generate; write; validate; record the session state. Blocking
 * questions make this return `ok: false` instead of guessing.
 */
export async function generateForSession(
  options: GenerateForSessionOptions,
): Promise<GenerateForSessionResult> {
  const { service, sessionId } = options;
  const stored = service.verifiedStoredPlan(sessionId);
  let plan: ReconstructionPlan | undefined =
    stored && stored.producedBy !== 'deterministic-planner' ? stored : undefined;
  if (!plan) {
    const planned = service.plan(sessionId);
    if (!planned.plan) return { ok: false, issues: planned.issues, status: planned.status };
    plan = planned.plan;
  }
  service.setState(sessionId, 'GENERATING');
  try {
    const snapshot = service.store.loadSnapshot(sessionId);
    const project = generateProject({
      snapshot,
      plan,
      decisions: service.currentDecisions(sessionId),
      toolVersion: GENERATOR_VERSION,
    });
    project.files.push(...(options.extraFiles ?? []));
    const written = writeProject(options.output, project.files, {
      overwrite: options.overwrite === true,
    });
    service.setState(sessionId, 'VALIDATING');
    const validation = options.validate
      ? await options.validate(options.output)
      : { failed: false };
    service.setState(
      sessionId,
      validation.failed ? 'FAILED' : 'COMPLETED',
      validation.failed ? 'Generated project failed validation' : undefined,
    );
    return {
      ok: true,
      plan,
      project,
      written,
      validationFailed: validation.failed,
      status: service.status(sessionId),
    };
  } catch (error) {
    service.setState(sessionId, 'FAILED', (error as Error).message);
    throw error;
  }
}
