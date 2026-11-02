import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { GenerationError, type GeneratedFile } from './types.js';

export interface WriteOptions {
  /** Replace files in a non-empty directory. Never the default; callers must obtain explicit consent first. */
  overwrite?: boolean;
}

/**
 * Write generated files into a NEW directory. An existing non-empty directory is refused unless the caller
 * passes `overwrite: true` after asking the developer. Paths are validated to stay inside the directory.
 */
export function writeProject(
  dir: string,
  files: readonly GeneratedFile[],
  options: WriteOptions = {},
): string[] {
  const root = resolve(dir);
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink())
      throw new GenerationError('unsafe-output', `Refusing to write through the symlink ${root}.`);
    if (!lstatSync(root).isDirectory())
      throw new GenerationError('unsafe-output', `${root} exists and is not a directory.`);
    if (readdirSync(root).length > 0 && !options.overwrite) {
      throw new GenerationError(
        'output-not-empty',
        `${root} is not empty. Choose a new directory, or confirm overwriting explicitly.`,
      );
    }
  }
  const written: string[] = [];
  for (const file of files) {
    const target = resolve(join(root, file.path));
    const rel = relative(root, target);
    if (
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      isAbsolute(file.path) ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.includes('\0')
    ) {
      throw new GenerationError(
        'unsafe-path',
        `Refusing to write outside the output directory: ${file.path}`,
      );
    }
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new GenerationError(
        'unsafe-output',
        `Refusing to write through the symlink ${target}.`,
      );
    }
    writeFileSync(target, file.content, { mode: 0o644 });
    written.push(file.path);
  }
  return written;
}
