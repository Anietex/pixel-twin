#!/usr/bin/env node
// Sets up Pixel Twin: installs the packages, builds the plugin and the server, downloads the browser that checks
// builds, and adds Pixel Twin to your coding agents. Only Node's own modules, so it runs before `npm install`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { AGENTS, linkSkill, realEnv, serverCommand, unlinkSkill } from './agents.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(repo, 'skill', 'pixel-twin');
const manifest = path.join(repo, 'packages', 'plugin', 'dist', 'manifest.json');
const MIN_NODE = 24;

const HELP = `Sets up Pixel Twin and adds it to your coding agents.

Usage: npm run setup [-- options]

  --agents claude,cursor   Set up only these agents. Known: ${AGENTS.map((a) => a.id).join(', ')}
  --yes                    Set up every agent found on this computer, without asking
  --skip-build             Skip installing, building and downloading the browser
  --remove                 Take Pixel Twin out of the agents (and remove the skill links)
  --list                   List the agents found on this computer, then stop
  --help                   Show this help`;

function parseArgs(argv) {
  const opts = { agents: null, yes: false, skipBuild: false, remove: false, list: false, help: false };
  const list = (value) => (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agents' || arg === '--agent') opts.agents = list(argv[++i]);
    else if (/^--agents?=/.test(arg)) opts.agents = list(arg.slice(arg.indexOf('=') + 1));
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--skip-build') opts.skipBuild = true;
    else if (arg === '--remove') opts.remove = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${arg}. Run "npm run setup -- --help".`);
  }
  return opts;
}

function step(title, cmd, args) {
  console.log(`\n${title}…`);
  const res = spawnSync(cmd, args, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) throw new Error(`${title} failed. Fix the error above, then run the setup again.`);
}

const report = (who, result) => console.log(`${result.ok ? '✓' : '✗'} ${who}: ${result.message}`);

/** The agents to set up: the ones named, or the ones found (after asking, when someone is at the keyboard). */
async function chooseAgents(opts, env) {
  const ids = AGENTS.map((a) => a.id);
  const pick = (wanted) => {
    const unknown = wanted.filter((id) => !ids.includes(id));
    if (unknown.length > 0) throw new Error(`Unknown agent: ${unknown.join(', ')}. Known agents: ${ids.join(', ')}.`);
    return AGENTS.filter((a) => wanted.includes(a.id));
  };
  if (opts.agents) return pick(opts.agents);

  const found = AGENTS.filter((a) => a.found(env));
  if (found.length === 0) {
    console.log(`\nNo coding agent found. Name one with --agents (known: ${ids.join(', ')}).`);
    return [];
  }
  const names = found.map((a) => `${a.name} (${a.id})`).join(', ');
  if (opts.yes) return found;
  if (!process.stdin.isTTY) {
    console.log(`\nFound: ${names}. Run again with --yes to ${opts.remove ? 'remove Pixel Twin from' : 'set up'} all of them, or with --agents to choose.`);
    return [];
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nFound: ${names}.`);
    const answer = (await rl.question(`${opts.remove ? 'Remove Pixel Twin from' : 'Set up Pixel Twin for'} all of them? `
      + 'Press Enter for yes, type the ones you want (for example: claude,cursor), or type "none": ')).trim().toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') return found;
    if (answer === 'none' || answer === 'n' || answer === 'no') return [];
    return pick(answer.split(',').map((s) => s.trim()).filter(Boolean));
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) throw new Error(`Pixel Twin needs Node.js ${MIN_NODE} or newer, and this is ${process.version}. Install it from nodejs.org.`);

  const env = realEnv();
  if (opts.list) {
    for (const a of AGENTS) console.log(`${a.found(env) ? 'found    ' : 'not found'}  ${a.id.padEnd(9)} ${a.name}`);
    return 0;
  }

  const server = serverCommand(repo);
  if (!opts.remove && !opts.skipBuild) {
    step('Installing the packages', 'npm', ['install', '--no-audit', '--no-fund']);
    step('Building the plugin and the server', 'npm', ['run', 'build']);
    step('Downloading the browser that checks builds (Chromium)', 'npx', ['playwright', 'install', 'chromium']);
  }
  if (!opts.remove && !existsSync(server.args[0])) throw new Error('The server isn\'t built yet. Run the setup without --skip-build.');

  const agents = await chooseAgents(opts, env);
  let problems = 0;
  const skillDirs = new Set();
  if (agents.length > 0) console.log('');
  for (const agent of agents) {
    const result = opts.remove ? agent.remove(env) : agent.add(env, server);
    report(agent.name, result);
    if (result.ok) skillDirs.add(agent.skillsDir(env));
    else problems += 1;
  }
  // Several agents share ~/.agents/skills, so removing from only some of them keeps the links.
  if (!opts.remove || !opts.agents) {
    for (const dir of skillDirs) {
      const result = opts.remove ? unlinkSkill(dir, skill) : linkSkill(dir, skill);
      report('Skill', result);
      if (!result.ok) problems += 1;
    }
  }

  if (opts.remove) {
    console.log('\nRestart the agents. To remove the plugin, open Figma\'s Plugins → Manage plugins.');
  } else if (agents.length > 0) {
    console.log(`
Next:
1. Restart your coding agent, started in your project's folder, so it loads Pixel Twin.
2. In the Figma desktop app, open a design file. Choose Plugins → Development → Import plugin from manifest, and pick:
   ${manifest}
   You do this once.
3. Run Plugins → Development → Pixel Twin. The small window says "Connected to Pixel Twin" when your agent is running.
4. Ask your agent: "Use Pixel Twin status". It should list your open file.`);
  }
  return problems === 0 ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
