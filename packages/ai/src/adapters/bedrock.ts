import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AiProvider, AiRequest, AiResponse } from '../types.js';
import { AiProviderError } from '../types.js';

export interface BedrockSender {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
}

/**
 * Amazon Bedrock via the Converse API with the standard AWS credential chain (profile/SSO/role). The model ID or
 * inference profile must be chosen by the user; it is never assumed. Data goes to the Bedrock endpoint in `region`.
 */
export function createBedrockProvider(options: {
  model: string;
  region: string;
  profile?: string;
  client?: BedrockSender;
}): AiProvider {
  const client: BedrockSender =
    options.client ??
    new BedrockRuntimeClient({
      region: options.region,
      credentials: fromNodeProviderChain(options.profile ? { profile: options.profile } : {}),
    });
  return {
    id: 'bedrock',
    model: options.model,
    destination: {
      provider: 'Amazon Bedrock',
      endpoint: `bedrock-runtime.${options.region}.amazonaws.com`,
      local: false,
    },
    async complete(request: AiRequest): Promise<AiResponse> {
      let out: ConverseCommandOutput;
      try {
        out = await client.send(
          new ConverseCommand({
            modelId: options.model,
            system: [{ text: request.system }],
            messages: [{ role: 'user', content: [{ text: request.user }] }],
            inferenceConfig: { maxTokens: request.maxTokens ?? 4096 },
          }),
          request.signal ? { abortSignal: request.signal } : undefined,
        );
      } catch (error) {
        throw new AiProviderError(
          `Bedrock request failed: ${(error as Error).message.slice(0, 300)}`,
        );
      }
      const text = (out.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
      if (!text) throw new AiProviderError('Bedrock returned no text.');
      return {
        text,
        usage: {
          inputTokens: out.usage?.inputTokens ?? 0,
          outputTokens: out.usage?.outputTokens ?? 0,
        },
      };
    },
  };
}
