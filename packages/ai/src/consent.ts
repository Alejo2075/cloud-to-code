import type { ModelContext } from './context.js';
import type { AiProvider, Destination } from './types.js';

export type ExternalModelPolicy = 'ask-first' | 'never';

export interface ConsentRecord {
  providerId: string;
  model: string;
  destination: Destination;
  /** Hash of the exact context that was previewed and approved. */
  contextHash: string;
  grantedAt: string;
  source: 'interactive-user' | 'explicit-flag';
}

export class ConsentRequiredError extends Error {
  constructor(
    readonly provider: AiProvider,
    readonly context: ModelContext,
    readonly reason: 'missing' | 'stale' | 'blocked-by-policy',
  ) {
    super(
      reason === 'blocked-by-policy'
        ? `Your privacy setting is "never send inventory to an external model"; ${provider.destination.provider} is external.`
        : `Sending ${context.bytes} bytes (${context.resourceCount} resources) to ${provider.destination.provider} at ${provider.destination.endpoint} needs your explicit consent${reason === 'stale' ? ' (the data changed since you approved it)' : ''}.`,
    );
    this.name = 'ConsentRequiredError';
  }
}

export function grantConsent(
  provider: AiProvider,
  context: ModelContext,
  source: ConsentRecord['source'],
  now = new Date(),
): ConsentRecord {
  return {
    providerId: provider.id,
    model: provider.model,
    destination: provider.destination,
    contextHash: context.hash,
    grantedAt: now.toISOString(),
    source,
  };
}

/**
 * Gate for every call that carries inventory data. Local destinations keep data on this machine. External ones
 * need a consent record for this provider, endpoint AND exact context; otherwise nothing is sent.
 */
export function assertConsent(
  provider: AiProvider,
  context: ModelContext,
  consent: ConsentRecord | undefined,
  policy: ExternalModelPolicy = 'ask-first',
): void {
  if (provider.destination.local) return;
  if (policy === 'never') throw new ConsentRequiredError(provider, context, 'blocked-by-policy');
  if (
    !consent ||
    consent.providerId !== provider.id ||
    consent.destination.endpoint !== provider.destination.endpoint ||
    consent.model !== provider.model
  ) {
    throw new ConsentRequiredError(provider, context, 'missing');
  }
  if (consent.contextHash !== context.hash)
    throw new ConsentRequiredError(provider, context, 'stale');
}
