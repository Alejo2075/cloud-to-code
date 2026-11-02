/** Documented process exit codes (see docs/cli.md). */
export const ExitCode = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  /** Pending questions must be answered before the workflow can continue. */
  NEEDS_INPUT: 10,
  /** A blocking question was answered "I don't know". */
  BLOCKED: 11,
  /** A required permission or consent is missing. */
  CONSENT_REQUIRED: 12,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCodeValue = ExitCode.FAILED,
    readonly code = 'error',
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
