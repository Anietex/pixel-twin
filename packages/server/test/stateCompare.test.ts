import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import type { Client } from '@modelcontextprotocol/client';
import { PluginBridge } from '../src/bridge';
import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import type { ServerDeps } from '../src/createServer';
import { toSectionData, type RestNode } from '../src/design/normalize';
import { asState } from '../src/design/stateSection';
import { connectTestClient, startFakePlugin } from './helpers/mcp';

const LINK = 'https://www.figma.com/design/K/Landing?node-id=1-3';
const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 });
const label = (id: string, x: number, y: number) => ({
  id, name: 'Label', type: 'TEXT', characters: 'Get started', absoluteBoundingBox: { x, y, width: 100, height: 24 },
  style: { fontFamily: 'Helvetica', fontWeight: 400, fontSize: 16, lineHeightPx: 24, letterSpacing: 0, textAlignHorizontal: 'CENTER', textAutoResize: 'NONE' },
  fills: [{ type: 'SOLID', color: rgb('#FFFFFF') }],
});
/** The button the page shows (an instance) and its Hover variant, which has its own layer ids. */
const DOCS: Record<string, unknown> = {
  '1:3': { id: '1:3', name: 'Save', type: 'INSTANCE', absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 48 },
    fills: [{ type: 'SOLID', color: rgb('#2255FF') }], children: [label('I1:3;9:5', 30, 12)] },
  '9:2': { id: '9:2', name: 'State=Hover', type: 'COMPONENT', absoluteBoundingBox: { x: 500, y: 500, width: 160, height: 48 },
    fills: [{ type: 'SOLID', color: rgb('#1144DD') }], children: [label('9:6', 530, 512)] },
};
const PAGE = (hover: string) => `<!doctype html><html><head><style>
  body { margin: 0; font-family: Helvetica, Arial, sans-serif; }
  #btn { display: flex; align-items: center; justify-content: center; width: 160px; height: 48px; background: #2255FF;
    color: #fff; text-decoration: none; transition: background-color 200ms ease-out; }
  ${hover}
  #btn span { display: block; width: 100px; height: 24px; font-size: 16px; line-height: 24px; text-align: center; }
</style></head><body><a id="btn" href="#" data-figma-id="1:3"><span data-figma-id="I1:3;9:5">Get started</span></a></body></html>`;

let site: Server;
let base: string;
let browser: BrowserProvider;
let hoverPng: string;
let bridge: PluginBridge;
let socket: WebSocket;
let client: Client;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-state-site-'));
  await writeFile(path.join(dir, 'button.html'), PAGE('#btn:hover { background: #1144DD; }'));
  await writeFile(path.join(dir, 'no-hover.html'), PAGE(''));
  site = createServer(async (req, res) => {
    try {
      const body = await readFile(path.join(dir, path.basename(new URL(req.url ?? '/', 'http://x').pathname)));   // before writeHead, so a missing file can still get a 404
      res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = createBrowserProvider();
  // The "design" picture of the Hover variant is a 2x picture of the hovered build.
  const s = await browser.open(`${base}/button.html`, 400, 2, () => true);
  try {
    await s.page.locator('#btn').hover();
    await s.page.waitForTimeout(400);
    hoverPng = (await s.page.locator('#btn').screenshot()).toString('base64');
  } finally {
    await s.close();
  }
  bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs: 5000, secret: 'test-secret' });
  await bridge.start();
  socket = await startFakePlugin(bridge, { type: 'hello', fileName: 'Landing', fileKey: 'K', editorType: 'figma', pluginVersion: '0.2.0' },
    (method, params) => {
      const { nodeId } = params as { nodeId: string };
      switch (method) {
        case 'hasNode': return { exists: true, pageId: '0:1' };
        case 'getNodeJson': return { document: DOCS[nodeId] };
        case 'getTextDetails': case 'resolveVariables': return [];
        case 'exportNode': return { base64: hoverPng };
        default: throw new Error(`Unknown request: ${method}`);
      }
    });
  const workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-state-'));
  const deps: ServerDeps = { bridge, bridgeError: null, workDir, browser };
  client = await connectTestClient(deps);
}, 60_000);

afterAll(async () => {
  await client?.close();
  socket?.terminate();
  await bridge?.stop();
  await browser?.close();
  await new Promise((r) => site?.close(r));
});

const compareHover = async (file: string) => {
  const res: any = await client.callTool({ name: 'compare', arguments: {
    link: LINK, url: `${base}/${file}`, selector: '#btn', width: 400, reset: true, state: { kind: 'hover', nodeId: '9-2' } } });
  return JSON.parse(res.content[0].text);
};

test('the hovered button matches the Hover variant, pairing its layers by name', async () => {
  const r = await compareHover('button.html');
  expect(r).toMatchObject({ pass: true, differences: [], unmapped: [], regions: [] });
}, 30_000);

test('a button with no hover style fails on the Hover variant\'s colour', async () => {
  const r = await compareHover('no-hover.html');
  expect(r.pass).toBe(false);
  expect(r.differences).toContainEqual(expect.objectContaining({ layerId: '1:3', property: 'background-color' }));
}, 30_000);

test('a state layer pairs with the shown layer of the same name path; a layer only the state has keeps its id', () => {
  const shown = toSectionData({ document: DOCS['1:3'] as RestNode, textDetails: [], variables: [] });
  const hover = toSectionData({ document: { ...(DOCS['9:2'] as object), children: [label('9:6', 530, 512), { ...label('9:7', 530, 530), name: 'Underline' }] } as unknown as RestNode,
    textDetails: [], variables: [] });
  const paired = asState(hover, shown);
  expect(paired.rootId).toBe('1:3');
  expect(paired.root.id).toBe('1:3');
  expect(paired.root.children.map((c) => c.id)).toEqual(['I1:3;9:5', '9:7']);
});
