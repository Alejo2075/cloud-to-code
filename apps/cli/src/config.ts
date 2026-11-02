import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

/**
 * Per-user, NON-SECRET settings. Credentials never live here: AWS uses the standard provider chain and AI keys
 * come from environment variables or the provider's own credential chain.
 */
export const ConfigSchema = z.object({
  version: z.literal(1),
  aws: z
    .object({
      profile: z.string().min(1).optional(),
      roleArn: z.string().min(1).optional(),
      regions: z.array(z.string()).default([]),
    })
    .default({ regions: [] }),
  ai: z
    .object({
      provider: z.enum(['bedrock', 'anthropic', 'openai', 'ollama']).optional(),
      model: z.string().min(1).optional(),
      awsProfile: z.string().optional(),
      region: z.string().optional(),
      endpoint: z.string().optional(),
    })
    .default({}),
  privacy: z
    .object({ externalModelContext: z.enum(['ask-first', 'never']).default('ask-first') })
    .default({ externalModelContext: 'ask-first' }),
  reconstruction: z
    .object({
      strategy: z.enum(['faithful', 'balanced', 'modernized']).default('balanced'),
      interaction: z.enum(['interactive', 'non-interactive']).default('interactive'),
    })
    .default({ strategy: 'balanced', interaction: 'interactive' }),
});
export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({ version: 1 });
}

export function configPath(env: NodeJS.ProcessEnv): string {
  if (env['C2C_CONFIG_DIR']) return join(env['C2C_CONFIG_DIR'], 'config.yaml');
  const base = env['XDG_CONFIG_HOME'] ?? join(env['HOME'] ?? homedir(), '.config');
  return join(base, 'cloud-to-code', 'config.yaml');
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const path = configPath(env);
  if (!existsSync(path)) return defaultConfig();
  return ConfigSchema.parse(parse(readFileSync(path, 'utf8')));
}

export function saveConfig(env: NodeJS.ProcessEnv, config: Config): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, stringify(ConfigSchema.parse(config)), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}
