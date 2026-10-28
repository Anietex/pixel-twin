// How each coding agent stores its MCP servers and skills, and how to add Pixel Twin to it or take it out.
// Only Node's own modules, so it runs before `npm install`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const NAME = 'pixel-twin';
/** How long an agent may wait for one Pixel Twin tool call (ms): a picture export can take 2 minutes. */
export const TOOL_TIMEOUT_MS = 600_000;

/** What starts the server: this Node and the built server file. Absolute paths, because editors don't always see the shell's PATH. */
export function serverCommand(repo, node = process.execPath) {
  return { command: node, args: [path.join(repo, 'packages', 'server', 'dist', 'index.js')] };
}

/** The real computer: the home folder, and running and finding programs. Tests pass their own. */
export function realEnv() {
  return {
    home: process.env.HOME ?? process.env.USERPROFILE ?? '',
    platform: process.platform,
    appData: process.env.APPDATA ?? '',
    has: (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0,
    run: (cmd, args) => {
      const res = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
      return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
    },
  };
}

const done = (message) => ({ ok: true, message });
const failed = (message) => ({ ok: false, message });

// ---- Settings files ----

/** A JSON settings file as an object: {} when it is missing or empty, null when it isn't plain JSON (for example, it has comments). */
export function readJson(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Writes a settings file. The first time Pixel Twin changes a file, it keeps a copy of the original next to it. */
export function writeSettings(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.before-pixel-twin`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, text);
}

const writeJson = (file, value) => writeSettings(file, `${JSON.stringify(value, null, 2)}\n`);

/** The settings with Pixel Twin's entry under `key` (such as mcpServers), replacing an older one. */
export function withServer(settings, key, entry) {
  return { ...settings, [key]: { ...(settings[key] ?? {}), [NAME]: entry } };
}

/** The settings without Pixel Twin's entry under `key`. */
export function withoutServer(settings, key) {
  if (!settings[key] || !(NAME in settings[key])) return settings;
  const { [NAME]: _removed, ...rest } = settings[key];
  return { ...settings, [key]: rest };
}

/** Adds or removes the entry in a JSON settings file. A file that isn't plain JSON is left alone. */
function editJson(file, key, entry, snippet) {
  const settings = readJson(file);
  if (settings === null) {
    return failed(`${file} has comments or isn't plain JSON, so it was left alone. Add this under "${key}" yourself:\n${snippet}`);
  }
  if (entry === null) {
    if (!settings[key] || !(NAME in settings[key])) return done(`not in ${file}`);
    writeJson(file, withoutServer(settings, key));
    return done(`removed from ${file}`);
  }
  writeJson(file, withServer(settings, key, entry));
  return done(`added to ${file}`);
}

// ---- Codex: TOML ----

const tomlString = (text) => JSON.stringify(text);
const isPixelTwinTable = (name) => {
  const plain = name.replace(/"/g, '');
  return plain === `mcp_servers.${NAME}` || plain.startsWith(`mcp_servers.${NAME}.`);
};

/** Codex's config.toml text without Pixel Twin's table (and its sub-tables). */
export function withoutCodexServer(text) {
  const kept = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) skipping = isPixelTwinTable(header[1]);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Codex's config.toml text with Pixel Twin's table at the end, replacing an older one. */
export function withCodexServer(text, server) {
  const rest = withoutCodexServer(text).trimEnd();
  const table = [
    `[mcp_servers.${NAME}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(', ')}]`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_MS / 1000}`,
  ].join('\n');
  return `${rest ? `${rest}\n\n` : ''}${table}\n`;
}

// ---- OpenCode ----

/** OpenCode's settings file: the one that already lists MCP servers, else the first that exists, else a new opencode.json. */
export function opencodeFile(home) {
  const dir = path.join(home, '.config', 'opencode');
  const files = ['opencode.jsonc', 'opencode.json', 'config.json'].map((f) => path.join(dir, f)).filter((f) => existsSync(f));
  return files.find((f) => /"mcp"\s*:/.test(readFileSync(f, 'utf8'))) ?? files[0] ?? path.join(dir, 'opencode.json');
}

/** OpenCode settings with Pixel Twin, and a tool time limit of at least TOOL_TIMEOUT_MS. */
export function withOpencodeServer(settings, server) {
  const next = withServer(settings, 'mcp', { type: 'local', command: [server.command, ...server.args], enabled: true });
  const timeout = Math.max(Number(settings.experimental?.mcp_timeout) || 0, TOOL_TIMEOUT_MS);
  return { $schema: 'https://opencode.ai/config.json', ...next, experimental: { ...(settings.experimental ?? {}), mcp_timeout: timeout } };
}

// ---- VS Code ----

function vscodeUserDir(env) {
  if (env.platform === 'darwin') return path.join(env.home, 'Library', 'Application Support', 'Code', 'User');
  if (env.platform === 'win32') return path.join(env.appData, 'Code', 'User');
  return path.join(env.home, '.config', 'Code', 'User');
}

// ---- The agents ----

const agentsSkills = (env) => path.join(env.home, '.agents', 'skills');

/**
 * Every agent the setup knows. Each one:
 * - found(env): whether it seems to be on this computer;
 * - skillsDir(env): where it reads skills (most read ~/.agents/skills; Claude Code reads ~/.claude/skills);
 * - add(env, server) and remove(env): change its settings and return { ok, message }.
 */
export const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    found: (env) => env.has('claude') || existsSync(path.join(env.home, '.claude')),
    skillsDir: (env) => path.join(env.home, '.claude', 'skills'),
    add(env, server) {
      if (!env.has('claude')) return failed('the claude command was not found. Install Claude Code, then run the setup again.');
      env.run('claude', ['mcp', 'remove', NAME, '--scope', 'user']);   // an older entry, if any
      const res = env.run('claude', ['mcp', 'add', '--scope', 'user', NAME, '--', server.command, ...server.args]);
      return res.code === 0 ? done('added with "claude mcp add --scope user"') : failed(`claude mcp add failed: ${res.out}`);
    },
    remove(env) {
      if (!env.has('claude')) return failed('the claude command was not found');
      const res = env.run('claude', ['mcp', 'remove', NAME, '--scope', 'user']);
      return done(res.code === 0 ? 'removed with "claude mcp remove"' : 'not registered');
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    found: (env) => env.has('opencode') || existsSync(path.join(env.home, '.config', 'opencode')),
    skillsDir: agentsSkills,
    add(env, server) {
      const file = opencodeFile(env.home);
      const settings = readJson(file);
      if (settings === null) {
        const entry = { [NAME]: { type: 'local', command: [server.command, ...server.args], enabled: true } };
        return failed(`${file} has comments or isn't plain JSON, so it was left alone. Add this under "mcp" yourself:\n`
          + `${JSON.stringify(entry, null, 2)}\nand set "experimental": { "mcp_timeout": ${TOOL_TIMEOUT_MS} }`);
      }
      writeJson(file, withOpencodeServer(settings, server));
      return done(`added to ${file}, with a tool time limit of ${TOOL_TIMEOUT_MS / 60_000} minutes`);
    },
    remove: (env) => editJson(opencodeFile(env.home), 'mcp', null, ''),
  },
  {
    id: 'codex',
    name: 'Codex',
    found: (env) => env.has('codex') || existsSync(path.join(env.home, '.codex')),
    skillsDir: agentsSkills,
    add(env, server) {
      const file = path.join(env.home, '.codex', 'config.toml');
      writeSettings(file, withCodexServer(existsSync(file) ? readFileSync(file, 'utf8') : '', server));
      return done(`added to ${file}, with a tool time limit of ${TOOL_TIMEOUT_MS / 60_000} minutes`);
    },
    remove(env) {
      const file = path.join(env.home, '.codex', 'config.toml');
      if (!existsSync(file)) return done('not registered');
      const text = readFileSync(file, 'utf8');
      const next = withoutCodexServer(text);
      if (next === text) return done('not registered');
      writeSettings(file, next);
      return done(`removed from ${file}`);
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    found: (env) => env.has('cursor') || existsSync(path.join(env.home, '.cursor')),
    skillsDir: agentsSkills,
    add: (env, server) => editJson(path.join(env.home, '.cursor', 'mcp.json'), 'mcpServers', server,
      JSON.stringify({ [NAME]: server }, null, 2)),
    remove: (env) => editJson(path.join(env.home, '.cursor', 'mcp.json'), 'mcpServers', null, ''),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    found: (env) => env.has('gemini') || existsSync(path.join(env.home, '.gemini')),
    skillsDir: agentsSkills,
    add(env, server) {
      const entry = { ...server, timeout: TOOL_TIMEOUT_MS };
      return editJson(path.join(env.home, '.gemini', 'settings.json'), 'mcpServers', entry, JSON.stringify({ [NAME]: entry }, null, 2));
    },
    remove: (env) => editJson(path.join(env.home, '.gemini', 'settings.json'), 'mcpServers', null, ''),
  },
  {
    id: 'vscode',
    name: 'VS Code (GitHub Copilot)',
    found: (env) => env.has('code') || existsSync(vscodeUserDir(env)),
    skillsDir: agentsSkills,
    add(env, server) {
      const entry = { type: 'stdio', ...server };
      return editJson(path.join(vscodeUserDir(env), 'mcp.json'), 'servers', entry, JSON.stringify({ [NAME]: entry }, null, 2));
    },
    remove: (env) => editJson(path.join(vscodeUserDir(env), 'mcp.json'), 'servers', null, ''),
  },
];

// ---- Skill links ----

/** Links the skill folder into a skills folder. A real folder of the same name is left alone; an old link is replaced. */
export function linkSkill(skillsDir, skillSource) {
  const target = path.join(skillsDir, NAME);
  let existing = null;
  try {
    existing = lstatSync(target);
  } catch {
    // nothing there yet
  }
  if (existing && !existing.isSymbolicLink()) return failed(`${target} already exists and isn't a link, so it was left as it is`);
  if (existing) rmSync(target);
  mkdirSync(skillsDir, { recursive: true });
  symlinkSync(skillSource, target, 'junction');   // 'junction' matters only on Windows, where it needs no admin rights
  return done(`skill linked at ${target}`);
}

/** Removes the skill link from a skills folder, but only when it points to this skill. */
export function unlinkSkill(skillsDir, skillSource) {
  const target = path.join(skillsDir, NAME);
  try {
    if (!lstatSync(target).isSymbolicLink()) return done(`${target} isn't a link, so it was left as it is`);
  } catch {
    return done('no skill link');
  }
  // Real paths, so a link written with different letter case (macOS) or through another link still counts.
  const real = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return null;
    }
  };
  if (real(target) !== real(skillSource)) return done(`${target} points elsewhere, so it was left as it is`);
  rmSync(target);
  return done(`skill link removed from ${target}`);
}
