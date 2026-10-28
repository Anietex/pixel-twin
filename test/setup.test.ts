import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENTS, NAME, TOOL_TIMEOUT_MS, linkSkill, serverCommand, unlinkSkill, withCodexServer, withOpencodeServer, withoutCodexServer,
} from '../scripts/agents.mjs';

const repo = path.join(__dirname, '..');
const skill = path.join(repo, 'skill', 'pixel-twin');
const server = serverCommand('/opt/pixel twin', '/usr/local/bin/node');
const agent = (id: string) => AGENTS.find((a) => a.id === id)!;

let home: string;
beforeEach(() => { home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pixel-twin-home-'))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A computer with no agent programs: only files under the test's home folder. */
const fakeEnv = (programs: string[] = [], calls: string[][] = []) => ({
  home, platform: 'darwin', appData: '',
  has: (cmd: string) => programs.includes(cmd),
  run: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, out: '' }; },
});
const read = (...parts: string[]) => readFileSync(path.join(home, ...parts), 'utf8');
const json = (...parts: string[]) => JSON.parse(read(...parts));
const put = (text: string, ...parts: string[]) => {
  mkdirSync(path.join(home, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(path.join(home, ...parts), text);
};

test('the server command uses this Node and the built server, with absolute paths', () => {
  expect(serverCommand('/r', '/bin/node')).toEqual({ command: '/bin/node', args: [path.join('/r', 'packages', 'server', 'dist', 'index.js')] });
});

test('Codex: the table is added once, replaces an older one with its sub-table, and keeps other tables', () => {
  const first = withCodexServer('', server);
  expect(first).toBe(`[mcp_servers.${NAME}]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/pixel twin/packages/server/dist/index.js"]\n`
    + `tool_timeout_sec = ${TOOL_TIMEOUT_MS / 1000}\n`);
  const old = 'model = "x"\n\n[mcp_servers.pixel-twin]\ncommand = "old"\n\n[mcp_servers.pixel-twin.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "o"\n';
  const next = withCodexServer(old, server);
  expect(next).not.toContain('old');
  expect(next).not.toContain('A = "1"');
  expect(next).toContain('model = "x"');
  expect(next).toContain('[mcp_servers.other]\ncommand = "o"');
  expect(next.match(/\[mcp_servers\.pixel-twin\]/g)).toHaveLength(1);
  expect(withoutCodexServer(next)).toBe('model = "x"\n\n[mcp_servers.other]\ncommand = "o"\n');
  expect(withCodexServer('', serverCommand('C:\\a "b"', 'C:\\node.exe'))).toContain('command = "C:\\\\node.exe"');
});

test('OpenCode: Pixel Twin joins the other servers, and the tool time limit only ever goes up', () => {
  const next = withOpencodeServer({ mcp: { other: { type: 'local', command: ['x'] } }, experimental: { mcp_timeout: 900000, other: true } }, server);
  expect(next.mcp.other).toEqual({ type: 'local', command: ['x'] });
  expect(next.mcp[NAME]).toEqual({ type: 'local', command: [server.command, ...server.args], enabled: true });
  expect(next.experimental).toEqual({ mcp_timeout: 900000, other: true });
  expect(withOpencodeServer({}, server).experimental.mcp_timeout).toBe(TOOL_TIMEOUT_MS);
});

test('file-based agents get the server, keep their other settings, and save the original once', () => {
  put('{ "mcpServers": { "other": { "command": "x" } }, "theme": "dark" }', '.cursor', 'mcp.json');
  expect(agent('cursor').add(fakeEnv(), server).ok).toBe(true);
  expect(json('.cursor', 'mcp.json')).toEqual({ mcpServers: { other: { command: 'x' }, [NAME]: server }, theme: 'dark' });
  expect(agent('cursor').add(fakeEnv(), server).ok).toBe(true);
  expect(json('.cursor', 'mcp.json.before-pixel-twin')).toEqual({ mcpServers: { other: { command: 'x' } }, theme: 'dark' });

  expect(agent('gemini').add(fakeEnv(), server).ok).toBe(true);
  expect(json('.gemini', 'settings.json').mcpServers[NAME]).toEqual({ ...server, timeout: TOOL_TIMEOUT_MS });

  expect(agent('vscode').add(fakeEnv(), server).ok).toBe(true);
  expect(json('Library', 'Application Support', 'Code', 'User', 'mcp.json').servers[NAME]).toEqual({ type: 'stdio', ...server });

  expect(agent('codex').add(fakeEnv(), server).ok).toBe(true);
  expect(read('.codex', 'config.toml')).toContain(`[mcp_servers.${NAME}]`);

  put('{ "mcp": {} }', '.config', 'opencode', 'opencode.jsonc');
  expect(agent('opencode').add(fakeEnv(), server).ok).toBe(true);
  expect(json('.config', 'opencode', 'opencode.jsonc').mcp[NAME].enabled).toBe(true);

  for (const id of ['cursor', 'gemini', 'vscode', 'codex', 'opencode']) expect(agent(id).remove(fakeEnv()).ok).toBe(true);
  expect(json('.cursor', 'mcp.json').mcpServers).toEqual({ other: { command: 'x' } });
  expect(json('.gemini', 'settings.json').mcpServers).toEqual({});
  expect(read('.codex', 'config.toml')).not.toContain(NAME);
  expect(json('.config', 'opencode', 'opencode.jsonc').mcp).toEqual({});
});

test('a settings file with comments is left alone, with the lines to add by hand', () => {
  put('{\n  // mine\n  "mcpServers": {}\n}\n', '.cursor', 'mcp.json');
  const result = agent('cursor').add(fakeEnv(), server);
  expect(result.ok).toBe(false);
  expect(result.message).toContain('left alone');
  expect(result.message).toContain(server.args[0]);
  expect(read('.cursor', 'mcp.json')).toContain('// mine');
});

test('Claude Code is set up with its own command, after removing an older entry', () => {
  const calls: string[][] = [];
  expect(agent('claude').add(fakeEnv(['claude'], calls), server).ok).toBe(true);
  expect(calls).toEqual([
    ['claude', 'mcp', 'remove', NAME, '--scope', 'user'],
    ['claude', 'mcp', 'add', '--scope', 'user', NAME, '--', server.command, ...server.args],
  ]);
  expect(agent('claude').add(fakeEnv(), server)).toEqual({ ok: false, message: expect.stringContaining('claude command was not found') });
});

test('the skill link is made, replaced when old, kept off a real folder, and removed only when it is ours', () => {
  const dir = path.join(home, '.agents', 'skills');
  expect(linkSkill(dir, skill).ok).toBe(true);
  expect(realpathSync(path.join(dir, NAME))).toBe(realpathSync(skill));
  expect(linkSkill(dir, skill).ok).toBe(true);   // again: the old link is replaced

  const other = path.join(home, 'other');
  mkdirSync(other);
  expect(linkSkill(dir, other).ok).toBe(true);
  expect(unlinkSkill(dir, skill).message).toContain('points elsewhere');
  expect(lstatSync(path.join(dir, NAME)).isSymbolicLink()).toBe(true);
  expect(unlinkSkill(dir, other).ok).toBe(true);
  expect(existsSync(path.join(dir, NAME))).toBe(false);

  mkdirSync(path.join(dir, NAME));
  expect(linkSkill(dir, skill)).toEqual({ ok: false, message: expect.stringContaining('isn\'t a link') });
});

describe('npm run setup', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'setup.mjs'), ...args], {
    encoding: 'utf8',
    // Only this test's home folder, and no agent programs on the PATH, so nothing real is touched.
    env: { HOME: home, USERPROFILE: home, APPDATA: home, PATH: path.dirname(process.execPath) },
  });

  test('--help names every agent', () => {
    const res = run(['--help']);
    expect(res.status).toBe(0);
    for (const a of AGENTS) expect(res.stdout).toContain(a.id);
  });

  test('an unknown agent is an error', () => {
    const res = run(['--skip-build', '--agents', 'nope']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Unknown agent: nope');
  });

  test('--list shows the agents found from their folders', () => {
    mkdirSync(path.join(home, '.cursor'));
    const res = run(['--list']);
    expect(res.stdout).toMatch(/found\s+cursor/);
    expect(res.stdout).toMatch(/not found\s+codex/);
  });

  test('sets up the chosen agents and links the skill, then removes them again', () => {
    const res = run(['--skip-build', '--agents', 'cursor,codex']);
    expect(res.status).toBe(0);
    expect(json('.cursor', 'mcp.json').mcpServers[NAME].args[0]).toBe(path.join(repo, 'packages', 'server', 'dist', 'index.js'));
    expect(read('.codex', 'config.toml')).toContain(`[mcp_servers.${NAME}]`);
    expect(realpathSync(path.join(home, '.agents', 'skills', NAME))).toBe(realpathSync(skill));
    expect(res.stdout).toContain('Import plugin from manifest');

    const some = run(['--remove', '--agents', 'cursor']);
    expect(some.status).toBe(0);
    expect(json('.cursor', 'mcp.json').mcpServers).toEqual({});
    expect(existsSync(path.join(home, '.agents', 'skills', NAME))).toBe(true);   // Codex still uses it

    const all = run(['--remove', '--yes']);
    expect(all.status).toBe(0);
    expect(read('.codex', 'config.toml')).not.toContain(NAME);
    expect(existsSync(path.join(home, '.agents', 'skills', NAME))).toBe(false);
  });
});

test('the setup script only uses Node\'s own modules, so it runs before npm install', () => {
  for (const file of ['setup.mjs', 'agents.mjs']) {
    const imports = [...readFileSync(path.join(repo, 'scripts', file), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.every((m) => m.startsWith('node:') || m.startsWith('./'))).toBe(true);
  }
  expect(execFileSync(process.execPath, ['--check', path.join(repo, 'scripts', 'setup.mjs')]).toString()).toBe('');
});
