import type { AiProvider, AiRequest, AiResponse } from '../types.js';
import { AiProviderError } from '../types.js';
import { postJson, type FetchLike } from './http.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Ollama-compatible endpoint. Local hosts keep data on this machine and need no external-model consent. */
export function createOllamaProvider(options: {
  model: string;
  endpoint?: string;
  fetch?: FetchLike;
}): AiProvider {
  const endpoint = (options.endpoint ?? 'http://localhost:11434').replace(/\/$/, '');
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const host = new URL(endpoint).hostname;
  return {
    id: 'ollama',
    model: options.model,
    destination: { provider: 'Ollama-compatible endpoint', endpoint, local: LOCAL_HOSTS.has(host) },
    async complete(request: AiRequest): Promise<AiResponse> {
      const data = (await postJson(
        fetchImpl,
        `${endpoint}/api/chat`,
        {},
        {
          model: options.model,
          stream: false,
          options: { num_predict: request.maxTokens ?? 4096 },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        },
        request.signal,
      )) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
      const text = data.message?.content;
      if (!text) throw new AiProviderError('The Ollama endpoint returned no text.');
      return {
        text,
        usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      };
    },
  };
}
