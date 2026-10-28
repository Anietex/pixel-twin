import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { insideProject } from '../paths';

export const URL_NOT_ALLOWED =
  'Pixel Twin only opens pages on this computer\'s development server (localhost) or files inside the project.';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** How file paths work here: Windows or not, and how to find a file's real path. Tests pass their own. */
export interface FileSystemView { windows: boolean; realpath: (p: string) => string }
const THIS_COMPUTER: FileSystemView = { windows: process.platform === 'win32', realpath: realpathSync };

/**
 * The address to open for `url`, or null when it is refused.
 * - http(s) pages on this computer (localhost, 127.0.0.1, [::1] or *.localhost) come back unchanged.
 * - Existing files inside workDir come back as the address of the real file. Symlinks are followed
 *   first, so a link that leads out of the project is refused.
 * Everything else is refused.
 * A file address that names another computer (file://server/share/…, file:////server/share/…) is a network path on
 * Windows, and looking it up makes Windows contact that computer, which may send the user's login hash. So every
 * check that works on the text alone runs before any file is looked up.
 */
export function allowedTarget(url: string, workDir: string, fs: FileSystemView = THIS_COMPUTER): string | null {
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
  if (parsed.protocol !== 'file:' || parsed.hostname !== '') return null;
  const paths = fs.windows ? path.win32 : path.posix;
  try {
    const file = fileURLToPath(parsed, { windows: fs.windows });
    if (/^[\\/]{2}/.test(file)) return null;   // a network path
    const root = fs.realpath(workDir);
    if (insideProject(workDir, file, paths) === null && insideProject(root, file, paths) === null) return null;
    const real = fs.realpath(file);
    if (insideProject(root, real, paths) === null) return null;
    const target = pathToFileURL(real, { windows: fs.windows });
    target.search = parsed.search;
    target.hash = parsed.hash;
    return target.href;
  } catch {
    return null; // a missing file, or an address that isn't a file path
  }
}

/** True when `url` may be opened. See allowedTarget. */
export function isAllowedUrl(url: string, workDir: string): boolean {
  return allowedTarget(url, workDir) !== null;
}
