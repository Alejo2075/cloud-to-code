import {
  ConsentRequiredError,
  assertConsent,
  buildModelContext,
  createAnthropicProvider,
  createBedrockProvider,
  createOllamaProvider,
  createOpenAiProvider,
  grantConsent,
  interpretArchitecture,
  proposePlan,
  type AiProvider,
} from '@cloud-to-code/ai';
import type { CloudSnapshot, DeveloperDecision, ReconstructionPlan } from '@cloud-to-code/core';
import { loadConfig, saveConfig, type Config } from '../config.js';
import { emit, note, resolveSnapshot, type Context, type SourceOptions } from '../context.js';
import { CliError, ExitCode } from '../exit-codes.js';

/** Build the configured provider. Models are never assumed: the user must have chosen one. */
export function buildProvider(ctx: Context, config: Config): AiProvider {
  if (ctx.io.aiProvider) return ctx.io.aiProvider;
  const { provider, model, region, endpoint, awsProfile } = config.ai;
  if (!provider || !model) {
    throw new CliError(
      'No AI provider is configured. Deterministic workflows keep working; conversational AI help is unavailable until you run `c2c ai connect --provider <bedrock|anthropic|openai|ollama> --model <id>`.',
      ExitCode.USAGE,
      'ai-not-configured',
    );
  }
  switch (provider) {
    case 'anthropic':
      return createAnthropicProvider({ model, env: ctx.io.env });
    case 'openai':
      return createOpenAiProvider({ model, env: ctx.io.env });
    case 'ollama':
      return createOllamaProvider({ model, ...(endpoint ? { endpoint } : {}) });
    case 'bedrock':
      return createBedrockProvider({
        model,
        region: region ?? config.aws.regions[0] ?? 'us-east-1',
        ...((awsProfile ?? config.aws.profile)
          ? { profile: (awsProfile ?? config.aws.profile)! }
          : {}),
      });
  }
}

export function runAiConnect(
  ctx: Context,
  options: {
    provider?: string;
    model?: string;
    endpoint?: string;
    region?: string;
    awsProfile?: string;
  },
): number {
  if (!options.provider || !options.model) {
    throw new CliError(
      'Usage: c2c ai connect --provider <bedrock|anthropic|openai|ollama> --model <model or inference profile id>. The model is never assumed.',
      ExitCode.USAGE,
      'usage',
    );
  }
  const config = loadConfig(ctx.io.env);
  const next: Config = {
    ...config,
    ai: {
      provider: options.provider as never,
      model: options.model,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.region ? { region: options.region } : {}),
      ...(options.awsProfile ? { awsProfile: options.awsProfile } : {}),
    },
  };
  let path: string;
  try {
    path = saveConfig(ctx.io.env, next);
  } catch (error) {
    throw new CliError(`Invalid AI settings: ${(error as Error).message}`, ExitCode.USAGE, 'usage');
  }
  const keyVar = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }[options.provider];
  emit(
    ctx,
    { status: 'OK', exitCode: 0, path, ai: next.ai },
    [
      `Saved ${path}`,
      keyVar
        ? `Set ${keyVar} in your environment (it is never stored by Cloud to Code).`
        : options.provider === 'bedrock'
          ? 'Bedrock uses your AWS credential chain.'
          : 'Ollama needs no key.',
      'Verify with: c2c ai test',
    ].join('\n'),
  );
  return ExitCode.OK;
}

/** Connectivity check with a fixed prompt. No inventory data is sent. */
export async function runAiTest(ctx: Context): Promise<number> {
  const provider = buildProvider(ctx, loadConfig(ctx.io.env));
  note(
    ctx,
    `Testing ${provider.destination.provider} (${provider.model}) at ${provider.destination.endpoint}; the test prompt contains no inventory data.`,
  );
  try {
    const res = await provider.complete({
      system: 'You are a connectivity check.',
      user: 'Reply with the single word: ok',
      maxTokens: 16,
    });
    emit(
      ctx,
      {
        status: 'OK',
        exitCode: 0,
        provider: provider.id,
        model: provider.model,
        destination: provider.destination,
        usage: res.usage,
      },
      `OK: ${provider.destination.provider} answered (${res.usage.inputTokens}+${res.usage.outputTokens} tokens).`,
    );
    return ExitCode.OK;
  } catch (error) {
    throw new CliError(
      `AI test failed: ${(error as Error).message}`,
      ExitCode.FAILED,
      'ai-test-failed',
    );
  }
}

/** Show exactly what would be sent to a model, without sending anything. */
export function runAiPreview(
  ctx: Context,
  options: SourceOptions & { showData?: boolean },
): number {
  const loaded = resolveSnapshot(ctx, options);
  const config = loadConfig(ctx.io.env);
  const context = buildModelContext(loaded.snapshot);
  const dest = config.ai.provider
    ? `${config.ai.provider} (${config.ai.model ?? 'no model'})`
    : 'no provider configured';
  emit(
    ctx,
    {
      status: 'OK',
      exitCode: 0,
      destination: dest,
      bytes: context.bytes,
      hash: context.hash,
      resourceCount: context.resourceCount,
      included: context.included,
      excluded: context.excluded,
      ...(options.showData ? { data: context.text } : {}),
    },
    [
      `Nothing is sent by this command. Destination if you enable AI: ${dest}`,
      `${context.resourceCount} resources, ${context.bytes} bytes, digest ${context.hash}`,
      '',
      'Would be included:',
      ...context.included.map((i) => `  + ${i}`),
      'Never included:',
      ...context.excluded.map((e) => `  - ${e}`),
      options.showData ? `\n${context.text}` : '\nAdd --show-data to print the exact payload.',
    ].join('\n'),
  );
  return ExitCode.OK;
}

export interface AiAdvice {
  markdown: string;
  summary: string;
}

/**
 * Advisory AI step. Requires consent for external providers. Failures never touch the snapshot, decisions or the
 * deterministic plan; the result is documentation of unverified hypotheses.
 */
export async function runAiAdvice(
  ctx: Context,
  snapshot: CloudSnapshot,
  plan: ReconstructionPlan,
  decisions: readonly DeveloperDecision[],
  options: { allowExternalModel?: boolean },
): Promise<AiAdvice | undefined> {
  const config = loadConfig(ctx.io.env);
  const provider = buildProvider(ctx, config);
  const context = buildModelContext(snapshot, plan.selectedResourceIds);
  let consent = options.allowExternalModel
    ? grantConsent(provider, context, 'explicit-flag')
    : undefined;
  if (!provider.destination.local && config.privacy.externalModelContext === 'never') {
    throw new CliError(
      'Your privacy setting forbids sending inventory to an external model.',
      ExitCode.CONSENT_REQUIRED,
      'consent-blocked',
    );
  }
  if (!consent && !provider.destination.local && ctx.interactive && ctx.io.prompter) {
    note(
      ctx,
      `AI step would send ${context.resourceCount} resources (${context.bytes} bytes) to ${provider.destination.provider} at ${provider.destination.endpoint}.\nIncluded: ${context.included.join('; ')}\nNever included: ${context.excluded.join('; ')}`,
    );
    if (await ctx.io.prompter.confirm('Send this to the external model?'))
      consent = grantConsent(provider, context, 'interactive-user');
  }
  try {
    assertConsent(provider, context, consent, config.privacy.externalModelContext);
  } catch (error) {
    if (error instanceof ConsentRequiredError) {
      throw new CliError(
        `${error.message} Re-run with --allow-external-model after reviewing \`c2c ai preview\`, or answer the prompt.`,
        ExitCode.CONSENT_REQUIRED,
        'consent-required',
      );
    }
    throw error;
  }
  try {
    const { interpretation, usage } = await interpretArchitecture({
      provider,
      snapshot,
      resourceIds: plan.selectedResourceIds,
      consent,
    });
    const proposal = await proposePlan({
      provider,
      snapshot,
      resourceIds: plan.selectedResourceIds,
      consent,
      decisions,
      blockingUnresolved: [],
    });
    const verdict = proposal.accepted
      ? 'A model-proposed plan passed deterministic verification (it is NOT used; generation always uses the deterministic plan).'
      : `The model's plan proposals were rejected by the verifier (${
          proposal.rejections
            .flat()
            .map((i) => i.code)
            .filter((c, i, a) => a.indexOf(c) === i)
            .join(', ') || 'no valid output'
        }). The deterministic plan is used.`;
    const tokens =
      usage.inputTokens +
      usage.outputTokens +
      proposal.usage.inputTokens +
      proposal.usage.outputTokens;
    const markdown = [
      '# AI interpretation (unverified hypotheses)',
      '',
      `> Produced by ${provider.destination.provider} (${provider.model}). **Nothing here is evidence.** It never changes ownership, the plan or the generated code. ${interpretation.dropped} reference(s) to nonexistent resources were dropped.`,
      '',
      interpretation.summary,
      '',
      '## Component purposes',
      ...interpretation.components.map(
        (c) => `- \`${c.resourceId.split('/').slice(3).join('/')}\`: ${c.purpose}`,
      ),
      '',
      '## Possible risks',
      ...(interpretation.risks.length
        ? interpretation.risks.map((r) => `- ${r}`)
        : ['- none suggested']),
      '',
      '## Questions the model would ask (not asked automatically)',
      ...(interpretation.suggestedQuestions.length
        ? interpretation.suggestedQuestions.map((q) => `- ${q.title} - ${q.why}`)
        : ['- none']),
      '',
      '## Plan proposal',
      verdict,
      '',
      `Tokens used: ${tokens}`,
      '',
    ].join('\n');
    return { markdown, summary: `AI advice recorded (${tokens} tokens). ${verdict}` };
  } catch (error) {
    note(
      ctx,
      `warning: the AI step failed (${(error as Error).message}). Your snapshot, decisions and deterministic plan are untouched.`,
    );
    return undefined;
  }
}
