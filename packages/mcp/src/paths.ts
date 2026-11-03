import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

function realExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return realpathSync(current);
}

/**
 * Resolve a path that a tool may read or write: it must stay inside the workspace directory (symlinks resolved)
 * and must not touch the private `.c2c` state directory. Absolute paths are accepted only if they are inside.
 */
export function confine(workspace: string, input: string, what: string): string {
  if (input.includes('\0'))
    throw new ToolError('invalid-path', `${what} contains an invalid character.`);
  const root = realExisting(resolve(workspace));
  const target = resolve(root, input);
  const real = resolve(realExisting(target), relative(realExisting(target), target));
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ToolError(
      'path-outside-workspace',
      `${what} must be inside the workspace (${workspace}); got ${input}.`,
    );
  }
  if (rel === '.c2c' || rel.startsWith(`.c2c${sep}`)) {
    throw new ToolError('path-reserved', `${what} cannot point into the private .c2c directory.`);
  }
  return target;
}
