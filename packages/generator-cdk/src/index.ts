import {
  sha256Hex,
  type CloudSnapshot,
  type DeveloperDecision,
  type ReconstructionPlan,
} from '@cloud-to-code/core';
import { GROUP_ORDER, generateConstruct, type ConstructOutput } from './constructs.js';
import { GenContext, type GroupName } from './context.js';
import { buildExpectations, renderTestFile } from './expectations.js';
import { appFile, packageFiles, stackFile, stackFileBase } from './project.js';
import {
  architectureReport,
  coverageReport,
  decisionsReport,
  migrationPlan,
  planDigest,
  projectReadme,
  sourceReadme,
} from './reports.js';
import {
  GenerationError,
  type GenerateInput,
  type GeneratedFile,
  type GeneratedProject,
  type ResourceCoverage,
} from './types.js';

export * from './types.js';
export { writeProject, type WriteOptions } from './write.js';
export { checkExpectations, buildExpectations } from './expectations.js';
export { RUNTIME_CONSTANTS } from './rules/lambda.js';
export { GenContext } from './context.js';

export const GENERATOR_NAME = '@cloud-to-code/generator-cdk';
export const GENERATOR_VERSION = '0.1.0';

function groupOfConstruct(id: string): GroupName {
  const group = GROUP_ORDER.find((g) => id.endsWith(`-${g}`));
  if (!group)
    throw new GenerationError(
      'unknown-construct',
      `Construct ${id} does not map to a known group.`,
    );
  return group;
}

/**
 * Generate a CDK v2 TypeScript project from a snapshot and a VERIFIED plan. Pure and deterministic: the same
 * inputs produce byte-identical files (no timestamps, no randomness, no network). The plan must already have
 * passed `verifyPlan`; this function additionally refuses anything it cannot map.
 */
export function generateProject(input: GenerateInput): GeneratedProject {
  const { snapshot, plan, decisions } = input;
  if (plan.snapshotId !== snapshot.id) {
    throw new GenerationError(
      'snapshot-mismatch',
      `The plan is for snapshot ${plan.snapshotId}, not ${snapshot.id}.`,
    );
  }
  if (plan.generation.strategy !== 'balanced') {
    throw new GenerationError(
      'strategy-unsupported',
      `Strategy "${plan.generation.strategy}" is not implemented; only "balanced" can be generated.`,
    );
  }
  if (plan.stacks.length !== 1) {
    throw new GenerationError(
      'multiple-stacks',
      'Only single-stack plans are supported by this generator version.',
    );
  }

  const ctx = new GenContext(snapshot, plan);
  const present = plan.constructs.map((c) => groupOfConstruct(c.id));
  const ordered = [...plan.constructs].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(groupOfConstruct(a.id)) - GROUP_ORDER.indexOf(groupOfConstruct(b.id)),
  );
  const presentOrdered = ordered.map((c) => groupOfConstruct(c.id));
  const outputs: ConstructOutput[] = ordered.map((c) =>
    generateConstruct(ctx, c, groupOfConstruct(c.id), presentOrdered),
  );
  void present;

  const coverage: ResourceCoverage[] = [];
  const unresolved: GeneratedProject['unresolved'] = plan.unresolved.map((u) => ({
    resourceId: u.resourceId,
    property: u.property,
    reason: u.reason,
  }));
  for (const o of outputs) {
    for (const [resourceId, result] of o.results) {
      const entry = ctx.entry(resourceId);
      const overrides = ctx.overrides.get(resourceId) ?? [];
      const properties = result.properties
        .filter((p) => !overrides.some((x) => x.name === p.name))
        .concat(overrides);
      properties.sort((a, b) => a.name.localeCompare(b.name));
      coverage.push({
        resourceId,
        type: entry.resource.type,
        displayName: entry.resource.displayName,
        ownership: entry.owned ? 'recreate' : 'reference',
        construct: o.className,
        file: o.file.path,
        ruleId: result.ruleId,
        level: result.level,
        logicalId: ctx.logicalId(resourceId),
        evidenceIds: entry.resource.evidenceIds,
        decisionIds: o.construct.decisionIds,
        properties,
      });
      for (const u of result.unresolved) {
        if (!unresolved.some((x) => x.resourceId === u.resourceId && x.property === u.property))
          unresolved.push(u);
      }
    }
  }
  coverage.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  unresolved.sort(
    (a, b) => a.resourceId.localeCompare(b.resourceId) || a.property.localeCompare(b.property),
  );

  const expectations = buildExpectations(ctx);
  const files: GeneratedFile[] = [
    ...outputs.map((o) => o.file),
    stackFile(ctx, outputs),
    appFile(plan),
    ...packageFiles(plan),
    projectReadme(ctx, outputs),
    sourceReadme(ctx, decisions),
    {
      path: 'test/infrastructure.test.ts',
      content: renderTestFile(plan.stacks[0]!.name, stackFileBase(plan), expectations),
    },
    architectureReport(ctx, coverage),
    decisionsReport(ctx, decisions),
    coverageReport(ctx, coverage, unresolved),
    migrationPlan(ctx, coverage, outputs),
  ];

  const manifest = {
    schemaVersion: '1',
    tool: { name: GENERATOR_NAME, version: input.toolVersion ?? GENERATOR_VERSION },
    snapshotId: snapshot.id,
    planDigest: planDigest(plan),
    application: plan.applicationName,
    strategy: plan.generation.strategy,
    producedBy: plan.producedBy,
    decisionIds: plan.decisionIds,
    resources: coverage.map((c) => ({
      resourceId: c.resourceId,
      type: c.type,
      ownership: c.ownership,
      construct: c.construct,
      file: c.file,
      ruleId: c.ruleId,
      level: c.level,
      logicalId: c.logicalId,
      evidenceIds: c.evidenceIds,
      decisionIds: c.decisionIds,
    })),
    files: files
      .map((f) => ({ path: f.path, sha256: sha256Hex(f.content) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  files.push({ path: '.c2c/manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, coverage, unresolved };
}

export type { CloudSnapshot, DeveloperDecision, ReconstructionPlan };
export * from './session.js';
