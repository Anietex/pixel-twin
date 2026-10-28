import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Vite's own port when its config sets none. */
export const VITE_DEFAULT_PORT = 5173;
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
/** How long a port owner check is remembered (ms), so each call does not look again. */
const OWNER_CACHE_MS = 30_000;

/**
 * The development server address the project's own files give, when pixel-twin.json has none:
 * - a Vite config: its server.port, else Vite's 5173;
 * - else package.json's dev script with --port N, --port=N or -p N.
 * Returns the address and the file it came from, or null.
 */
export async function detectDevServer(workDir: string): Promise<{ url: string; from: string } | null> {
  for (const name of VITE_CONFIGS) {
    let text: string;
    try {
      text = await readFile(path.join(workDir, name), 'utf8');
    } catch {
      continue;
    }
    const port = /\bserver\s*:\s*\{[^}]*?\bport\s*:\s*(\d+)/s.exec(text)?.[1];
    return { url: `http://localhost:${port ?? VITE_DEFAULT_PORT}`, from: name };
  }
  try {
    const pkg = JSON.parse(await readFile(path.join(workDir, 'package.json'), 'utf8'));
    const dev = typeof pkg?.scripts?.dev === 'string' ? pkg.scripts.dev : '';
    const port = /(?:--port[=\s]+|-p\s+)(\d+)/.exec(dev)?.[1];
    if (port) return { url: `http://localhost:${port}`, from: 'package.json' };
  } catch {
    // no package.json, or not valid JSON
  }
  return null;
}

/** The process listening on a TCP port on this computer, and the folder it was started in. Null when it can't be told. */
async function portOwner(port: number): Promise<{ pid: number; command: string; folder: string } | null> {
  try {
    const listen = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { timeout: 3000 });
    const pid = Number(/^p(\d+)$/m.exec(listen.stdout)?.[1]);
    const command = /^c(.+)$/m.exec(listen.stdout)?.[1] ?? 'a program';
    if (!pid) return null;
    const cwd = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 });
    const folder = /^n(.+)$/m.exec(cwd.stdout)?.[1];
    return folder ? { pid, command, folder } : null;
  } catch {
    return null;   // no lsof, or no right to look at the process
  }
}

const checked = new Map<string, { at: number; problem: string | null }>();

/**
 * For an address on this computer's development server: makes sure the program listening on its port
 * was started in this project (or in a folder that holds it, as in a monorepo). Returns a plain
 * explanation when another project's program holds the port, else null. It can't tell when lsof is
 * missing or the program belongs to another user, and then says nothing. The program that runs this
 * check (in tests, the same process serves the pages) always counts as this project.
 */
export async function otherProjectOnPort(address: string, workDir: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const key = `${port}|${workDir}`;
  const cached = checked.get(key);
  if (cached && Date.now() - cached.at < OWNER_CACHE_MS) return cached.problem;
  let problem: string | null = null;
  const owner = await portOwner(port);
  if (owner && owner.pid !== process.pid) {
    const real = async (p: string) => realpath(p).catch(() => path.resolve(p));
    const [project, folder] = await Promise.all([real(workDir), real(owner.folder)]);
    const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`);
    if (!inside(project, folder) && !inside(folder, project)) {
      problem = `Port ${port} is held by ${owner.command} (process ${owner.pid}) started in ${owner.folder}, not in this project (${workDir}). `
        + 'It serves another project, so the pages would not be this build. Start this project\'s development server, '
        + 'then set devServer in pixel-twin.json to its address (with its port).';
    }
  }
  checked.set(key, { at: Date.now(), problem });
  return problem;
}
