import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fakePlugin } from './helpers/fakePlugin';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const secret = readFileSync(join(here, '..', '..', '..', '.pixel-twin-secret'), 'utf8').trim();

/** A port nothing is using, so the test works while a real Pixel Twin server holds 3851. */
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

/** Starts the built server the way Claude Code or OpenCode does: a child process spoken to over stdin and stdout. */
async function startSession(port: number): Promise<Client> {
  const client = new Client({ name: 'session', version: '0.0.0' });
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  await client.connect(new StdioClientTransport({ command: 'node', args: [entry], cwd: await mkdtemp(join(tmpdir(), 'pixel-twin-session-')),
    env: { ...env, PIXEL_TWIN_PORT: String(port) }, stderr: 'ignore' }));
  return client;
}

const status = async (c: Client) => {
  const r = await c.callTool({ name: 'status', arguments: {} });
  return (r.content as { text: string }[])[0].text;
};

async function until(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('two sessions use one Figma plugin, and the second carries on when the first closes', async () => {
  const port = await freePort();
  const first = await startSession(port);
  await until(async () => (await status(first)).includes('No Figma file'));
  const second = await startSession(port);
  const plugins: WebSocket[] = [];
  try {
    plugins.push(await fakePlugin(port, { type: 'hello', fileName: 'Landing', fileKey: 'K', editorType: 'figma', pluginVersion: '0.2.0', secret },
      () => ({ exists: true, pageId: '0:1' })));
    await until(async () => (await status(second)).includes('"Landing"'));
    expect(await status(second)).toContain('This session shares the Figma connection of another Pixel Twin session.');
    expect(await status(first)).toContain('"Landing"');

    await first.close();   // the first session ends: its server exits and frees the port
    await until(async () => (await status(second)).includes('No Figma file'));
    plugins.push(await fakePlugin(port, { type: 'hello', fileName: 'Landing', fileKey: 'K', editorType: 'figma', pluginVersion: '0.2.0', secret },
      () => ({ exists: true, pageId: '0:1' })));
    await until(async () => (await status(second)).includes('"Landing"'));
    expect(await status(second)).not.toContain('shares the Figma connection');
  } finally {
    plugins.forEach((p) => p.terminate());
    await second.close();
  }
}, 30_000);
