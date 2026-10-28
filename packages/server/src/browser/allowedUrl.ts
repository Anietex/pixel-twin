import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { insideProject } from '../paths';

export const URL_NOT_ALLOWED =
  'Pixel Twin only opens pages on this computer\'s development server (localhost) or files inside the project.';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The address to open for `url`, or null when it is refused.
 * - http(s) pages on this computer (localhost, 127.0.0.1, [::1] or *.localhost) come back unchanged.
 * - Existing files inside workDir come back as the address of the real file. Symlinks are followed
 *   first, so a link that leads out of the project is refused.
 * Everything else is refused.
 */
export function allowedTarget(url: string, workDir: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const host = parsed.hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost') ? url : null;
  }
  if (parsed.protocol !== 'file:') return null;
  try {
    const real = realpathSync(fileURLToPath(parsed));
    if (insideProject(realpathSync(workDir), real) === null) return null;
    const target = pathToFileURL(real);
    target.search = parsed.search;
    target.hash = parsed.hash;
    return target.href;
  } catch {
    return null; // a missing file, or a file address with a host name
  }
}

/** True when `url` may be opened. See allowedTarget. */
export function isAllowedUrl(url: string, workDir: string): boolean {
  return allowedTarget(url, workDir) !== null;
}
