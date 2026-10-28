import { createHmac } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import { createServer as createNet, type AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { Hello } from '@pixel-twin/shared';
import { PluginError, PluginTimeoutError } from '../src/errors';
import { PEER_PROTOCOL } from '../src/peer';
import { SharedBridge } from '../src/sharedBridge';
import { fakePlugin, type FakeHandler } from './helpers/fakePlugin';

const SECRET = 'shared-secret';
const HELLO: Hello = { type: 'hello', fileName: 'Landing', fileKey: 'K', editorType: 'figma', pluginVersion: '0.2.0', secret: SECRET };

let port: number;
let open: { stop(): Promise<void> }[];
let sockets: WebSocket[];

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const s = createNet();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function session(secret = SECRET): Promise<SharedBridge> {
  const b = new SharedBridge({ port, hosts: ['127.0.0.1'], timeoutMs: 1000, secret, retryMs: 100 });
  await b.start();
  open.push(b);
  return b;
}

const answers: FakeHandler = (method) => {
  if (method === 'hasNode') return { exists: true, pageId: '0:1' };
  if (method === 'getOutline') throw new Error('Layer 9:9 not found in this file');
  return new Promise(() => undefined);   // never answers
};

async function plugin(): Promise<WebSocket> {
  const s = await fakePlugin(port, HELLO, answers);
  sockets.push(s);
  return s;
}

beforeEach(async () => {
  port = await freePort();
  open = [];
  sockets = [];
});
afterEach(async () => {
  sockets.forEach((s) => s.terminate());
  await Promise.all(open.map((b) => b.stop()));
});

test('a second session shares the first one\'s plugin connection', async () => {
  const a = await session();
  const b = await session();
  expect([a.role(), b.role()]).toEqual(['own', 'shared']);
  await plugin();
  await until(() => b.files().length === 1);
  const [file] = b.files();
  expect(file).toMatchObject({ fileName: 'Landing', fileKey: 'K' });
  expect(file.connectedAt).toBeInstanceOf(Date);
  expect(a.unintroduced()).toBe(0);   // the sharing session is not a silent plugin window
  expect(await b.call(file.connectionId, 'hasNode', { nodeId: '1:1' })).toEqual({ exists: true, pageId: '0:1' });
});

test('errors reach the sharing session as the same kind of error', async () => {
  await session();
  const b = await session();
  await plugin();
  await until(() => b.files().length === 1);
  const id = b.files()[0].connectionId;
  const failed = await b.call(id, 'getOutline', { nodeId: '9:9', depth: 1 }).then(() => null, (e: Error) => e);
  expect(failed).toBeInstanceOf(PluginError);
  expect(failed!.message).toBe('Layer 9:9 not found in this file');
  await expect(b.call(id, 'listSections', { pageId: '0:1' }, { timeoutMs: 200 })).rejects.toBeInstanceOf(PluginTimeoutError);
});

test('when the owner closes, the sharing session takes over and the plugin reconnects to it', async () => {
  const a = await session();
  const b = await session();
  await plugin();
  await until(() => b.files().length === 1);
  await a.stop();
  await until(() => b.role() === 'own');
  expect(b.problem()).toBeNull();
  await plugin();   // the real plugin tries again every 2 seconds
  await until(() => b.files().length === 1);
  expect(await b.call(b.files()[0].connectionId, 'hasNode', { nodeId: '1:1' })).toEqual({ exists: true, pageId: '0:1' });
});

test('with three sessions, one takes over and the other shares it', async () => {
  const a = await session();
  const b = await session();
  const c = await session();
  await a.stop();
  // Both notice the owner left, one takes the port, and the other shares it.
  await until(() => [b.role(), c.role()].sort().join() === 'own,shared');
  await plugin();
  await until(() => b.files().length === 1 && c.files().length === 1);
});

test('a port held by another program is reported, and owned once it is free', async () => {
  const other = createHttp((_req, res) => res.end('not Pixel Twin'));
  await new Promise<void>((r) => other.listen(port, '127.0.0.1', r));
  const s = await session();
  expect(s.role()).toBe('none');
  expect(s.problem()?.message).toMatch(/not by a Pixel Twin session that can share it/);
  await new Promise((r) => other.close(r));
  await until(() => s.role() === 'own');
  expect(s.problem()).toBeNull();
});

test('a session built with a different secret is refused, with the reason', async () => {
  await session();
  const b = await session('another-secret');
  expect(b.role()).toBe('none');
  expect(b.problem()?.message).toMatch(/could not prove it is a Pixel Twin session built with your secret/);
});

test('a program posing as the owner never gets the secret, and is never believed', async () => {
  const heard: string[] = [];
  const impostor = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise((r) => impostor.once('listening', r));
  impostor.on('connection', (ws) => {
    ws.on('message', (raw) => {
      heard.push(raw.toString());
      // It answers with a made-up proof and a file list, hoping to be trusted.
      ws.send(JSON.stringify({ type: 'peer-files', files: [{ connectionId: 'x', fileName: 'Fake', fileKey: null, editorType: 'figma', connectedAt: new Date().toISOString() }], unintroduced: 0 }));
      ws.send(JSON.stringify({ type: 'peer-challenge', proof: 'f'.repeat(64), challenge: 'a'.repeat(64) }));
    });
  });
  try {
    const b = await session();
    expect(b.role()).toBe('none');
    expect(b.files()).toEqual([]);
    expect(b.problem()?.message).toMatch(/could not prove/);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.join('\n')).not.toContain(SECRET);
    expect(heard.some((m) => JSON.parse(m).type === 'peer-proof')).toBe(false);
  } finally {
    await new Promise((r) => impostor.close(r));
  }
});

test('a server of a different build is refused, and a peer can only reach plugins', async () => {
  await session();
  const talk = (hello: object, then?: object) => new Promise<string[]>((resolve) => {
    const got: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => {
      ws.send(JSON.stringify(hello));
      if (then) setTimeout(() => ws.send(JSON.stringify(then)), 100);
    });
    ws.on('message', (raw) => got.push(raw.toString()));
    setTimeout(() => { ws.terminate(); resolve(got); }, 400);
  });
  const refused = await talk({ type: 'peer-hello', protocol: PEER_PROTOCOL + 1, challenge: 'a'.repeat(64) });
  expect(JSON.parse(refused[0])).toMatchObject({ type: 'peer-refused' });
  // A peer that answers the owner's challenge correctly, then asks for a connection that is not a plugin.
  const replies = await new Promise<Record<string, unknown>[]>((resolve) => {
    const got: Record<string, unknown>[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'peer-hello', protocol: PEER_PROTOCOL, challenge: 'b'.repeat(64) })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      got.push(m);
      if (m.type === 'peer-challenge') {
        const proof = createHmac('sha256', SECRET).update(`pixel-twin peer ${m.challenge}`).digest('hex');
        ws.send(JSON.stringify({ type: 'peer-proof', proof }));
      }
      if (m.type === 'peer-files') {
        ws.send(JSON.stringify({ type: 'peer-request', id: 'r1', connectionId: 'not-a-plugin', method: 'hasNode', params: { nodeId: '1:1' }, timeoutMs: 1000 }));
      }
    });
    setTimeout(() => { ws.terminate(); resolve(got); }, 500);
  });
  expect(replies.find((m) => m.type === 'peer-response')).toMatchObject({ id: 'r1', ok: false, errorName: 'PluginGoneError' });
  // A request before the proof is ignored.
  const early = await talk({ type: 'peer-hello', protocol: PEER_PROTOCOL, challenge: 'c'.repeat(64) },
    { type: 'peer-request', id: 'r2', connectionId: 'not-a-plugin', method: 'hasNode', params: { nodeId: '1:1' }, timeoutMs: 1000 });
  expect(early.map((r) => JSON.parse(r).type)).toEqual(['peer-challenge']);
});
