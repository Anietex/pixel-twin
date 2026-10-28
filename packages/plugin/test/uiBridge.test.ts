import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createUiBridge } from '../src/ui/bridge';
import type { Hello, PluginRequest } from '@pixel-twin/shared';

const PORT = 38951;
const URL_ = `ws://127.0.0.1:${PORT}`;
const hello: Hello = {
  type: 'hello', fileName: 'Demo', fileKey: 'abc', editorType: 'figma', pluginVersion: '0.1.0', secret: 's3cret',
};

let server: WebSocketServer | null = null;
let bridge: ReturnType<typeof createUiBridge> | null = null;

function startServer(onMessage: (m: any) => void, onConn?: (ws: WebSocket) => void): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const s: WebSocketServer = new WebSocketServer({ port: PORT, host: '127.0.0.1' }, () => resolve(s));
    s.on('connection', (ws) => {
      onConn?.(ws);
      ws.on('message', (d) => onMessage(JSON.parse(String(d))));
    });
  });
}
const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
function make(postedToMain: PluginRequest[], statuses: string[] = []) {
  bridge = createUiBridge({
    url: URL_, reconnectMs: 200, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    postToMain: (m) => postedToMain.push(m), onStatus: (s) => statuses.push(s),
  });
  return bridge;
}

afterEach(async () => {
  bridge?.close();
  bridge = null;
  const s = server;
  server = null;
  if (s) { s.clients.forEach((c) => c.terminate()); await new Promise((r) => s.close(r)); }
});

test('sends hello on connect and forwards requests to main', async () => {
  const serverMessages: any[] = [];
  const posted: PluginRequest[] = [];
  const statuses: string[] = [];
  server = await startServer((m) => serverMessages.push(m), (ws) =>
    setTimeout(() => ws.send(JSON.stringify({ type: 'request', id: 'r1', method: 'hasNode', params: { nodeId: '1:2' } })), 50));
  make(posted, statuses).fromMain(hello);
  await until(() => serverMessages.length > 0 && posted.length > 0);
  expect(serverMessages[0]).toEqual(hello);
  expect(posted).toContainEqual(expect.objectContaining({ id: 'r1', method: 'hasNode' }));
  expect(statuses).toContain('introducing');
});

test('forwards main responses to the server', async () => {
  const serverMessages: any[] = [];
  server = await startServer((m) => serverMessages.push(m));
  const b = make([]);
  b.fromMain(hello);
  await until(() => serverMessages.length > 0);
  const response = { type: 'response', id: 'r1', ok: true, result: { exists: true } } as const;
  b.fromMain(response);
  await until(() => serverMessages.length > 1);
  expect(serverMessages).toContainEqual(response);
});

test('reconnects within 5 seconds after the server restarts', async () => {
  const msgs1: any[] = [];
  const msgs2: any[] = [];
  const statuses: string[] = [];
  server = await startServer((m) => msgs1.push(m));
  make([], statuses).fromMain(hello);
  await until(() => msgs1.length > 0);
  const s = server;
  server = null;
  s.clients.forEach((c) => c.terminate());
  await new Promise((r) => s.close(r));
  await until(() => statuses.at(-1) === 'waiting');
  const restartedAt = Date.now();
  server = await startServer((m) => msgs2.push(m));
  await until(() => msgs2.length > 0);
  expect(Date.now() - restartedAt).toBeLessThan(5000);
  expect(msgs2[0]).toEqual(hello);
});

test('shows connected only after the server welcomes the file', async () => {
  const statuses: string[] = [];
  const names: (string | undefined)[] = [];
  server = await startServer((m) => {
    if (m.type === 'hello') setTimeout(() => server!.clients.forEach((c) => c.send(JSON.stringify({ type: 'welcome', fileName: m.fileName }))), 50);
  });
  bridge = createUiBridge({
    url: URL_, reconnectMs: 200, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    postToMain: () => {}, onStatus: (s, name) => { statuses.push(s); names.push(name); },
  });
  bridge.fromMain(hello);
  await until(() => statuses.includes('connected'));
  expect(statuses.indexOf('introducing')).toBeLessThan(statuses.indexOf('connected'));
  expect(names.at(-1)).toBe('Demo');
});

test('keeps the first hello and ignores a later one', async () => {
  const serverMessages: any[] = [];
  server = await startServer((m) => serverMessages.push(m));
  const b = make([]);
  b.fromMain(hello);
  b.fromMain({ ...hello, fileName: 'Forged', secret: 'nope' });
  await until(() => serverMessages.length > 0);
  await new Promise((r) => setTimeout(r, 100));
  expect(serverMessages).toEqual([hello]);
});
