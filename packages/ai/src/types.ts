export interface Destination {
  provider: string;
  /** Human-readable endpoint shown in the consent prompt. */
  endpoint: string;
  /** True when data stays on this machine (for example a local Ollama server). */
  local: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiRequest {
  system: string;
  user: string;
  maxTokens?: number;
  signal?: AbortSignal | undefined;
}

export interface AiResponse {
  text: string;
  usage: Usage;
}

/** A model provider. Its output is an untrusted proposal; it is never executed or applied directly. */
export interface AiProvider {
  readonly id: string;
  readonly model: string;
  readonly destination: Destination;
  complete(request: AiRequest): Promise<AiResponse>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export class AiOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly usage: Usage,
  ) {
    super(message);
    this.name = 'AiOutputError';
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
