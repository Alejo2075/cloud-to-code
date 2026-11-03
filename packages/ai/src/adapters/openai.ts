import type { AiProvider, AiRequest, AiResponse } from '../types.js';
import { AiProviderError } from '../types.js';
import { postJson, requireEnv, type FetchLike } from './http.js';

/** OpenAI Chat Completions (also works with compatible endpoints via `baseUrl`). */
export function createOpenAiProvider(options: {
  model: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  baseUrl?: string;
}): AiProvider {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const baseUrl = options.baseUrl ?? 'https://api.openai.com';
  return {
    id: 'openai',
    model: options.model,
    destination: { provider: 'OpenAI API', endpoint: baseUrl, local: false },
    async complete(request: AiRequest): Promise<AiResponse> {
      const key = requireEnv(env, 'OPENAI_API_KEY', 'The OpenAI provider');
      const data = (await postJson(
        fetchImpl,
        `${baseUrl}/v1/chat/completions`,
        { authorization: `Bearer ${key}` },
        {
          model: options.model,
          max_completion_tokens: request.maxTokens ?? 4096,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        },
        request.signal,
      )) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new AiProviderError('OpenAI returned no text.');
      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
