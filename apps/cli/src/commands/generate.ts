import { resolve } from 'node:path';
import {
  GENERATOR_VERSION,
  GenerationError,
  generateProject,
  writeProject,
} from '@cloud-to-code/generator-cdk';
import { validateProject, adoptionPlan, type ValidationReport } from '@cloud-to-code/validator';
import { emit, resolveSessionId, type Context } from '../context.js';
import { CliError, ExitCode } from '../exit-codes.js';
import { renderPlanSummary, renderStatus } from '../render.js';
import { reportInterview, runInterview } from './interview.js';

export interface GenerateOptions {
  output?: string;
  overwrite?: boolean;
}

function renderChecks(report: ValidationReport): string {
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' } as const;
  return report.checks.map((c) => `  [${mark[c.status]}] ${c.title}: ${c.detail}`).join('\n');
}

/**
 * Build the verified plan (asking nothing new: blocking questions must already be answered), then generate the
 * CDK project into a NEW directory. An existing non-empty directory is never touched without --overwrite.
 */
export async function runGenerate(
  ctx: Context,
  options: GenerateOptions & { answers?: string },
): Promise<number> {
  const sessionId = resolveSessionId(ctx);
  if (!options.output) {
    throw new CliError(
      'Missing --output <directory>. Generated code is always written to a directory you choose.',
      ExitCode.USAGE,
      'usage',
    );
  }
  const result = await runInterview(
    ctx,
    sessionId,
    options.answers ? { answers: options.answers } : {},
  );
  if (result.outcome !== 'OK' || !result.plan) return reportInterview(ctx, sessionId, result);

  const svc = ctx.service;
  const output = resolve(ctx.io.cwd, options.output);
  svc.setState(sessionId, 'GENERATING');
  try {
    const snapshot = ctx.store.loadSnapshot(sessionId);
    const decisions = svc.decisions(sessionId).latest;
    const project = generateProject({
      snapshot,
      plan: result.plan,
      decisions,
      toolVersion: GENERATOR_VERSION,
    });
    writeProject(output, project.files, { overwrite: options.overwrite === true });
    svc.setState(sessionId, 'VALIDATING');
    const validation = await validateProject(output, { typecheck: false });
    svc.setState(
      sessionId,
      validation.summary === 'failed' ? 'FAILED' : 'COMPLETED',
      validation.summary === 'failed' ? 'Generated project failed validation' : undefined,
    );
    const status = svc.status(sessionId);
    const exitCode = validation.summary === 'failed' ? ExitCode.FAILED : ExitCode.OK;
    emit(
      ctx,
      {
        status: validation.summary === 'failed' ? 'FAILED' : 'OK',
        exitCode,
        session: status,
        output,
        files: project.files.map((f) => f.path),
        unresolved: project.unresolved,
        plan: result.plan,
        validation,
      },
      [
        renderStatus(status),
        '',
        renderPlanSummary(result.plan),
        '',
        `Generated ${project.files.length} files in ${output}`,
        `Unresolved items needing manual work: ${project.unresolved.length} (see reports/coverage.json)`,
        '',
        'Local checks (nothing was deployed; no AWS resource was modified):',
        renderChecks(validation),
        '',
        'Next: cd into the project, run `npm install`, then `npm test` and `npx cdk synth`.',
        'Synthesis does not prove the template is equivalent to your running infrastructure or safe to import. Read reports/migration-plan.md.',
      ].join('\n'),
    );
    return exitCode;
  } catch (error) {
    svc.setState(sessionId, 'FAILED', (error as Error).message);
    if (error instanceof GenerationError) {
      const exit =
        error.code === 'output-not-empty' ||
        error.code === 'unsafe-output' ||
        error.code === 'unsafe-path'
          ? ExitCode.USAGE
          : ExitCode.FAILED;
      throw new CliError(
        error.message,
        exit,
        error.code,
        error.code === 'output-not-empty'
          ? 'Pick a new directory, or pass --overwrite if replacing its files is what you want.'
          : undefined,
      );
    }
    throw error;
  }
}

export async function runValidate(
  ctx: Context,
  directory: string,
  options: { synth?: boolean; trust?: boolean; typecheck?: boolean },
): Promise<number> {
  let report: ValidationReport;
  try {
    report = await validateProject(resolve(ctx.io.cwd, directory), {
      synth: options.synth === true,
      trust: options.trust === true,
      typecheck: options.typecheck !== false,
    });
  } catch (error) {
    throw new CliError((error as Error).message, ExitCode.USAGE, 'validate-failed');
  }
  const exitCode = report.summary === 'failed' ? ExitCode.FAILED : ExitCode.OK;
  emit(
    ctx,
    { status: report.summary === 'failed' ? 'FAILED' : 'OK', exitCode, report },
    [
      `Validation of ${report.directory}: ${report.summary}`,
      renderChecks(report),
      '',
      'Residual risks:',
      ...report.residualRisks.map((r) => `  - ${r}`),
      '',
      report.notice,
    ].join('\n'),
  );
  return exitCode;
}

export function runAdoptionPlan(ctx: Context, directory: string): number {
  let plan;
  try {
    plan = adoptionPlan(resolve(ctx.io.cwd, directory));
  } catch (error) {
    throw new CliError((error as Error).message, ExitCode.USAGE, 'adoption-plan-failed');
  }
  const lines = [
    `Adoption plan for ${plan.directory} (ADVISORY ONLY: this tool never imports, deploys or modifies anything)`,
    '',
    `Resources defined by the app (${plan.resources.length}):`,
    ...plan.resources.map(
      (r) =>
        `  - ${r.resourceId.split('/').slice(3).join('/')}  [${r.type}]  construct ${r.construct}${r.stateful ? '  STATEFUL' : ''}${r.unresolved.length > 0 ? `  unresolved: ${r.unresolved.join(', ')}` : ''}`,
    ),
    '',
    `Referenced, not managed (${plan.referenced.length}):`,
    ...plan.referenced.map((r) => `  - ${r.split('/').slice(3).join('/')}`),
    '',
    'Prerequisites:',
    ...plan.prerequisites.map((p) => `  - ${p}`),
    '',
    'Warnings:',
    ...plan.warnings.map((w) => `  ! ${w}`),
    '',
    'Manual steps:',
    ...plan.manualSteps.map((s) => `  - ${s}`),
  ];
  emit(ctx, { status: 'OK', exitCode: 0, plan }, lines.join('\n'));
  return ExitCode.OK;
}
