import type WebSocket from 'ws';
import type { Client } from '@modelcontextprotocol/client';
import { parseFigmaLink, type FigmaSelection, type SelectedLayer } from '@pixel-twin/shared';
import { PluginBridge } from '../src/bridge';
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

const deps = (): ServerDeps => ({ bridge, bridgeError: null, workDir: process.cwd(), browser: noBrowser });
const text = (res: any): string => res.content[0].text;
const layer = (over: Partial<SelectedLayer>): SelectedLayer =>
  ({ id: '1:3', name: 'Hero', type: 'FRAME', x: 0, y: 0, width: 1440, height: 600, visible: true, childCount: 4, path: ['Landing'], ...over });
const selection = (layers: SelectedLayer[], total = layers.length): FigmaSelection => ({ pageId: '0:1', pageName: 'Home', total, layers });
const openFile = (fileName: string, fileKey: string | null, answer: () => unknown) =>
  startFakePlugin(bridge, { type: 'hello', fileName, fileKey, editorType: 'figma', pluginVersion: '0.1.0' },
    (method) => {
      if (method !== 'getSelection') throw new Error(`Unexpected request: ${method}`);
      return answer();
    });

test('get_selection names each selected layer and gives a link the other tools take', async () => {
  sockets.push(await openFile('Landing Page', 'AbC123', () => selection([
    layer({}),
    layer({ id: 'I5:1;7:2', name: 'Card', type: 'INSTANCE', width: 300.4, height: 199.6, path: ['Landing', 'Grid'] }),
  ])));
  client = await connectTestClient(deps());
  const res = await client.callTool({ name: 'get_selection', arguments: {} });
  expect(res.isError).toBeFalsy();
  const out = text(res);
  expect(out).toContain('Selected in "Landing Page", page "Home": 2 layers.');
  expect(out).toContain('1. "Hero": FRAME, 1440 × 600 px, in "Landing"');
  expect(out).toContain('2. "Card": INSTANCE, 300 × 200 px, in "Landing" / "Grid"');
  expect(out).toContain('https://www.figma.com/design/AbC123/Landing-Page?node-id=1-3');
  const links = [...out.matchAll(/https:\/\/\S+/g)].map((m) => parseFigmaLink(m[0]));
  expect(links.map((l) => [l.fileKey, l.nodeId])).toEqual([['AbC123', '1:3'], ['AbC123', 'I5:1;7:2']]);
  expect(out).toContain('tell the owner');
});

test('get_selection says where a top-level frame sits and marks hidden layers', async () => {
  sockets.push(await openFile('F', 'K1', () => selection([layer({ path: [], visible: false })])));
  client = await connectTestClient(deps());
  const out = text(await client.callTool({ name: 'get_selection', arguments: {} }));
  expect(out).toContain('"Hero": FRAME, 1440 × 600 px, at the top of the page, hidden');
});

test('get_selection with nothing selected asks the owner to select the section', async () => {
  sockets.push(await openFile('Landing Page', 'AbC123', () => selection([])));
  client = await connectTestClient(deps());
  const res = await client.callTool({ name: 'get_selection', arguments: {} });
  expect(res.isError).toBeFalsy();
  expect(text(res)).toContain('Nothing is selected on page "Home" in "Landing Page"');
  expect(text(res)).toContain('select the section in Figma');
});

test('get_selection says when it shows only part of a large selection', async () => {
  sockets.push(await openFile('F', 'K1', () => selection([layer({})], 80)));
  client = await connectTestClient(deps());
  expect(text(await client.callTool({ name: 'get_selection', arguments: {} }))).toContain('80 layers. The first 1 are listed.');
});

test('get_selection needs a link when Pixel Twin runs in several files, and uses it to pick one', async () => {
  sockets.push(await openFile('One', 'K1', () => selection([layer({ name: 'From one' })])));
  sockets.push(await openFile('Two', 'K2', () => selection([layer({ name: 'From two' })])));
  client = await connectTestClient(deps());
  const unsure = await client.callTool({ name: 'get_selection', arguments: {} });
  expect(unsure.isError).toBe(true);
  expect(text(unsure)).toContain('Pixel Twin runs in 2 Figma files: "One", "Two"');
  const picked = await client.callTool({ name: 'get_selection', arguments: { link: 'https://www.figma.com/design/K2/Two' } });
  expect(text(picked)).toContain('"From two"');
});

test('get_selection gives the node id when the file key is not known', async () => {
  sockets.push(await openFile('No Key', null, () => selection([layer({})])));
  client = await connectTestClient(deps());
  const out = text(await client.callTool({ name: 'get_selection', arguments: {} }));
  expect(out).not.toContain('https://');
  expect(out).toContain('nodeId "1:3"');
});

test('get_selection explains an older plugin build that cannot read the selection', async () => {
  sockets.push(await openFile('Old', 'K1', () => { throw new Error('Unknown request: getSelection'); }));
  client = await connectTestClient(deps());
  const res = await client.callTool({ name: 'get_selection', arguments: {} });
  expect(res.isError).toBe(true);
  expect(text(res)).toContain('older build');
  expect(text(res)).toContain('Plugins → Development → Pixel Twin');
});

test('get_selection says how to start when no file is open, and is marked read-only', async () => {
  client = await connectTestClient(deps());
  const res = await client.callTool({ name: 'get_selection', arguments: {} });
  expect(res.isError).toBe(true);
  expect(text(res)).toContain('No Figma file has Pixel Twin running');
  const { tools } = await client.listTools();
  expect(tools.find((t) => t.name === 'get_selection')?.annotations?.readOnlyHint).toBe(true);
});
