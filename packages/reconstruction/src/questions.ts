import {
  EvidenceGraph,
  isStructural,
  shortHash,
  type CloudResource,
  type CloudSnapshot,
  type QuestionPriority,
  type ReconstructionQuestion,
} from '@cloud-to-code/core';
import { slug } from './naming.js';
import { STATEFUL_TYPES } from './supported-types.js';

/**
 * Question detectors. Every question is derived from actual graph uncertainty or a safety constraint; none is
 * a canned prompt. Question IDs depend on the detector and the subject, never on evidence content, so a
 * changed fact reopens the same question (via `subjectHash`) instead of creating a different one.
 */

export interface DetectorContext {
  sessionId: string;
  snapshot: CloudSnapshot;
  graph: EvidenceGraph;
}

type QuestionDraft = Omit<
  ReconstructionQuestion,
  'sessionId' | 'subjectHash' | 'evidenceIds' | 'context'
> & {
  subjectResourceIds: string[];
  subjectExtra?: unknown;
};

export interface Detector {
  id: string;
  detect(ctx: DetectorContext): QuestionDraft[];
}

const PRIORITY_RANK: Record<QuestionPriority, number> = { blocking: 0, important: 1, optional: 2 };

function name(ctx: DetectorContext, id: string): string {
  return ctx.graph.resources.get(id)?.displayName ?? id.split('/').slice(3).join('/');
}

function subjectHash(ctx: DetectorContext, ids: readonly string[], extra: unknown): string {
  const idSet = new Set(ids);
  const resources = [...idSet].sort().map((id) => {
    const r: CloudResource | undefined = ctx.graph.resources.get(id);
    return r ? { id, type: r.type, p: r.observedProperties, tags: r.tags } : { id };
  });
  const relationships = ctx.graph.relationships
    .filter((r) => idSet.has(r.from) || idSet.has(r.to))
    .map((r) => `${r.from}|${r.to}|${r.kind}|${r.confidence}`)
    .sort();
  return shortHash({ resources, relationships, extra });
}

function evidenceFor(ctx: DetectorContext, ids: readonly string[]): string[] {
  const idSet = new Set(ids);
  const out = new Set<string>();
  for (const id of idSet)
    for (const e of ctx.graph.resources.get(id)?.evidenceIds ?? []) out.add(e);
  for (const r of ctx.graph.relationships) {
    if (idSet.has(r.from) && idSet.has(r.to)) for (const e of r.evidenceIds) out.add(e);
  }
  return [...out].sort();
}

const sharedResourceOwnership: Detector = {
  id: 'shared-resource-ownership',
  detect(ctx) {
    const { candidates, shared } = ctx.graph.applicationCandidates();
    return shared.map((s) => {
      const hub = ctx.graph.resources.get(s.resourceId)!;
      const owners = s.candidateIds
        .map((id) => candidates.find((c) => c.id === id)!)
        .filter(Boolean);
      const touching = ctx.graph.relationships
        .filter((r) => isStructural(r) && (r.from === hub.id || r.to === hub.id))
        .map((r) => name(ctx, r.from === hub.id ? r.to : r.from));
      const ownerNames = owners.map((o) => o.name);
      return {
        id: `q-shared-${slug(hub.displayName)}`,
        detector: this.id,
        priority: 'blocking',
        type: 'single-choice',
        title: `Who should own '${hub.displayName}'?`,
        found:
          `'${hub.displayName}' (${hub.type}) is connected to ${owners.length} application candidates ` +
          `(${ownerNames.join(', ')}) through: ${[...new Set(touching)].sort().join(', ')}.`,
        uncertainty:
          'AWS does not record which application owns a shared resource. Ownership cannot be inferred from the connections alone.',
        whyItMatters:
          'The generated stack either manages this resource (and may collide with the existing one) or only references it. Getting it wrong can duplicate, replace or orphan shared infrastructure.',
        effectOfSkipping:
          'Generation is blocked: an unanswered or "I don\'t know" answer stops the session instead of guessing.',
        relatedResourceIds: [hub.id],
        options: [
          {
            id: 'reference',
            label: 'Shared dependency: reference the existing resource (recommended)',
            consequences:
              'Generated code looks the resource up by ARN and does not manage it. Nothing is created or changed.',
          },
          ...owners.map((o) => ({
            id: `own-${o.id}`,
            label: `Include it in ${o.name}`,
            consequences: `The ${o.name} stack defines this resource; other applications reference it. Deploying a new copy may collide with the existing resource.`,
          })),
          {
            id: 'exclude',
            label: 'Exclude it from this reconstruction',
            consequences:
              'No code is generated for it; anything that depends on it is listed as an unresolved reference.',
          },
        ],
        suggestedOptionId: 'reference',
        allowUnknown: true,
        requiredFor: 'generation',
        subjectResourceIds: [hub.id, ...owners.flatMap((o) => o.resourceIds)],
      } satisfies QuestionDraft;
    });
  },
};

const unlinkedLambdaSource: Detector = {
  id: 'unlinked-lambda-source',
  detect(ctx) {
    const { candidates } = ctx.graph.applicationCandidates();
    const drafts: QuestionDraft[] = [];
    for (const c of candidates) {
      const fns = c.resourceIds
        .map((id) => ctx.graph.resources.get(id))
        .filter((r): r is CloudResource => r?.type === 'AWS::Lambda::Function');
      if (fns.length === 0) continue;
      const names = fns.map((f) => f.displayName).sort();
      drafts.push({
        id: `q-lambda-source-${slug(c.name)}`,
        detector: this.id,
        priority: 'important',
        type: 'single-choice',
        title: `Where is the source code for ${c.name}'s Lambda functions?`,
        found: `${fns.length} Lambda function(s) in ${c.name}: ${names.join(', ')}. Only deployed configuration was read; code packages are never downloaded.`,
        uncertainty:
          'Deployed code cannot be turned back into your original repository, so no source location is known.',
        whyItMatters:
          'Generated infrastructure needs a code location. Without one it will take code from explicit deployment parameters instead of guessing.',
        effectOfSkipping:
          'Infrastructure-only generation: each function reads its code bucket/key from CloudFormation parameters you provide at deploy time.',
        relatedResourceIds: fns.map((f) => f.id),
        options: [
          {
            id: 'infra-only',
            label: 'Generate infrastructure only (recommended)',
            consequences:
              'Code comes from deploy-time parameters. Nothing about your repository is touched or assumed.',
          },
          {
            id: 'local-dir',
            label: 'I have a local source directory',
            consequences:
              'The path is recorded (give it in the note) and listed in src/README.md. Automatic source wiring is not implemented yet; code still comes from parameters.',
          },
          {
            id: 'git-repo',
            label: 'I have a Git repository',
            consequences:
              'The URL is recorded (give it in the note) and listed in src/README.md. Nothing is cloned or executed.',
          },
        ],
        suggestedOptionId: 'infra-only',
        allowUnknown: true,
        requiredFor: 'generation',
        subjectResourceIds: fns.map((f) => f.id),
      });
    }
    return drafts;
  },
};

const possibleAccess: Detector = {
  id: 'possible-access',
  detect(ctx) {
    const drafts: QuestionDraft[] = [];
    const seen = new Set<string>();
    for (const rel of ctx.graph.relationships) {
      if (rel.kind !== 'possible-access') continue;
      const target = ctx.graph.resources.get(rel.to);
      if (!target) continue;
      for (const assume of ctx.graph.incoming(rel.from, ['assumes-role'])) {
        const fn = ctx.graph.resources.get(assume.from);
        if (!fn || fn.type !== 'AWS::Lambda::Function') continue;
        if (ctx.graph.directlyConnected(fn.id, target.id)) continue;
        const key = `${fn.id}|${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        drafts.push({
          id: `q-possible-access-${slug(fn.displayName)}-${slug(target.displayName)}`,
          detector: this.id,
          priority: 'important',
          type: 'single-choice',
          title: `Does '${fn.displayName}' actually use '${target.displayName}'?`,
          found: `The IAM role of '${fn.displayName}' allows access to '${target.displayName}', but no integration, event source mapping or other runtime link was found.`,
          uncertainty:
            'IAM permission proves only potential authorization, not that the function reads or writes the resource.',
          whyItMatters:
            'It decides whether the dependency is documented as confirmed and whether permissions should be reviewed for least privilege. IAM statements are never removed automatically.',
          effectOfSkipping:
            'The permission is documented as a possible dependency only; no wiring is generated.',
          relatedResourceIds: [fn.id, rel.from, target.id],
          options: [
            {
              id: 'document-as-possible',
              label: 'Document as a possible dependency (recommended)',
              consequences:
                'Listed in the architecture report as unconfirmed. No code or permission changes.',
            },
            {
              id: 'confirmed-by-source',
              label: 'I have source evidence that it uses it',
              consequences:
                'Recorded as developer-confirmed in the report with your decision as provenance.',
            },
            {
              id: 'not-used',
              label: 'The permission is not used',
              consequences:
                'Flagged for least-privilege review in the migration plan. The IAM statement is still generated unchanged.',
            },
          ],
          suggestedOptionId: 'document-as-possible',
          allowUnknown: true,
          requiredFor: 'adoption',
          subjectResourceIds: [fn.id, rel.from, target.id],
        });
      }
    }
    return drafts;
  },
};

const statefulResources: Detector = {
  id: 'stateful-resources',
  detect(ctx) {
    const { candidates } = ctx.graph.applicationCandidates();
    const drafts: QuestionDraft[] = [];
    for (const c of candidates) {
      const stateful = c.resourceIds
        .map((id) => ctx.graph.resources.get(id))
        .filter((r): r is CloudResource => !!r && STATEFUL_TYPES.has(r.type));
      if (stateful.length === 0) continue;
      const names = stateful.map((r) => `${r.displayName} (${r.type.split('::')[2]})`).sort();
      drafts.push({
        id: `q-stateful-${slug(c.name)}`,
        detector: this.id,
        priority: 'important',
        type: 'single-choice',
        title: `How should ${c.name}'s stateful resources be handled?`,
        found: `${stateful.length} stateful resource(s): ${names.join(', ')}.`,
        uncertainty:
          'Whether you want to create new resources from code or keep using the existing ones with their data.',
        whyItMatters:
          'Recreating makes new, empty resources (existing data is not migrated); referencing leaves the current resources untouched and unmanaged by CDK.',
        effectOfSkipping:
          'Treated as recreate-with-retain (flagged as an unaccepted default assumption); nothing is deployed either way.',
        relatedResourceIds: stateful.map((r) => r.id),
        options: [
          {
            id: 'recreate-retain',
            label: 'Recreate in CDK with retain policy (recommended)',
            consequences:
              'New resources are defined with RemovalPolicy.RETAIN and CDK-generated names to avoid collisions. Existing data is NOT migrated.',
          },
          {
            id: 'reference-existing',
            label: 'Reference the existing resources',
            consequences:
              'CDK looks them up by name/ARN and does not create or manage them. No data risk; no ownership by CloudFormation.',
          },
        ],
        suggestedOptionId: 'recreate-retain',
        allowUnknown: true,
        requiredFor: 'generation',
        subjectResourceIds: stateful.map((r) => r.id),
      });
    }
    return drafts;
  },
};

const outOfScopeReference: Detector = {
  id: 'out-of-scope-reference',
  detect(ctx) {
    const drafts: QuestionDraft[] = [];
    const seen = new Set<string>();
    for (const { relationship, missing } of ctx.graph.unresolvedEndpoints()) {
      if (!isStructural(relationship) || seen.has(missing)) continue;
      seen.add(missing);
      const present = [relationship.from, relationship.to].find((id) => id !== missing)!;
      drafts.push({
        id: `q-out-of-scope-${shortHash(missing, 8)}`,
        detector: this.id,
        priority: 'optional',
        type: 'single-choice',
        title: `A dependency of '${name(ctx, present)}' is outside the discovered scope`,
        found: `'${name(ctx, present)}' is linked (${relationship.kind}) to ${missing}, which is not in the snapshot (different scope, access denied or unsupported).`,
        uncertainty: 'Absence from the snapshot does not mean the resource does not exist.',
        whyItMatters: 'Expanding scope needs a new, explicitly consented discovery run.',
        effectOfSkipping: 'Kept as an unresolved external reference in the reports.',
        relatedResourceIds: [present],
        options: [
          {
            id: 'external-reference',
            label: 'Keep as an external reference (recommended)',
            consequences: 'Listed as unresolved. Nothing is scanned.',
          },
          {
            id: 'expand-scope',
            label: 'I will expand the scope and re-run discovery',
            consequences:
              'Nothing happens now; re-run `c2c discover` with a wider scope, then resume.',
          },
        ],
        suggestedOptionId: 'external-reference',
        allowUnknown: true,
        requiredFor: 'optimization',
        subjectResourceIds: [present],
        subjectExtra: { missing },
      });
    }
    return drafts;
  },
};

export const DETECTORS: readonly Detector[] = [
  sharedResourceOwnership,
  unlinkedLambdaSource,
  statefulResources,
  possibleAccess,
  outOfScopeReference,
];

/** Compute every question the current evidence raises, whether or not already answered. */
export function computeQuestions(
  snapshot: CloudSnapshot,
  sessionId: string,
): ReconstructionQuestion[] {
  const graph = new EvidenceGraph(snapshot);
  const ctx: DetectorContext = { sessionId, snapshot, graph };
  const order = new Map(DETECTORS.map((d, i) => [d.id, i]));
  const questions: ReconstructionQuestion[] = [];
  for (const detector of DETECTORS) {
    for (const draft of detector.detect(ctx)) {
      const { subjectResourceIds, subjectExtra, ...rest } = draft;
      const evidenceIds = evidenceFor(ctx, subjectResourceIds);
      questions.push({
        ...rest,
        sessionId,
        evidenceIds,
        context: `${draft.found} ${draft.uncertainty}`,
        subjectHash: subjectHash(ctx, subjectResourceIds, subjectExtra ?? null),
      });
    }
  }
  return questions.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      (order.get(a.detector) ?? 0) - (order.get(b.detector) ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

export const MAX_QUESTIONS_PER_BATCH = 3;

/** Highest-priority pending questions, at most `limit` (default 3) per batch. */
export function selectBatch(
  pending: readonly ReconstructionQuestion[],
  limit = MAX_QUESTIONS_PER_BATCH,
): ReconstructionQuestion[] {
  return pending.slice(0, limit);
}
