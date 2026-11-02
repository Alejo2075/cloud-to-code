import type { Answer, ReconstructionQuestion } from '@cloud-to-code/core';

/** Terminal prompts. Implemented with @clack/prompts in the real binary and scripted in tests. */
export interface Prompter {
  /** Ask one question. Resolves to `undefined` when the user skips it. */
  ask(
    question: ReconstructionQuestion,
    position: { index: number; total: number },
  ): Promise<Answer | undefined>;
  chooseApplication(names: readonly string[]): Promise<string | undefined>;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** True only when stdin and stdout are both terminals. */
  interactive: boolean;
  prompter?: Prompter;
}
