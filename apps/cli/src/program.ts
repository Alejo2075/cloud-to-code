import { Command, CommanderError } from 'commander';
import { createContext, type GlobalOptions } from './context.js';
import { runAiConnect, runAiPreview, runAiTest } from './commands/ai.js';
import { runConfigShow, runInit } from './commands/config.js';
import { runDemo } from './commands/demo.js';
import { runDiscover } from './commands/discover.js';
import { runAdoptionPlan, runGenerate, runValidate } from './commands/generate.js';
import { runInspect } from './commands/inspect.js';
import {
  runAnswer,
  runDecisions,
  runQuestions,
  runReconstruct,
  runResume,
} from './commands/session.js';
import { CliError, ExitCode } from './exit-codes.js';
import type { CliIo } from './io.js';

export const VERSION = '0.1.0';

/**
 * Build the c2c program. Handlers return exit codes instead of calling process.exit so the whole CLI can be
 * exercised in-process by tests and reused by other adapters.
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let exitCode: number = ExitCode.OK;
  const program = new Command();
  program
    .name('c2c')
    .description(
      'Turn running AWS infrastructure into AWS CDK code you can understand, review and own.\nRead-only on AWS. Local-first. Questions, not guesses.',
    )
    .version(VERSION)
    .option('--json', 'machine-readable output on stdout (implies --non-interactive)')
    .option(
      '--non-interactive',
      'never prompt; return NEEDS_INPUT (exit 10) with pending questions',
    )
    .option('--session <id>', 'session ID (default: most recent in the workspace)')
    .option(
      '--dir <path>',
      'project directory holding the .c2c workspace (default: current directory)',
    )
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) });

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const ctx = () => createContext(io, globals());

  program
    .command('demo')
    .description('Inspect the bundled synthetic example (no AWS, no AI, no network)')
    .action(() => {
      exitCode = runDemo(ctx());
    });

  program
    .command('init')
    .description('Save non-secret AWS defaults and privacy preferences (no credentials are stored)')
    .option('--profile <name>', 'AWS profile (SSO or shared config)')
    .option('--role-arn <arn>', 'role to assume for discovery')
    .option('--regions <list>', 'default regions, comma separated')
    .option('--external-model-context <mode>', 'ask-first (default) or never')
    .action((options) => {
      exitCode = runInit(ctx(), options);
    });

  program
    .command('config')
    .description('Show settings (never credentials)')
    .command('show')
    .action(() => {
      exitCode = runConfigShow(ctx());
    });

  const ai = program
    .command('ai')
    .description('Optional AI provider for advisory help (never required)');
  ai.command('connect')
    .description('Choose a provider and model (no keys are stored)')
    .option('--provider <name>', 'bedrock | anthropic | openai | ollama')
    .option('--model <id>', 'model or inference profile ID (never assumed)')
    .option('--endpoint <url>', 'Ollama-compatible endpoint')
    .option('--region <region>', 'Bedrock region')
    .option('--aws-profile <name>', 'AWS profile for Bedrock')
    .action((options) => {
      exitCode = runAiConnect(ctx(), options);
    });
  ai.command('test')
    .description('Check connectivity with a fixed prompt (no inventory data)')
    .action(async () => {
      exitCode = await runAiTest(ctx());
    });
  ai.command('preview')
    .description('Show exactly what would be sent to a model; sends nothing')
    .option('--snapshot <file>', 'snapshot file')
    .option('--demo', 'use the bundled synthetic example')
    .option('--show-data', 'print the exact payload')
    .action((options) => {
      exitCode = runAiPreview(ctx(), options);
    });

  program
    .command('discover')
    .description(
      'Read-only discovery of an explicit account, regions and services into a sanitized snapshot',
    )
    .option('--account <id>', 'AWS account ID you are allowed to read (must match the credentials)')
    .option('--regions <list>', 'regions, comma separated (no implicit all-regions scan)')
    .option('--services <list>', 'services, comma separated (default: every supported service)')
    .option('--profile <name>', 'AWS profile')
    .option('--role-arn <arn>', 'role to assume')
    .option('--output <file>', 'snapshot file to write (default c2c-snapshot.json)')
    .option('--overwrite', 'replace an existing snapshot file')
    .action(async (options) => {
      exitCode = await runDiscover(ctx(), options);
    });

  program
    .command('inspect [application]')
    .description('Show topology, evidence, uncertainty and open questions for a snapshot')
    .option('--snapshot <file>', 'sanitized snapshot JSON file')
    .option('--demo', 'use the bundled synthetic example')
    .option('--diagram', 'print a Mermaid diagram generated from the evidence graph')
    .action((application: string | undefined, options) => {
      exitCode = runInspect(ctx(), application, options);
    });

  program
    .command('reconstruct [application]')
    .description(
      'Question-driven reconstruction: ask what is ambiguous, record decisions, build a verified plan',
    )
    .option('--snapshot <file>', 'sanitized snapshot JSON file')
    .option('--demo', 'use the bundled synthetic example')
    .option('--answers <file>', 'answers file (JSON) for non-interactive runs')
    .option(
      '--strategy <strategy>',
      'balanced (default); faithful and modernized are not implemented yet',
    )
    .option(
      '--output <dir>',
      'generate the CDK project into this NEW directory once the plan is verified',
    )
    .option(
      '--overwrite',
      'allow --output to replace files in a non-empty directory (never the default)',
    )
    .option(
      '--ai',
      'add advisory AI interpretation (needs a configured provider; see `c2c ai preview`)',
    )
    .option(
      '--allow-external-model',
      'consent to sending the previewed context to an external model provider',
    )
    .action(async (application: string | undefined, options) => {
      exitCode = await runReconstruct(ctx(), application, options);
    });

  program
    .command('generate')
    .description(
      'Generate the CDK project from the verified plan of a session (blocking questions must be answered)',
    )
    .requiredOption('--output <dir>', 'directory to write the project into (must be new or empty)')
    .option('--overwrite', 'replace files in a non-empty directory (never the default)')
    .option('--answers <file>', 'answers file (JSON) to apply first')
    .option(
      '--ai',
      'add advisory AI interpretation (needs a configured provider; see `c2c ai preview`)',
    )
    .option(
      '--allow-external-model',
      'consent to sending the previewed context to an external model provider',
    )
    .action(async (options) => {
      exitCode = await runGenerate(ctx(), options);
    });

  program
    .command('validate <directory>')
    .description(
      'Offline checks of a generated project: structure, manifest, coverage, typecheck, optional synth',
    )
    .option(
      '--synth',
      "also run the project's own `cdk synth` (executes the project's code, credentials withheld)",
    )
    .option('--trust', 'allow --synth although files differ from the generated manifest')
    .option('--no-typecheck', 'skip the TypeScript typecheck')
    .action(async (directory: string, options) => {
      exitCode = await runValidate(ctx(), directory, options);
    });

  const adoption = program
    .command('adoption')
    .description('Advisory migration analysis (never applies changes)');
  adoption
    .command('plan <directory>')
    .description('Describe what adopting existing resources would involve; reads reports only')
    .action((directory: string) => {
      exitCode = runAdoptionPlan(ctx(), directory);
    });

  program
    .command('questions')
    .description('List pending questions for a session, with evidence and consequences')
    .option('--all', 'show every pending question instead of the next batch of three')
    .action((options) => {
      exitCode = runQuestions(ctx(), options);
    });

  program
    .command('answer [questionId] [answer]')
    .description('Record an answer (option ID, or "unknown"); validated against the question')
    .option('--note <text>', 'free-text detail for the answer (secrets are redacted)')
    .option('--unknown', 'answer "I don\'t know"')
    .option('--answers <file>', 'record many answers from a JSON file')
    .action((questionId: string | undefined, answer: string | undefined, options) => {
      exitCode = runAnswer(ctx(), questionId, answer, options);
    });

  program
    .command('resume')
    .description('Resume a session without repeating answered questions')
    .option('--answers <file>', 'answers file (JSON) for non-interactive runs')
    .action(async (options) => {
      exitCode = await runResume(ctx(), options);
    });

  program
    .command('decisions')
    .description('Review recorded decisions and their history')
    .option('--history', 'show every revision, not only the current decisions')
    .action((options) => {
      exitCode = runDecisions(ctx(), options);
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return exitCode;
  } catch (error) {
    const json = globals().json === true;
    if (error instanceof CommanderError) {
      // --help and --version exit 0; usage mistakes exit 2.
      return error.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
    }
    const cli =
      error instanceof CliError
        ? error
        : new CliError(
            error instanceof Error ? error.message : String(error),
            ExitCode.FAILED,
            'error',
          );
    if (json) {
      io.stdout(
        `${JSON.stringify({ status: 'FAILED', exitCode: cli.exitCode, error: { code: cli.code, message: cli.message, ...(cli.hint ? { hint: cli.hint } : {}) } }, null, 2)}\n`,
      );
    } else {
      io.stderr(`error: ${cli.message}\n${cli.hint ? `hint: ${cli.hint}\n` : ''}`);
    }
    return cli.exitCode;
  }
}
