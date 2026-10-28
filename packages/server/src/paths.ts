import path from 'node:path';

/** Resolves dir against workDir. Returns the absolute path, or null when it points outside workDir. */
export function insideProject(workDir: string, dir: string): string | null {
  const resolved = path.resolve(workDir, dir);
  const rel = path.relative(path.resolve(workDir), resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return resolved;
}
