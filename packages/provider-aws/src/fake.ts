import { guardSender, type RawSender, type SenderFactory } from './guard/sender.js';
import type { ServiceKey } from './guard/allowlist.js';

export interface RecordedCall {
  service: ServiceKey;
  region: string;
  command: string;
  input: unknown;
}

export type Handler = (input: any, region: string) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * In-memory AWS for tests (no network, no credentials). Handlers are keyed by SDK command class name; calling a
 * command without a handler fails loudly, so tests also prove nothing unexpected is requested. The returned
 * factory still applies the real read-only allowlist guard.
 */
export function fakeSenderFactory(
  handlers: Record<string, Handler>,
  calls: RecordedCall[] = [],
): SenderFactory {
  return (service, region) => {
    const raw: RawSender = {
      async send(command) {
        const name = command.constructor.name;
        calls.push({
          service,
          region,
          command: name,
          input: (command as { input?: unknown }).input,
        });
        const handler = handlers[name];
        if (!handler) throw new Error(`fake AWS: no handler for ${name}`);
        return handler((command as { input?: unknown }).input ?? {}, region);
      },
    };
    return guardSender(service, raw);
  };
}

export function awsError(
  name: string,
  message = name,
  status?: number,
): Error & { $metadata?: { httpStatusCode?: number } } {
  const error = new Error(message) as Error & { $metadata?: { httpStatusCode?: number } };
  error.name = name;
  if (status) error.$metadata = { httpStatusCode: status };
  return error;
}
