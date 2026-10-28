import type WebSocket from 'ws';
import type { FigmaLink, Hello } from '@pixel-twin/shared';
import { PluginBridge } from '../src/bridge';
import { NodeNotFoundError } from '../src/errors';
import { pickFile } from '../src/files';
import { startFakePlugin } from './helpers/mcp';

const SECRET = 'test-secret';
const hello = (fileName: string, fileKey: string | null): Hello =>
  ({ type: 'hello', fileName, fileKey, editorType: 'figma', pluginVersion: '0.1.0', secret: SECRET });
const link = (over: Partial<FigmaLink> = {}): FigmaLink =>
  ({ fileKey: 'AbC123', fileSlug: 'Landing-Page', nodeId: null, ...over });

let bridge: PluginBridge;
let sockets: WebSocket[];

beforeEach(async () => {
  sockets = [];
  bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs: 1000, secret: SECRET });
  await bridge.start();
});
afterEach(async () => {
  sockets.forEach((s) => s.terminate());
  await bridge.stop();
});

async function plugin(h: Hello, nodes: string[] = []) {
  sockets.push(await startFakePlugin(bridge, h, (_m, p) => {
    const id = (p as { nodeId: string }).nodeId;
    return { exists: nodes.includes(id), pageId: nodes.includes(id) ? '0:1' : null };
  }));
}

test('a fileKey match wins', async () => {
  await plugin(hello('Landing Page', null));
  await plugin(hello('Something else', 'AbC123'));
  const file = await pickFile(bridge, link());
  expect(file.fileKey).toBe('AbC123');
});

test('without fileKey, matches by name and node', async () => {
  await plugin(hello('Landing Page', null), []);
  await plugin(hello('Landing Page', null), ['1:2']);
  const file = await pickFile(bridge, link({ nodeId: '1:2' }));
  const withNode = bridge.files()[1];
  expect(file.connectionId).toBe(withNode.connectionId);
});

test('names match ignoring case, spaces and dashes', async () => {
  await plugin(hello('landing page', null));
  const file = await pickFile(bridge, link());
  expect(file.fileName).toBe('landing page');
});

test('no running plugin → NoPluginError', async () => {
  await expect(pickFile(bridge, link())).rejects.toThrow(
    'No open Figma file has Pixel Twin running. Open "Landing Page" in the Figma desktop app, then run Plugins → Development → Pixel Twin.');
});

test('two equal candidates → AmbiguousFileError naming both', async () => {
  await plugin(hello('Landing Page', null));
  await plugin(hello('Landing page', null));
  await expect(pickFile(bridge, link())).rejects.toThrow(/Landing Page.*Landing page/);
});

test('a file with a different fileKey is never chosen by name', async () => {
  await plugin(hello('Landing Page', 'OTHER'));
  await expect(pickFile(bridge, link())).rejects.toThrow('No open Figma file has Pixel Twin running');
});

test('one name match without the node → says the layer is missing', async () => {
  await plugin(hello('Landing Page', null), []);
  const err = await pickFile(bridge, link({ nodeId: '1:2' })).catch((e) => e);
  expect(err).toBeInstanceOf(NodeNotFoundError);
  expect(err.message).toBe('"Landing Page" is open with Pixel Twin running, but it has no layer 1:2. Check that the link points to this file.');
});

test('a plugin that fails hasNode does not break the pick', async () => {
  sockets.push(await startFakePlugin(bridge, hello('Landing Page', null), () => { throw new Error('boom'); }));
  await plugin(hello('Landing Page', null), ['1:2']);
  const file = await pickFile(bridge, link({ nodeId: '1:2' }));
  expect(file.connectionId).toBe(bridge.files()[1].connectionId);
});
