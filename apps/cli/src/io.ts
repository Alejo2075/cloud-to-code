import type { Answer, ReconstructionQuestion } from '@cloud-to-code/core';
import type { AiProvider } from '@cloud-to-code/ai';
import type { SenderFactory } from '@cloud-to-code/provider-aws';

/** Terminal prompts. Implemented with @clack/prompts in the real binary and scripted in tests. */
export interface Prompter {
  /** Ask one question. Resolves to `undefined` when the user skips it. */
  ask(
    question: ReconstructionQuestion,
    position: { index: number; total: number },
  ): Promise<Answer | undefined>;
  chooseApplication(names: readonly string[]): Promise<string | undefined>;
  /** Yes/no question. Must default to NO. */
  confirm(message: string): Promise<boolean>;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** True only when stdin and stdout are both terminals. */
  interactive: boolean;
  prompter?: Prompter;
  /** Test seam: replaces the real AWS clients. Never set in the shipped binary. */
  awsSenderFor?: SenderFactory;
  /** Test seam: replaces the configured AI provider. Never set in the shipped binary. */
  aiProvider?: AiProvider;
}
