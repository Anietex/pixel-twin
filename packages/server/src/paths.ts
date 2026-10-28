import path from 'node:path';

/**
 * Resolves dir against workDir. Returns the absolute path, or null when it points outside workDir.
 * It works on the text alone and touches no file. `paths` picks Windows or POSIX rules (default: this computer's).
 */
export function insideProject(workDir: string, dir: string, paths: typeof path.win32 = path): string | null {
  const resolved = paths.resolve(workDir, dir);
  const rel = paths.relative(paths.resolve(workDir), resolved);
  if (rel === '..' || rel.startsWith('..' + paths.sep) || paths.isAbsolute(rel)) return null;
  return resolved;
}
