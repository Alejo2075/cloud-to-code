import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AnswerSchema,
  EvidenceGraph,
  UnsupportedSchemaVersionError,
  type ReconstructionPlan,
} from '@cloud-to-code/core';
import { renderMermaid } from '@cloud-to-code/diagram-mermaid';
import { GenerationError, generateForSession } from '@cloud-to-code/generator-cdk';
import {
  createSenderFactory,
  discover,
  ScopeError,
  type SenderFactory,
} from '@cloud-to-code/provider-aws';
import {
  PlanningError,
  ReconstructionService,
  WorkspaceError,
  WorkspaceStore,
  applicationIdFor,
  inspectSnapshot,
  selectApplication,
  verifyPlan,
} from '@cloud-to-code/reconstruction';
import { adoptionPlan, validateProject } from '@cloud-to-code/validator';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolError, confine } from './paths.js';

export interface ServerOptions {
  /** Directory holding the `.c2c` workspace. All file arguments are confined to it. */
  workspaceDir: string;
  /** Test seam replacing the real AWS clients. */
  senderFor?: SenderFactory;
  version?: string;
}

/** The complete tool surface. There is deliberately no deploy, import, delete, bootstrap or shell tool. */
export const TOOL_NAMES = [
  'aws_discover',
  'inspect_application',
  'start_reconstruction',
  'get_pending_questions',
  'submit_decisions',
  'submit_reconstruction_plan',
  'generate_cdk',
  'validate_cdk',
  'get_migration_plan',
] as const;

type Result = { status: string; [key: string]: unknown };

function ok(value: Result) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}) {
  const value = { status: 'FAILED', error: { code, message }, ...extra };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function describeError(error: unknown) {
  if (error instanceof ToolError) return fail(error.code, error.message);
  if (error instanceof ScopeError) return fail(error.code, error.message);
  if (error instanceof PlanningError) return fail(error.code, error.message);
  if (error instanceof GenerationError) return fail(error.code, error.message);
  if (error instanceof WorkspaceError) return fail('workspace-error', error.message);
  if (error instanceof UnsupportedSchemaVersionError)
    return fail('unsupported-schema-version', error.message);
  return fail('error', error instanceof Error ? error.message : String(error));
}

const PAGE = 100;

export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: 'cloud-to-code', version: options.version ?? '0.1.0' });
  const store = new WorkspaceStore(options.workspaceDir);
  const service = new ReconstructionService(store);
  const senderOverride = options.senderFor;
  const inWorkspace = (path: string, what: string) => confine(options.workspaceDir, path, what);

  /** Register a tool whose failures become structured error results instead of protocol errors. */
  const tool = <S extends z.ZodRawShape>(
    name: (typeof TOOL_NAMES)[number],
    config: {
      title: string;
      description: string;
      inputSchema: S;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    },
    handler: (
      args: z.infer<z.ZodObject<S>>,
    ) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>,
  ) => {
    // The SDK's callback type is generic over the schema; arguments are validated by it before we get here.
    const callback = async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return await handler(args);
      } catch (error) {
        return describeError(error);
      }
    };
    server.registerTool(name, config, callback as never);
  };

  const snapshotFor = (args: {
    snapshotId?: string | undefined;
    sessionId?: string | undefined;
  }) => {
    if (args.sessionId) return store.loadSnapshot(args.sessionId);
    if (args.snapshotId) return store.loadSnapshotFile(args.snapshotId);
    throw new ToolError('missing-argument', 'Provide snapshotId or sessionId.');
  };

  tool(
    'aws_discover',
    {
      title: 'Discover AWS resources (read-only)',
      description:
        'Read scoped AWS metadata and store a sanitized snapshot. Read-only: only List/Get/Describe calls from a fixed allowlist; never code, data, secrets or environment values. Confirm the account and regions with the user first; the credentials must belong to `account`. Returns a snapshotId for later tools.',
      inputSchema: {
        account: z
          .string()
          .regex(/^\d{12}$/)
          .describe('12-digit AWS account ID the user confirmed'),
        regions: z
          .array(z.string())
          .min(1)
          .describe('Regions to read; there is no implicit all-regions scan'),
        services: z.array(z.string()).optional().describe('Services (default: all supported)'),
        profile: z
          .string()
          .optional()
          .describe('AWS profile name (credentials are never accepted as arguments)'),
        roleArn: z.string().optional().describe('Role to assume'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (a) => {
      const senderFor =
        senderOverride ??
        createSenderFactory({
          ...(a.profile ? { profile: a.profile } : {}),
          ...(a.roleArn ? { roleArn: a.roleArn } : {}),
        });
      const result = await discover({
        scope: {
          accountIds: [a.account],
          regions: a.regions,
          services: a.services ?? [
            ...(await import('@cloud-to-code/provider-aws')).SUPPORTED_SERVICES,
          ],
        },
        senderFor,
      });
      store.saveSnapshotFile(result.snapshot);
      const report = inspectSnapshot(result.snapshot);
      return ok({
        status: 'OK',
        snapshotId: result.snapshot.id,
        caller: result.caller,
        resourceCounts: report.resourceCounts,
        candidates: report.candidates.map((c) => ({
          application: applicationIdFor(c.name),
          resources: c.resourceIds.length,
          shares: c.sharedResourceIds,
        })),
        diagnostics: result.snapshot.diagnostics.filter((d) => d.severity !== 'info'),
        questionSummary: report.questionSummary,
        note: 'No AWS resources were created, changed or deleted.',
      });
    },
  );

  tool(
    'inspect_application',
    {
      title: 'Inspect topology, evidence and uncertainty',
      description:
        'Return the resource graph, candidate application boundaries, shared resources, relationships with confidence levels, diagnostics and limitations for a snapshot or session. Paginated.',
      inputSchema: {
        snapshotId: z.string().optional(),
        sessionId: z.string().optional(),
        application: z.string().optional().describe('Only this application candidate'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        includeDiagram: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) => {
      const snapshot = snapshotFor(a);
      const report = inspectSnapshot(snapshot);
      let { candidates, shared } = report;
      if (a.application) {
        const wanted = a.application.toLowerCase();
        candidates = candidates.filter(
          (c) => applicationIdFor(c.name) === wanted || c.id === wanted,
        );
        if (candidates.length === 0)
          throw new ToolError(
            'application-not-found',
            `No application "${a.application}". Candidates: ${report.candidates.map((c) => applicationIdFor(c.name)).join(', ')}.`,
          );
        shared = shared.filter((s) => candidates[0]!.sharedResourceIds.includes(s.resourceId));
      }
      const offset = a.offset ?? 0;
      const limit = a.limit ?? PAGE;
      return ok({
        status: 'OK',
        snapshotId: report.snapshotId,
        scope: report.scope,
        resourceCounts: report.resourceCounts,
        candidates: candidates.map((c) => ({ application: applicationIdFor(c.name), ...c })),
        shared,
        resources: {
          total: report.resources.length,
          offset,
          items: report.resources.slice(offset, offset + limit),
        },
        relationships: {
          total: report.relationships.length,
          offset,
          items: report.relationships.slice(offset, offset + limit),
        },
        diagnostics: report.diagnostics,
        unresolvedEndpoints: report.unresolvedEndpoints.length,
        questionSummary: report.questionSummary,
        limitations: report.limitations,
        ...(a.includeDiagram ? { mermaid: renderMermaid(snapshot) } : {}),
      });
    },
  );

  tool(
    'start_reconstruction',
    {
      title: 'Start a resumable reconstruction session',
      description:
        'Create a local session for one application candidate and return the first pending questions. Ask these questions to the user in conversation; never answer them yourself.',
      inputSchema: {
        snapshotId: z.string(),
        application: z
          .string()
          .optional()
          .describe('Application candidate (required when several exist)'),
        strategy: z.enum(['balanced']).optional().describe('Only "balanced" is implemented'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (a) => {
      const snapshot = store.loadSnapshotFile(a.snapshotId);
      // Never guess between several candidates: the host must pick one (with the user).
      const app = selectApplication(new EvidenceGraph(snapshot), a.application);
      const session = service.startSession(snapshot, {
        strategy: a.strategy ?? 'balanced',
        applicationId: applicationIdFor(app.name),
      });
      const pending = service.pending(session.id);
      return ok({
        status: pending.status.blocking.length > 0 ? 'NEEDS_INPUT' : 'OK',
        sessionId: session.id,
        session: pending.status,
        questions: pending.questions,
        remaining: pending.remaining,
      });
    },
  );

  tool(
    'get_pending_questions',
    {
      title: 'Get pending questions',
      description:
        'Structured unresolved questions (what was found, what is uncertain, why it matters, options with consequences, recommended safe option, effect of skipping). Present them to the user and wait for their answer.',
      inputSchema: { sessionId: z.string(), all: z.boolean().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) => {
      const pending = service.resume(a.sessionId);
      const again = a.all ? service.pending(a.sessionId, { all: true }) : pending;
      return ok({
        status:
          again.status.blocking.length > 0
            ? 'NEEDS_INPUT'
            : again.status.state === 'BLOCKED'
              ? 'BLOCKED'
              : 'OK',
        session: again.status,
        questions: again.questions,
        remaining: again.remaining,
        reopened: again.reopened.map((q) => q.id),
      });
    },
  );

  tool(
    'submit_decisions',
    {
      title: "Record the user's decisions",
      description:
        'Validate and record answers THE USER gave to pending questions. Never invent, assume or pre-fill answers, and never choose "recommended" options on the user\'s behalf without their say-so. Invalid options are rejected.',
      inputSchema: {
        sessionId: z.string(),
        decisions: z
          .array(z.object({ questionId: z.string(), answer: AnswerSchema }))
          .min(1)
          .max(20),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (a) => {
      const result = service.submit(a.sessionId, a.decisions, 'agent-host-user');
      const pending = service.pending(a.sessionId);
      return ok({
        status:
          result.rejected.length > 0
            ? 'FAILED'
            : pending.status.state === 'BLOCKED'
              ? 'BLOCKED'
              : pending.status.blocking.length > 0
                ? 'NEEDS_INPUT'
                : 'OK',
        accepted: result.accepted.map((d) => ({ id: d.id, questionId: d.questionId })),
        rejected: result.rejected,
        session: pending.status,
        nextQuestions: pending.questions,
      });
    },
  );

  tool(
    'submit_reconstruction_plan',
    {
      title: 'Validate and store a reconstruction plan',
      description:
        'Submit a plan you proposed (producedBy "agent-host") for deterministic verification against the evidence and the user\'s decisions, or omit `plan` to use the deterministic planner. Nonexistent resources, invented evidence/decisions, ambiguous ownership, secrets and unresolved blocking questions are rejected. Show the accepted plan to the user before generating.',
      inputSchema: { sessionId: z.string(), plan: z.record(z.string(), z.unknown()).optional() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) => {
      const status = service.status(a.sessionId);
      let plan: ReconstructionPlan | undefined;
      let issues;
      if (a.plan) {
        if (a.plan['producedBy'] !== 'agent-host')
          throw new ToolError(
            'invalid-plan-origin',
            'Submitted plans must set producedBy to "agent-host".',
          );
        issues = verifyPlan(a.plan, {
          snapshot: store.loadSnapshot(a.sessionId),
          decisions: service.currentDecisions(a.sessionId),
          blockingUnresolved: status.blocking,
          sessionId: a.sessionId,
        });
        if (!issues.some((i) => i.severity === 'error')) {
          plan = a.plan as unknown as ReconstructionPlan;
          store.savePlan(a.sessionId, plan);
          service.setState(a.sessionId, 'PLANNING');
          service.setState(a.sessionId, 'READY_FOR_REVIEW');
        }
      } else {
        const planned = service.plan(a.sessionId);
        plan = planned.plan;
        issues = planned.issues;
      }
      const pending = service.pending(a.sessionId);
      return ok({
        status: plan
          ? 'OK'
          : pending.status.state === 'BLOCKED'
            ? 'BLOCKED'
            : pending.status.blocking.length > 0
              ? 'NEEDS_INPUT'
              : 'FAILED',
        accepted: plan !== undefined,
        issues,
        session: pending.status,
        ...(plan ? { plan } : { questions: pending.questions }),
      });
    },
  );

  tool(
    'generate_cdk',
    {
      title: 'Generate the CDK project locally',
      description:
        'Generate a TypeScript CDK app from the verified plan into a NEW directory inside the workspace. Refuses non-empty directories unless `overwrite` is true, which you may only set after the user explicitly agreed to replace files. Never deploys, bootstraps or imports anything.',
      inputSchema: {
        sessionId: z.string(),
        outputDir: z.string().describe('Relative path inside the workspace'),
        overwrite: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (a) => {
      const output = inWorkspace(a.outputDir, 'outputDir');
      let validation;
      const result = await generateForSession({
        service,
        sessionId: a.sessionId,
        output,
        overwrite: a.overwrite === true,
        validate: async (dir) => {
          validation = await validateProject(dir, { typecheck: false });
          return { failed: validation.summary === 'failed' };
        },
      });
      if (!result.ok) {
        const pending = service.pending(a.sessionId);
        return ok({
          status:
            result.status.state === 'BLOCKED'
              ? 'BLOCKED'
              : result.status.blocking.length > 0
                ? 'NEEDS_INPUT'
                : 'FAILED',
          issues: result.issues,
          session: result.status,
          questions: pending.questions,
        });
      }
      return ok({
        status: result.validationFailed ? 'FAILED' : 'OK',
        outputDir: a.outputDir,
        files: result.written,
        unresolved: result.project.unresolved,
        validation,
        session: result.status,
        next: 'Run `npm install`, `npm test` and `npx cdk synth` in the project. Synthesis does not prove equivalence or safe adoption; read reports/migration-plan.md. No AWS resources were modified.',
      });
    },
  );

  tool(
    'validate_cdk',
    {
      title: 'Validate a generated project offline',
      description:
        'Check structure, manifest integrity, coverage gaps and (optionally) typecheck and `cdk synth`. Synth executes the project code with credentials withheld and only runs when the files match the generated manifest. Passing never proves equivalence or safe adoption.',
      inputSchema: {
        directory: z.string(),
        typecheck: z.boolean().optional(),
        synth: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (a) => {
      const report = await validateProject(inWorkspace(a.directory, 'directory'), {
        typecheck: a.typecheck !== false,
        synth: a.synth === true,
      });
      return ok({ status: report.summary === 'failed' ? 'FAILED' : 'OK', report });
    },
  );

  tool(
    'get_migration_plan',
    {
      title: 'Advisory migration and adoption analysis',
      description:
        'Describe what recreating, referencing or adopting the existing resources involves, from the reports of a generated project. Advisory only: nothing is imported or deployed.',
      inputSchema: { directory: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) => {
      const dir = inWorkspace(a.directory, 'directory');
      const plan = adoptionPlan(dir);
      const file = join(dir, 'reports', 'migration-plan.md');
      return ok({
        status: 'OK',
        plan,
        migrationPlanMarkdown: existsSync(file)
          ? readFileSync(file, 'utf8').slice(0, 20_000)
          : undefined,
      });
    },
  );

  // Large read-only artifacts are exposed as resources instead of inflating tool responses.
  const text = (uri: URL, body: unknown) => ({
    contents: [
      { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) },
    ],
  });
  const idOf = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0]! : (v ?? ''));
  server.registerResource(
    'snapshot',
    new ResourceTemplate('c2c://snapshots/{id}', { list: undefined }),
    { title: 'Sanitized snapshot', mimeType: 'application/json' },
    (uri, vars) => text(uri, store.loadSnapshotFile(idOf(vars['id']))),
  );
  server.registerResource(
    'session-plan',
    new ResourceTemplate('c2c://sessions/{id}/plan', { list: undefined }),
    { title: 'Reconstruction plan', mimeType: 'application/json' },
    (uri, vars) => text(uri, store.loadPlan(idOf(vars['id'])) ?? null),
  );
  server.registerResource(
    'session-decisions',
    new ResourceTemplate('c2c://sessions/{id}/decisions', { list: undefined }),
    { title: 'Decision history', mimeType: 'application/json' },
    (uri, vars) => text(uri, service.decisions(idOf(vars['id']))),
  );

  return server;
}
