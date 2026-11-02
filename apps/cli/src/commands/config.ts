import { loadConfig, saveConfig, configPath, ConfigSchema, type Config } from '../config.js';
import { emit, type Context } from '../context.js';
import { CliError, ExitCode } from '../exit-codes.js';

export function runConfigShow(ctx: Context): number {
  const config = loadConfig(ctx.io.env);
  emit(
    ctx,
    { status: 'OK', exitCode: 0, path: configPath(ctx.io.env), config },
    [
      `Config file: ${configPath(ctx.io.env)}`,
      JSON.stringify(config, null, 2),
      '',
      'Only non-secret settings are stored. Credentials come from the AWS provider chain and environment variables.',
    ].join('\n'),
  );
  return ExitCode.OK;
}

export interface InitOptions {
  profile?: string;
  roleArn?: string;
  regions?: string;
  externalModelContext?: string;
}

/** Non-interactive setup of AWS defaults and privacy preferences. No credentials are asked for or stored. */
export function runInit(ctx: Context, options: InitOptions): number {
  const current = loadConfig(ctx.io.env);
  const next: Config = {
    ...current,
    aws: {
      ...current.aws,
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.roleArn ? { roleArn: options.roleArn } : {}),
      ...(options.regions
        ? {
            regions: options.regions
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean),
          }
        : {}),
    },
    privacy: {
      externalModelContext:
        (options.externalModelContext as 'ask-first' | 'never' | undefined) ??
        current.privacy.externalModelContext,
    },
  };
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success)
    throw new CliError(`Invalid settings: ${parsed.error.message}`, ExitCode.USAGE, 'usage');
  const path = saveConfig(ctx.io.env, parsed.data);
  emit(
    ctx,
    { status: 'OK', exitCode: 0, path, config: parsed.data },
    `Saved ${path}\nAWS access uses the standard credential chain (profile, SSO, AssumeRole); no keys are stored.\nConfigure AI separately with \`c2c ai connect\` (optional).`,
  );
  return ExitCode.OK;
}
