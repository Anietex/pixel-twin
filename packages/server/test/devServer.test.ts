import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectDevServer, otherProjectOnPort } from '../src/devServer';

const folder = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-dev-'));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  return dir;
};

test('the dev server address comes from the Vite config, else the dev script', async () => {
  expect(await detectDevServer(await folder({ 'vite.config.ts': 'export default defineConfig({ plugins: [react()], server: { host: true, port: 4321 } })' })))
    .toEqual({ url: 'http://localhost:4321', from: 'vite.config.ts' });
  expect(await detectDevServer(await folder({ 'vite.config.mjs': 'export default {}' }))).toEqual({ url: 'http://localhost:5173', from: 'vite.config.mjs' });
  expect(await detectDevServer(await folder({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev -p 3100' } }) })))
    .toEqual({ url: 'http://localhost:3100', from: 'package.json' });
  expect(await detectDevServer(await folder({ 'package.json': JSON.stringify({ scripts: { dev: 'astro dev --port=4400' } }) })))
    .toEqual({ url: 'http://localhost:4400', from: 'package.json' });
  expect(await detectDevServer(await folder({ 'package.json': '{ nope' }))).toBeNull();
  expect(await detectDevServer(await folder({}))).toBeNull();
});

let hasLsof = true;
try { execFileSync('lsof', ['-v'], { stdio: 'ignore' }); } catch (err) { hasLsof = (err as { status?: number }).status !== undefined; }

test.runIf(hasLsof)('a port held by a program from another project is named in plain words', async () => {
  // A program started in its own folder: a small server in a child process.
  const elsewhere = await folder({});
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', "require('http').createServer((q, s) => s.end('x')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })"],
    { cwd: elsewhere, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise<number>((resolve) => child.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    const project = await folder({});
    const problem = await otherProjectOnPort(`http://localhost:${port}/`, project);
    expect(problem).toContain(`Port ${port} is held by`);
    expect(problem).toContain(`not in this project (${project})`);
    // Its own folder, or a folder that holds it, is fine.
    expect(await otherProjectOnPort(`http://127.0.0.1:${port}/`, elsewhere)).toBeNull();
    expect(await otherProjectOnPort(`http://127.0.0.1:${port}/`, path.dirname(elsewhere))).toBeNull();
  } finally {
    child.kill();
  }
}, 20_000);

test('pages this process serves, files and other hosts are not looked at', async () => {
  const site = createServer((_q, s) => s.end('x'));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  try {
    const port = (site.address() as AddressInfo).port;
    expect(await otherProjectOnPort(`http://127.0.0.1:${port}/`, await folder({}))).toBeNull();
  } finally {
    await new Promise((r) => site.close(r));
  }
  expect(await otherProjectOnPort('file:///tmp/x.html', '/tmp')).toBeNull();
  expect(await otherProjectOnPort('https://example.com/', '/tmp')).toBeNull();
});
