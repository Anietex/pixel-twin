import WebSocket from 'ws';
import type { Hello } from '@pixel-twin/shared';
import { PluginBridge } from '../src/bridge';
import { PluginGoneError, PluginTimeoutError, PortInUseError } from '../src/errors';
import { fakePlugin, type FakeHandler } from './helpers/fakePlugin';

const SECRET = 'test-secret';
const hello: Hello = { type: 'hello', fileName: 'Landing Page', fileKey: null, editorType: 'figma', pluginVersion: '0.1.0', secret: SECRET };

let bridge: PluginBridge;
let sockets: WebSocket[] = [];

async function waitFor(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function connect(handler: FakeHandler) {
  const socket = await fakePlugin(bridge.port, hello, handler);
  sockets.push(socket);
  await waitFor(() => bridge.files().length > 0);
  return { socket, id: bridge.files()[0].connectionId };
}

async function startBridge(timeoutMs = 1000) {
  bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs, secret: SECRET });
  await bridge.start();
}

afterEach(async () => {
  sockets.forEach((s) => s.close());
  sockets = [];
  await bridge.stop();
});

const answer: FakeHandler = (method, params) => {
  if (method === 'hasNode') return { exists: true, pageId: '0:1' };
  throw new Error(`Layer ${(params as { nodeId: string }).nodeId} not found`);
};

test('a plugin that says hello is listed', async () => {
  await startBridge();
  await connect(answer);
  expect(bridge.files()).toMatchObject([{ fileName: 'Landing Page', fileKey: null }]);
});

test('call resolves with the plugin result', async () => {
  await startBridge();
  const { id } = await connect(answer);
  await expect(bridge.call(id, 'hasNode', { nodeId: '1:2' })).resolves.toEqual({ exists: true, pageId: '0:1' });
});

test('a plugin error becomes PluginError with its message', async () => {
  await startBridge();
  const { id } = await connect(answer);
  await expect(bridge.call(id, 'getOutline', { nodeId: '9:9', depth: 1 })).rejects.toThrow(/Layer 9:9 not found/);
});

test('a silent plugin times out', async () => {
  await startBridge(200);
  const { id } = await connect(() => new Promise(() => {}));
  await expect(bridge.call(id, 'hasNode', { nodeId: '1:2' })).rejects.toBeInstanceOf(PluginTimeoutError);
});

test('closing the plugin rejects pending calls at once', async () => {
  await startBridge();
  const { id, socket } = await connect(() => new Promise(() => {}));
  const started = Date.now();
  const pending = bridge.call(id, 'hasNode', { nodeId: '1:2' });
  socket.close();
  await expect(pending).rejects.toBeInstanceOf(PluginGoneError);
  expect(Date.now() - started).toBeLessThan(500);
  await waitFor(() => bridge.files().length === 0);
  expect(bridge.files()).toEqual([]);
});

test('a second bridge on the same port fails with PortInUseError', async () => {
  await startBridge();
  const second = new PluginBridge({ port: bridge.port, hosts: ['127.0.0.1'], timeoutMs: 1000, secret: SECRET });
  await expect(second.start()).rejects.toBeInstanceOf(PortInUseError);
  await second.stop();
});

test('listens on loopback only', async () => {
  const real = new PluginBridge({ port: 0, hosts: ['127.0.0.1', '::1'], timeoutMs: 1000, secret: SECRET });
  await real.start();
  try {
    expect(real.addresses().length).toBeGreaterThan(0);
    expect(real.addresses().every((a) => a === '127.0.0.1' || a === '::1')).toBe(true);
  } finally {
    await real.stop();
  }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rawSocket(origin?: string) {
  return new WebSocket(`ws://127.0.0.1:${bridge.port}`, origin === undefined ? {} : { origin });
}

test('junk messages do not crash the bridge or list anything', async () => {
  await startBridge();
  const bad = rawSocket();
  sockets.push(bad);
  await new Promise((r) => bad.once('open', r));
  const badHellos = [
    { ...hello, fileName: 5 },
    { ...hello, fileKey: 7 },
    { ...hello, editorType: undefined },
    { ...hello, pluginVersion: null },
    { ...hello, secret: undefined },
  ];
  for (const m of ['null', '42', '"x"', '[]', 'not json', ...badHellos.map((h) => JSON.stringify(h))]) bad.send(m);
  await wait(100);
  expect(bridge.files()).toEqual([]);
  const { id } = await connect(answer);
  await expect(bridge.call(id, 'hasNode', { nodeId: '1:2' })).resolves.toMatchObject({ exists: true });
});

test('malformed responses are ignored and the call still times out', async () => {
  await startBridge(300);
  const bad = rawSocket();
  sockets.push(bad);
  await new Promise((r) => bad.once('open', r));
  bad.on('message', (raw) => {
    const { id } = JSON.parse(raw.toString());
    bad.send(JSON.stringify({ type: 'response', id, ok: false })); // no error string
    bad.send(JSON.stringify({ type: 'response', id, ok: 'yes' }));
    bad.send(JSON.stringify({ type: 'response', ok: true }));
  });
  bad.send(JSON.stringify(hello));
  await waitFor(() => bridge.files().length > 0);
  await expect(bridge.call(bridge.files()[0].connectionId, 'hasNode', { nodeId: '1:2' })).rejects.toBeInstanceOf(PluginTimeoutError);
});

test('a wrong secret is closed with 1008 and never listed', async () => {
  await startBridge();
  const socket = rawSocket();
  sockets.push(socket);
  const closed = new Promise<number>((r) => socket.once('close', (code) => r(code)));
  await new Promise((r) => socket.once('open', r));
  socket.send(JSON.stringify({ ...hello, secret: 'nope' }));
  expect(await closed).toBe(1008);
  expect(bridge.files()).toEqual([]);
});

test('messages before hello are ignored', async () => {
  await startBridge(300);
  const socket = rawSocket();
  sockets.push(socket);
  await new Promise((r) => socket.once('open', r));
  socket.send(JSON.stringify({ type: 'response', id: 'x', ok: true, result: 1 }));
  await wait(50);
  expect(bridge.files()).toEqual([]);
});

test('a web page origin is rejected', async () => {
  await startBridge();
  const socket = rawSocket('https://evil.example');
  const outcome = await new Promise<string>((r) => {
    socket.once('open', () => r('open'));
    socket.once('error', () => r('refused'));
  });
  expect(outcome).toBe('refused');
  expect(bridge.files()).toEqual([]);
});

test('Origin null (a Figma plugin) is accepted', async () => {
  await startBridge();
  const socket = await fakePlugin(bridge.port, hello, answer, { origin: 'null' });
  sockets.push(socket);
  await waitFor(() => bridge.files().length > 0);
  expect(bridge.files()).toHaveLength(1);
});

test('PluginGoneError says the plugin disconnected', () => {
  expect(new PluginGoneError().message).toMatch(/plugin disconnected/);
});

test('a valid hello gets a welcome back; a wrong secret does not', async () => {
  await startBridge();
  const got: any[] = [];
  const good = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  sockets.push(good);
  good.on('message', (raw) => got.push(JSON.parse(raw.toString())));
  await new Promise((r) => good.once('open', r));
  good.send(JSON.stringify(hello));
  await waitFor(() => got.length > 0);
  expect(got[0]).toEqual({ type: 'welcome', fileName: 'Landing Page' });

  const bad = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  sockets.push(bad);
  const badGot: any[] = [];
  bad.on('message', (raw) => badGot.push(raw.toString()));
  await new Promise((r) => bad.once('open', r));
  bad.send(JSON.stringify({ ...hello, secret: 'wrong' }));
  await new Promise((r) => bad.once('close', r));
  expect(badGot).toEqual([]);
});

test('unintroduced counts open links that never sent a hello', async () => {
  await startBridge();
  const silent = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  sockets.push(silent);
  await new Promise((r) => silent.once('open', r));
  await waitFor(() => bridge.unintroduced() === 1);
  await connect(answer);
  expect(bridge.unintroduced()).toBe(1);
  expect(bridge.files()).toHaveLength(1);
});
