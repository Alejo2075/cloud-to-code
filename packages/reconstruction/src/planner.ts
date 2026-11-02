import {
  EvidenceGraph,
  type ApplicationCandidate,
  type Assumption,
  type CloudResource,
  type CloudSnapshot,
  type ConstructPlan,
  type DeveloperDecision,
  type ReconstructionPlan,
  type Strategy,
  type UnresolvedProperty,
} from '@cloud-to-code/core';
import { slug, toPascalCase } from './naming.js';
import { computeQuestions } from './questions.js';
import { GROUP_BY_TYPE, STATEFUL_TYPES, SUPPORTED_GENERATION_TYPES } from './supported-types.js';

export class PlanningError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanningError';
  }
}

export interface PlanInput {
  snapshot: CloudSnapshot;
  /** Latest decision per question whose evidence is unchanged. */
  decisions: readonly DeveloperDecision[];
  strategy: Strategy;
  applicationId?: string | undefined;
}

const GROUP_ORDER = ['references', 'data', 'messaging', 'compute', 'api', 'events'] as const;
type PlanGroup = (typeof GROUP_ORDER)[number];

export function applicationIdFor(name: string): string {
  return slug(name);
}

/**
 * Resolve the application candidate to reconstruct. With no `applicationId`, exactly one candidate must
 * exist; otherwise the caller (a human or the host agent) must choose. Never guesses between candidates.
 */
export function selectApplication(
  graph: EvidenceGraph,
  applicationId?: string,
): ApplicationCandidate {
  const { candidates } = graph.applicationCandidates();
  if (candidates.length === 0)
    throw new PlanningError('no-candidates', 'The snapshot has no application candidates.');
  const wanted = applicationId?.toLowerCase();
  const candidate = wanted
    ? candidates.find(
        (c) =>
          c.id === wanted || applicationIdFor(c.name) === wanted || c.name.toLowerCase() === wanted,
      )
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (candidate) return candidate;
  const names = candidates.map((c) => applicationIdFor(c.name)).join(', ');
  throw new PlanningError(
    wanted ? 'application-not-found' : 'application-not-selected',
    wanted
      ? `Application "${applicationId}" not found. Candidates: ${names}.`
      : `Several application candidates found (${names}). Select one with --application.`,
  );
}

/**
 * Deterministic planner: derives a reconstruction plan from the evidence graph and recorded developer
 * decisions only. It never asks a model. Same inputs always produce the same plan.
 */
export function buildPlan(input: PlanInput): ReconstructionPlan {
  const { snapshot } = input;
  if (input.strategy === 'modernized') {
    throw new PlanningError(
      'strategy-unsupported',
      'The "modernized" strategy is a separate proposal and is not implemented; use "balanced".',
    );
  }
  if (input.strategy === 'faithful') {
    throw new PlanningError(
      'strategy-unsupported',
      'The "faithful" strategy (L1-only generation) is planned but not implemented yet; use "balanced".',
    );
  }

  const graph = new EvidenceGraph(snapshot);
  const candidate = selectApplication(graph, input.applicationId);
  const app = candidate;
  const appId = applicationIdFor(app.name);

  const decisionByQuestion = new Map(input.decisions.map((d) => [d.questionId, d]));
  const choiceOf = (questionId: string): string | undefined => {
    const answer = decisionByQuestion.get(questionId)?.answer;
    return answer?.kind === 'choice' ? answer.optionId : undefined;
  };

  const owned = new Set<string>();
  const referenced = new Set<string>();
  const excluded = new Set<string>();
  const unresolved: UnresolvedProperty[] = [];
  const assumptions: Assumption[] = [];
  const used = new Set<string>();

  // 1. Shared hubs: ownership is a human decision (blocking), never a guess.
  const sharedSet = new Set(app.sharedResourceIds);
  for (const hubId of app.sharedResourceIds) {
    const hub = graph.resources.get(hubId)!;
    const qid = `q-shared-${slug(hub.displayName)}`;
    const choice = choiceOf(qid);
    if (!choice) {
      throw new PlanningError(
        'shared-ownership-unresolved',
        `Ownership of '${hub.displayName}' has not been decided.`,
      );
    }
    used.add(qid);
    if (choice === 'reference') referenced.add(hubId);
    else if (choice === 'exclude') excluded.add(hubId);
    else if (choice === `own-${app.id}`) owned.add(hubId);
    else referenced.add(hubId); // owned by another application: reference it here
  }

  // 2. Candidate-owned resources.
  const statefulChoice = choiceOf(`q-stateful-${slug(app.name)}`);
  if (statefulChoice) used.add(`q-stateful-${slug(app.name)}`);
  for (const id of app.resourceIds) {
    if (sharedSet.has(id)) continue;
    const r = graph.resources.get(id)!;
    if (!SUPPORTED_GENERATION_TYPES.has(r.type)) {
      excluded.add(id);
      unresolved.push({
        resourceId: id,
        property: '*',
        reason: `Resource type ${r.type} is not supported by the CDK generator yet; it is excluded and must be handled manually.`,
        requiredFor: 'generation',
      });
      continue;
    }
    if (r.type === 'AWS::Lambda::Function' && r.observedProperties['packageType'] === 'Image') {
      excluded.add(id);
      unresolved.push({
        resourceId: id,
        property: 'packageType',
        reason:
          'Container-image Lambda functions are not supported by the generator yet; the function is excluded and must be handled manually.',
        requiredFor: 'generation',
      });
      continue;
    }
    if (STATEFUL_TYPES.has(r.type) && statefulChoice === 'reference-existing') referenced.add(id);
    else owned.add(id);
  }
  if (
    !statefulChoice &&
    [...owned].some((id) => STATEFUL_TYPES.has(graph.resources.get(id)!.type))
  ) {
    assumptions.push({
      id: 'assume-stateful-retain',
      statement:
        'Stateful resources are recreated with a RETAIN removal policy and CDK-generated names; existing data is not migrated. (Default applied because the question was not answered.)',
      kind: 'default',
      accepted: false,
      evidenceIds: [],
    });
  }

  // 3. Per-resource unresolved properties (facts that are never collected).
  const lambdaSource = choiceOf(`q-lambda-source-${slug(app.name)}`);
  if (lambdaSource) used.add(`q-lambda-source-${slug(app.name)}`);
  for (const id of [...owned].sort()) {
    const r = graph.resources.get(id)!;
    if (r.type !== 'AWS::Lambda::Function') continue;
    unresolved.push({
      resourceId: id,
      property: 'code',
      reason:
        'Deployed code packages are never downloaded and cannot reconstruct your repository. Code is taken from deploy-time CloudFormation parameters.',
      requiredFor: 'generation',
    });
    for (const unsupported of ['vpcConfig', 'fileSystemConfigs', 'deadLetterConfig', 'kmsKeyArn']) {
      if (r.observedProperties[unsupported] !== undefined) {
        unresolved.push({
          resourceId: id,
          property: unsupported,
          reason: `${unsupported} is observed but not mapped by the generator yet; configure it manually.`,
          requiredFor: 'generation',
        });
      }
    }
    const names = (r.observedProperties['environmentVariableNames'] as string[] | undefined) ?? [];
    if (names.length > 0) {
      unresolved.push({
        resourceId: id,
        property: 'environment',
        reason: `Environment variable values are never collected. Names observed: ${names.join(', ')}. Provide values at deploy time.`,
        requiredFor: 'generation',
      });
    }
  }
  assumptions.push({
    id: 'assume-code-parameters',
    statement: 'Lambda code comes from CloudFormation parameters; no source repository is assumed.',
    kind: 'default',
    accepted: lambdaSource === 'infra-only',
    evidenceIds: [],
  });
  assumptions.push({
    id: 'assume-generated-names',
    statement:
      'Physical names of recreated resources are not set, so CDK generates them and cannot collide with the existing resources.',
    kind: 'default',
    accepted: false,
    evidenceIds: [],
  });

  // 4. Constructs: one per group, plus one for referenced (existing) resources.
  const groupOf = (r: CloudResource, isRef: boolean): PlanGroup =>
    isRef ? 'references' : (GROUP_BY_TYPE[r.type] as PlanGroup);
  const members = new Map<PlanGroup, string[]>();
  for (const id of [...owned, ...referenced].sort()) {
    const r = graph.resources.get(id)!;
    if (!SUPPORTED_GENERATION_TYPES.has(r.type)) continue;
    const group = groupOf(r, referenced.has(id));
    members.set(group, [...(members.get(group) ?? []), id]);
  }

  const stackId = `${appId}-stack`;
  const evidenceFor = (ids: readonly string[]): string[] =>
    [...new Set(ids.flatMap((id) => graph.resources.get(id)?.evidenceIds ?? []))].sort();

  const constructs: ConstructPlan[] = [];
  for (const group of GROUP_ORDER) {
    const ids = members.get(group);
    if (!ids || ids.length === 0) continue;
    constructs.push({
      id: `${appId}-${group}`,
      name: `${toPascalCase(app.name)}${toPascalCase(group)}`,
      resourceIds: ids,
      level: 'L2',
      ruleId: group === 'references' ? 'balanced/reference@1' : `balanced/${group}@1`,
      ownership: group === 'references' ? 'reference' : 'recreate',
      stackId,
      evidenceIds: evidenceFor(ids),
      decisionIds: [],
    });
  }
  if (constructs.length === 0) {
    throw new PlanningError(
      'nothing-to-generate',
      `No supported resources are selected for ${app.name}.`,
    );
  }

  const selected = [...new Set([...owned, ...referenced, ...excluded])].sort();
  const questions = computeQuestions(snapshot, 'plan');
  const decisionIds = input.decisions
    .filter((d) => {
      const q = questions.find((x) => x.id === d.questionId);
      return (
        q !== undefined &&
        (used.has(q.id) || q.relatedResourceIds.some((id) => selected.includes(id)))
      );
    })
    .map((d) => d.id)
    .sort();
  for (const construct of constructs) {
    construct.decisionIds = input.decisions
      .filter((d) => {
        const q = questions.find((x) => x.id === d.questionId);
        return (
          q !== undefined && q.relatedResourceIds.some((id) => construct.resourceIds.includes(id))
        );
      })
      .map((d) => d.id)
      .sort();
  }

  const relEvidence = graph.relationships
    .filter((r) => selected.includes(r.from) && selected.includes(r.to))
    .flatMap((r) => r.evidenceIds);

  return {
    schemaVersion: '1',
    snapshotId: snapshot.id,
    applicationId: appId,
    applicationName: app.name,
    producedBy: 'deterministic-planner',
    selectedResourceIds: selected,
    boundaries: {
      owned: [...owned].sort(),
      referenced: [...referenced].sort(),
      excluded: [...excluded].sort(),
    },
    stacks: [
      {
        id: stackId,
        name: `${toPascalCase(app.name)}Stack`,
        constructIds: constructs.map((c) => c.id),
        rationale:
          'All owned resources of the application go into one stack; split stacks later if lifecycles differ. (Deterministic default.)',
        evidenceIds: evidenceFor(selected),
      },
    ],
    constructs,
    generation: { strategy: input.strategy },
    evidenceIds: [...new Set([...evidenceFor(selected), ...relEvidence])].sort(),
    decisionIds,
    assumptions: assumptions.sort((a, b) => a.id.localeCompare(b.id)),
    unresolved: unresolved.sort(
      (a, b) => a.resourceId.localeCompare(b.resourceId) || a.property.localeCompare(b.property),
    ),
  };
}
