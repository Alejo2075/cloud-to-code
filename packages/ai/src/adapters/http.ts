import { redactSecrets } from '@cloud-to-code/core';
import { AiProviderError } from '../types.js';

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** POST JSON and return parsed JSON. Error bodies are redacted and truncated; API keys are never echoed. */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new AiProviderError(
      `Could not reach ${new URL(url).host}: ${redactSecrets((error as Error).message).text}`,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new AiProviderError(
      `${new URL(url).host} returned HTTP ${response.status}: ${redactSecrets(text).text.slice(0, 300)}`,
      response.status,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiProviderError(
      `${new URL(url).host} returned a non-JSON response.`,
      response.status,
    );
  }
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string, provider: string): string {
  const value = env[name];
  if (!value)
    throw new AiProviderError(
      `${provider} needs the ${name} environment variable. Cloud to Code never stores API keys.`,
    );
  return value;
}
