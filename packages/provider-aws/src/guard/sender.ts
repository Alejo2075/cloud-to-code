import { ForbiddenAwsOperationError, isAllowed, type ServiceKey } from './allowlist.js';

/** Anything with an SDK-style `send`, e.g. a LambdaClient. */
export interface RawSender {
  send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/** What collectors use. Commands are checked against the allowlist before they can leave the process. */
export interface Sender {
  send<T>(command: object, options?: { abortSignal?: AbortSignal }): Promise<T>;
}

export function guardSender(service: ServiceKey, raw: RawSender): Sender {
  return {
    async send<T>(command: object, options?: { abortSignal?: AbortSignal }): Promise<T> {
      const name = command.constructor?.name ?? '';
      if (!isAllowed(service, name))
        throw new ForbiddenAwsOperationError(service, name || '(unknown)');
      return (await raw.send(command, options)) as T;
    },
  };
}

export type SenderFactory = (service: ServiceKey, region: string) => Sender;
