import type { AiProvider, AiRequest, AiResponse, Destination } from './types.js';

/** Scripted provider for tests and offline demos. Records every request so tests can inspect what would be sent. */
export class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly requests: AiRequest[] = [];

  constructor(
    private readonly script: (request: AiRequest, call: number) => string | Error,
    readonly destination: Destination = {
      provider: 'Fake provider',
      endpoint: 'https://fake.invalid',
      local: false,
    },
    readonly model = 'fake-model',
  ) {}

  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    const out = this.script(request, this.requests.length);
    if (out instanceof Error) throw out;
    return {
      text: out,
      usage: {
        inputTokens: Math.ceil(request.user.length / 4),
        outputTokens: Math.ceil(out.length / 4),
      },
    };
  }
}
