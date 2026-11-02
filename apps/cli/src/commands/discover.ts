import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createSenderFactory,
  discover,
  ScopeError,
  SUPPORTED_SERVICES,
} from '@cloud-to-code/provider-aws';
import { inspectSnapshot } from '@cloud-to-code/reconstruction';
import { loadConfig } from '../config.js';
import { emit, note, type Context } from '../context.js';
import { CliError, ExitCode } from '../exit-codes.js';
import { renderInspection } from '../render.js';

export interface DiscoverOptions {
  account?: string;
  regions?: string;
  services?: string;
  profile?: string;
  roleArn?: string;
  output?: string;
  overwrite?: boolean;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Read-only discovery into a sanitized snapshot file. The account and regions must be stated explicitly and are
 * checked against the STS identity before anything is read. Nothing in AWS is created, changed or deleted.
 */
export async function runDiscover(ctx: Context, options: DiscoverOptions): Promise<number> {
  const config = loadConfig(ctx.io.env);
  const regions = options.regions ? list(options.regions) : config.aws.regions;
  if (!options.account) {
    throw new CliError(
      'Missing --account <12-digit account ID>. Discovery never crawls an account you did not name.',
      ExitCode.USAGE,
      'usage',
    );
  }
  if (regions.length === 0) {
    throw new CliError(
      'Missing --regions (comma separated), or set aws.regions with `c2c init`. There is no implicit all-regions scan.',
      ExitCode.USAGE,
      'usage',
    );
  }
  const services = options.services ? list(options.services) : [...SUPPORTED_SERVICES];
  const output = resolve(ctx.io.cwd, options.output ?? 'c2c-snapshot.json');
  if (existsSync(output) && !options.overwrite) {
    throw new CliError(
      `${output} already exists.`,
      ExitCode.USAGE,
      'output-exists',
      'Choose another --output, or pass --overwrite to replace it.',
    );
  }

  const connection = {
    ...((options.profile ?? config.aws.profile)
      ? { profile: (options.profile ?? config.aws.profile)! }
      : {}),
    ...((options.roleArn ?? config.aws.roleArn)
      ? { roleArn: (options.roleArn ?? config.aws.roleArn)! }
      : {}),
  };
  const senderFor = ctx.io.awsSenderFor ?? createSenderFactory(connection);

  note(
    ctx,
    `Read-only discovery: account ${options.account}, regions ${regions.join(', ')}, services ${services.join(', ')}`,
  );
  let result;
  try {
    result = await discover({
      scope: { accountIds: [options.account], regions, services },
      senderFor,
      onProgress: (m) => note(ctx, m),
    });
  } catch (error) {
    if (error instanceof ScopeError) {
      throw new CliError(
        error.message,
        error.code === 'credentials-unavailable' ? ExitCode.CONSENT_REQUIRED : ExitCode.USAGE,
        error.code,
        error.code === 'credentials-unavailable'
          ? 'Sign in first (for example `aws sso login`), or pass --profile.'
          : undefined,
      );
    }
    throw error;
  }

  writeFileSync(output, `${JSON.stringify(result.snapshot, null, 2)}\n`, { mode: 0o600 });
  const report = inspectSnapshot(result.snapshot);
  const problems = result.snapshot.diagnostics.filter((d) => d.severity !== 'info');
  emit(
    ctx,
    {
      status: 'OK',
      exitCode: 0,
      output,
      caller: result.caller,
      redactions: result.redactions,
      report,
    },
    [
      `Discovered ${result.snapshot.resources.length} resources as ${result.caller.arn || result.caller.accountId}.`,
      `Snapshot written to ${output} (sanitized; it still contains ARNs and policies, so treat it as sensitive).`,
      problems.length > 0
        ? `${problems.length} warning/error diagnostic(s): the snapshot may be incomplete.`
        : '',
      '',
      renderInspection(report),
      '',
      `Next: c2c reconstruct <application> --snapshot ${options.output ?? 'c2c-snapshot.json'}`,
      'No AWS resources were created, changed or deleted.',
    ]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n'),
  );
  return ExitCode.OK;
}
