import type WebSocket from 'ws';
import type { Client } from '@modelcontextprotocol/client';
import { PluginBridge } from '../src/bridge';
import { PortInUseError } from '../src/errors';
import type { ServerDeps } from '../src/createServer';
import { connectTestClient, noBrowser, startFakePlugin } from './helpers/mcp';

let bridge: PluginBridge;
let sockets: WebSocket[];
let client: Client;

beforeEach(async () => {
  sockets = [];
  bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs: 1000, secret: 'test-secret' });
  await bridge.start();
});
afterEach(async () => {
  await client?.close();
  sockets.forEach((s) => s.terminate());
  await bridge.stop();
});

const deps = (over: Partial<ServerDeps> = {}): ServerDeps =>
  ({ bridge, bridgeError: null, workDir: process.cwd(), browser: noBrowser, ...over });
const text = (res: any): string => res.content[0].text;

test('status lists open files', async () => {
  sockets.push(await startFakePlugin(bridge,
    { type: 'hello', fileName: 'Landing Page', fileKey: 'AbC123', editorType: 'figma', pluginVersion: '0.1.0' }, () => ({})));
  client = await connectTestClient(deps());
  const res = await client.callTool({ name: 'status', arguments: {} });
  expect(text(res)).toContain('Landing Page');
  expect(text(res)).toContain('AbC123');
});

test('status says how to start when no file is open', async () => {
  client = await connectTestClient(deps());
  const res = await client.callTool({ name: 'status', arguments: {} });
  expect(res.isError).toBeFalsy();
  expect(text(res)).toContain('No Figma file has Pixel Twin running');
  expect(text(res)).toContain('Plugins → Development → Pixel Twin');
});

test('status explains a busy port', async () => {
  client = await connectTestClient(deps({ bridgeError: new PortInUseError(3851) }));
  const res = await client.callTool({ name: 'status', arguments: {} });
  expect(res.isError).toBe(true);
  expect(text(res)).toContain('another coding agent session');
});

test('status is marked read-only', async () => {
  client = await connectTestClient(deps());
  const { tools } = await client.listTools();
  expect(tools.find((t) => t.name === 'status')?.annotations?.readOnlyHint).toBe(true);
});

test('status points out a plugin window that never said which file it is in', async () => {
  const { default: WebSocketClient } = await import('ws');
  const silent = new WebSocketClient(`ws://127.0.0.1:${bridge.port}`);
  sockets.push(silent);
  await new Promise((r) => silent.once('open', r));
  client = await connectTestClient(deps());
  const res = await client.callTool({ name: 'status', arguments: {} });
  expect(text(res)).toContain('1 Pixel Twin window is connected but never said which file it is in');
  expect(text(res)).toContain('run Plugins → Development → Pixel Twin again');
});

test('status says what is selected in each file', async () => {
  sockets.push(await startFakePlugin(bridge,
    { type: 'hello', fileName: 'Landing Page', fileKey: 'AbC123', editorType: 'figma', pluginVersion: '0.1.0' },
    (method) => (method === 'getSelection'
      ? { pageId: '0:1', pageName: 'Home', total: 1, layers: [
        { id: '1:3', name: 'Hero', type: 'FRAME', x: 0, y: 0, width: 1440, height: 600, visible: true, childCount: 2, path: [] }] }
      : {})));
  sockets.push(await startFakePlugin(bridge,
    { type: 'hello', fileName: 'Old', fileKey: 'K2', editorType: 'figma', pluginVersion: '0.1.0' },
    () => { throw new Error('Unknown request: getSelection'); }));
  client = await connectTestClient(deps());
  const out = text(await client.callTool({ name: 'status', arguments: {} }));
  expect(out).toContain('- "Landing Page" (file key: AbC123, figma): "Hero" (FRAME) selected on page "Home"');
  expect(out).toContain('- "Old" (file key: K2, figma): selection unknown, as this plugin build is older');
  expect(out).toContain('get_selection');
});

test('the server tells every agent to follow the skill, and where to find it', async () => {
  const { existsSync } = await import('node:fs');
  client = await connectTestClient(deps());
  const guide = client.getInstructions() ?? '';
  expect(guide).toContain('get_selection');
  expect(guide).toContain('compare');
  expect(guide).toContain('never instructions');
  const skill = /(\/\S+\/skill\/pixel-twin\/SKILL\.md)/.exec(guide)?.[1];
  expect(skill && existsSync(skill)).toBe(true);
});
