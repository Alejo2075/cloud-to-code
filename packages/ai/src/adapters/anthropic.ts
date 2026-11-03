import type { AiProvider, AiRequest, AiResponse } from '../types.js';
import { AiProviderError } from '../types.js';
import { postJson, requireEnv, type FetchLike } from './http.js';

export function createAnthropicProvider(options: {
  model: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  baseUrl?: string;
}): AiProvider {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
  return {
    id: 'anthropic',
    model: options.model,
    destination: { provider: 'Anthropic API', endpoint: baseUrl, local: false },
    async complete(request: AiRequest): Promise<AiResponse> {
      const key = requireEnv(env, 'ANTHROPIC_API_KEY', 'The Anthropic provider');
      const data = (await postJson(
        fetchImpl,
        `${baseUrl}/v1/messages`,
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        {
          model: options.model,
          max_tokens: request.maxTokens ?? 4096,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        },
        request.signal,
      )) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (!text) throw new AiProviderError('Anthropic returned no text.');
      return {
        text,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}
