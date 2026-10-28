import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import type WebSocket from 'ws';
import type { Client } from '@modelcontextprotocol/client';
import { PluginBridge } from '../src/bridge';
import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import type { ServerDeps } from '../src/createServer';
import { connectTestClient, startFakePlugin } from './helpers/mcp';

const fixtures = path.join(__dirname, 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const rest = load('hero.rest.json');
const textDetails = load('hero.text.json');
const vars = load('hero.vars.json');
const LINK = 'https://www.figma.com/design/K/Landing?node-id=1-1';
const TYPES: Record<string, string> = { '.html': 'text/html', '.png': 'image/png' };

let site: Server;
let base: string;
let browser: BrowserProvider;
let designPng: string;
let bridge: PluginBridge;
let sockets: WebSocket[];
let client: Client;
let workDir: string;
let nodeJson: unknown;    // what the fake plugin returns for the design
let exportPng: string;    // and for the design picture
/** What the fake plugin returns for getOutline: a page frame with the hero and a section not built yet. */
const outline = [{ id: '0:5', name: 'Page', type: 'FRAME', x: 0, y: 0, width: 600, height: 900, visible: true, childCount: 3, children: [
  { id: '1:20', name: 'Footer', type: 'FRAME', x: 0, y: 700, width: 600, height: 200, visible: true, childCount: 0 },
  { id: '1:1', name: 'Hero', type: 'FRAME', x: 0, y: 0, width: 600, height: 200, visible: true, childCount: 6 },
  { id: '1:30', name: 'Hidden', type: 'FRAME', x: 0, y: 300, width: 600, height: 200, visible: false, childCount: 0 },
] }];

/** A 216 × 152 photo with a simple colour ramp, so the overlay has detail to compare. */
function photo(): Buffer {
  const p = new PNG({ width: 216, height: 152 });
  for (let y = 0; y < 152; y++) {
    for (let x = 0; x < 216; x++) p.data.set([x, y, 160, 255], (y * 216 + x) * 4);
  }
  return PNG.sync.write(p);
}

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-site-'));
  for (const f of ['hero.html', 'hero-shifted.html']) await copyFile(path.join(fixtures, f), path.join(dir, f));
  await writeFile(path.join(dir, 'photo.png'), photo());
  const hero = await readFile(path.join(fixtures, 'hero.html'), 'utf8');
  // The section fades in over 4 s, and stays at full opacity after.
  await writeFile(path.join(dir, 'hero-fade.html'), hero.replace('</style>',
    '  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }\n    #hero { animation: fade-in 4s forwards; }\n  </style>'));
  // The section is added 300 ms after the page has loaded.
  await writeFile(path.join(dir, 'hero-late.html'), hero
    .replace(/<section id="hero"[\s\S]*<\/section>/, (m) => `<template id="later">${m}</template>`)
    .replace('</body>', '<script>setTimeout(() => document.getElementById(\'app\').append('
      + 'document.getElementById(\'later\').content.cloneNode(true)), 300);</script>\n</body>'));
  site = createServer(async (req, res) => {
    try {
      const file = path.join(dir, path.basename(new URL(req.url ?? '/', 'http://x').pathname));
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = createBrowserProvider();
  // The "design" picture is a 2x screenshot of the exact build.
  const session = await browser.open(`${base}/hero.html`, 600, 2, () => true);
  try {
    designPng = (await session.page.locator('#hero').screenshot()).toString('base64');
  } finally {
    await session.close();
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
});

beforeEach(async () => {
  sockets = [];
  nodeJson = rest;
  exportPng = designPng;
  workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-compare-'));
  bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs: 5000, secret: 'test-secret' });
  await bridge.start();
  sockets.push(await startFakePlugin(bridge,
    { type: 'hello', fileName: 'Landing', fileKey: 'K', editorType: 'figma', pluginVersion: '0.1.0' },
    (method) => {
      switch (method) {
        case 'hasNode': return { exists: true, pageId: '0:1' };
        case 'getNodeJson': return nodeJson;
        case 'getTextDetails': return textDetails;
        case 'resolveVariables': return vars;
        case 'exportNode': return { base64: exportPng };
        case 'getOutline': return outline;
        default: throw new Error(`unexpected ${method}`);
      }
    }));
  const deps: ServerDeps = { bridge, bridgeError: null, workDir, browser };
  client = await connectTestClient(deps);
});

afterEach(async () => {
  await client?.close();
  sockets.forEach((s) => s.terminate());
  await bridge.stop();
});

const compareRaw = (over: Record<string, unknown> = {}): Promise<any> => client.callTool({
  name: 'compare', arguments: { link: LINK, url: `${base}/hero.html`, selector: '#hero', width: 600, ...over },
});
const compare = async (file: string) => JSON.parse((await compareRaw({ url: `${base}/${file}` })).content[0].text);

test('the exact build passes', async () => {
  const r = await compare('hero.html');
  expect(r).toMatchObject({ pass: true, total: 0, unmapped: [], differences: [], regions: [], width: 600, roundsWithoutProgress: 0, shouldStop: false,
    checkByEye: [], cannotMatch: [] });
  expect(r).not.toHaveProperty('warnings');   // they are split into checkByEye and cannotMatch
}, 30_000);

test('a section that fades in is measured after its animation ends', async () => {
  const r = await compare('hero-fade.html');
  expect(r).toMatchObject({ pass: true, total: 0, differences: [], regions: [] });
}, 30_000);

test('a section added after the page loads is still found', async () => {
  const r = await compare('hero-late.html');
  expect(r).toMatchObject({ pass: true, total: 0, differences: [], regions: [] });
}, 30_000);

test('a shifted button fails on x and marks a region near it', async () => {
  const r = await compare('hero-shifted.html');
  expect(r.pass).toBe(false);
  expect(r.differences).toContainEqual(expect.objectContaining({ layerId: '1:3', property: 'x', design: 24, build: 26 }));
  expect(r.regions.some((g: any) => g.x >= 20 && g.x <= 190 && g.y >= 115 && g.y <= 170)).toBe(true);
  // Each area is named, with the layers it touches: the button's two edges and its label all moved 2 px right.
  expect(r.regions.map((g: any) => [g.kind, g.label, g.layers.map((l: any) => l.layerName).join()]).sort()).toEqual([
    ['shifted', 'same content shifted 2 px right', 'Button'],
    ['shifted', 'same content shifted 2 px right', 'Button'],
    ['shifted', 'same content shifted 2 px right', 'Label'],
  ]);
}, 30_000);

test('plain errors for a bad target', async () => {
  const nope = await compareRaw({ selector: '#nope' });
  expect(nope).toMatchObject({ isError: true });
  expect(nope.content[0].text).toBe(`No element matches "#nope" on ${base}/hero.html`);
  const many = await compareRaw({ selector: 'div' });
  expect(many).toMatchObject({ isError: true });
  expect(many.content[0].text).toMatch(/^The selector "div" matches \d+ elements; it must match exactly one$/);
  const down = await compareRaw({ url: 'http://127.0.0.1:1/' });
  expect(down).toMatchObject({ isError: true });
  expect(down.content[0].text).toBe('Could not open http://127.0.0.1:1/. Is the app running?');
}, 40_000);   // "#nope" waits 10 s for the section to appear

test('saves the three images, returns the 1x difference picture and counts rounds', async () => {
  const first = await compareRaw();
  const body = JSON.parse(first.content[0].text);
  const dir = path.join(workDir, '.pixel-twin', 'compare', '1-1@600');
  expect(body.images).toEqual({
    design: path.join(dir, 'design.png'), build: path.join(dir, 'build.png'), diff: path.join(dir, 'diff.png') });
  expect(PNG.sync.read(await readFile(body.images.diff)).width).toBe(1200);
  expect(first.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  expect(PNG.sync.read(Buffer.from(first.content[1].data, 'base64')).width).toBe(600);
  const second = JSON.parse((await compareRaw()).content[0].text);
  expect(second.roundsWithoutProgress).toBe(1);
  const fresh = JSON.parse((await compareRaw({ reset: true })).content[0].text);
  expect(fresh.roundsWithoutProgress).toBe(0);
}, 30_000);

test('a section root that is not visible gets a plain error', async () => {
  const r = await compareRaw({ selector: 'title' });
  expect(r).toMatchObject({ isError: true });
  expect(r.content[0].text).toBe(`Could not take a picture of "title" on ${base}/hero.html. Is it visible on the page?`);
}, 20_000);

test('a page that fails to close does not hide the result', async () => {
  const flaky: BrowserProvider = {
    open: async (...args) => {
      const s = await browser.open(...args);
      return { page: s.page, close: async () => { await s.close(); throw new Error('Target closed'); } };
    },
    close: async () => undefined,
  };
  await client.close();
  client = await connectTestClient({ bridge, bridgeError: null, workDir, browser: flaky });
  const r = await compareRaw();
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(r.content[0].text).pass).toBe(true);
}, 30_000);

test('only pages on this computer and files inside the project are opened', async () => {
  const refused = 'Pixel Twin only opens pages on this computer\'s development server (localhost) or files inside the project.';
  for (const url of ['https://example.com', 'data:text/html,<p>hi</p>', 'file:///etc/hosts']) {
    const r = await compareRaw({ url });
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0].text).toBe(refused);
  }
  await copyFile(path.join(fixtures, 'hero.html'), path.join(workDir, 'hero.html'));
  await writeFile(path.join(workDir, 'photo.png'), photo());
  const local = await compareRaw({ url: pathToFileURL(path.join(workDir, 'hero.html')).href });
  expect(JSON.parse(local.content[0].text)).toMatchObject({ pass: true, total: 0 });
}, 30_000);

/** Reconnects the test client with a different browser provider. */
async function useBrowser(provider: BrowserProvider) {
  await client.close();
  client = await connectTestClient({ bridge, bridgeError: null, workDir, browser: provider });
}

test('other browser failures get plain words without the call log', async () => {
  await useBrowser({
    open: async () => { throw new Error('browserContext.newPage: Target crashed\nCall log:\n  - waiting for page'); },
    close: async () => undefined,
  });
  expect((await compareRaw()).content[0].text).toBe('Pixel Twin couldn\'t measure the page: Target crashed');
  await useBrowser({
    open: async (...args) => {
      const s = await browser.open(...args);
      await s.page.close();   // the page is gone before measuring starts
      return s;
    },
    close: async () => undefined,
  });
  const gone = await compareRaw();
  expect(gone).toMatchObject({ isError: true });
  expect(gone.content[0].text).toMatch(/^Pixel Twin couldn't measure the page: Target page, context or browser has been closed$/);
  await useBrowser(browser);
  expect((await compareRaw({ selector: '##' })).content[0].text).toBe('The selector "##" is not a valid selector');
}, 30_000);

test('something no browser can draw stops a pass, but is not a difference', async () => {
  const noisy = structuredClone(rest);
  noisy.document.children.find((c: any) => c.id === '1:3').effects.push({ type: 'NOISE', visible: true });
  nodeJson = noisy;
  const r = await compare('hero.html');
  expect(r).toMatchObject({ pass: false, total: 0, differences: [], checkByEye: [] });
  expect(r.cannotMatch).toEqual([{ layerId: '1:3', layerName: 'Button', reason: 'Has a texture/noise effect, which browsers can\'t draw exactly' }]);
}, 30_000);

test('a design picture of another size is noted for a check by eye', async () => {
  const p = new PNG({ width: 1220, height: 420 });   // 10 px of shadow around the 1200 x 400 frame
  p.data.fill(255);
  exportPng = PNG.sync.write(p).toString('base64');
  const r = await compare('hero.html');
  expect(r.pass).toBe(true);   // the numbers still match
  expect(r.checkByEye).toEqual([{ layerId: '1:1', layerName: 'Hero', property: 'picture',
    reason: 'Design picture is a different size from the section; overlay may be shifted' }]);
}, 30_000);

test('a page that moves to a file outside the project is refused, and nothing is pictured', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'pixel-twin-outside-'));
  await writeFile(path.join(outside, 'secret.html'), '<p>secret</p>');
  const hero = await readFile(path.join(fixtures, 'hero.html'), 'utf8');
  const target = JSON.stringify(pathToFileURL(path.join(outside, 'secret.html')).href);
  await writeFile(path.join(workDir, 'photo.png'), photo());
  // Leaves while loading.
  await writeFile(path.join(workDir, 'leave-now.html'), hero.replace('<head>', `<head><script>location.href = ${target};</script>`));
  // Leaves 100 ms after loading, before the section (added at 300 ms) appears.
  await writeFile(path.join(workDir, 'leave-later.html'), hero
    .replace(/<section id="hero"[\s\S]*<\/section>/, (m) => `<template id="later">${m}</template>`)
    .replace('</body>', `<script>setTimeout(() => { location.href = ${target}; }, 100);`
      + 'setTimeout(() => document.getElementById(\'app\').append(document.getElementById(\'later\').content.cloneNode(true)), 300);</script></body>'));
  const refused = 'Pixel Twin only opens pages on this computer\'s development server (localhost) or files inside the project.';
  for (const page of ['leave-now.html', 'leave-later.html']) {
    const r = await compareRaw({ url: pathToFileURL(path.join(workDir, page)).href });
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0].text).toBe(refused);
  }
  expect(existsSync(path.join(workDir, '.pixel-twin', 'compare'))).toBe(false);
}, 40_000);   // "leave-later" waits 10 s for a section that never appears

test('compare_page returns one row per section and saves each full result', async () => {
  const res: any = await client.callTool({ name: 'compare_page', arguments: {
    link: LINK, url: `${base}/hero.html`, width: 600,
    sections: [{ nodeId: '1-1', selector: '#hero' }, { nodeId: '1:1', selector: 'div' }],
  } });
  expect(res.isError).toBeFalsy();
  const body = JSON.parse(res.content[0].text);
  expect(body.sections[0]).toMatchObject({ nodeId: '1:1', name: 'Hero', pass: true, differences: 0, unmapped: 0 });
  expect(existsSync(body.sections[0].result)).toBe(true);
  // A bad selector only fails its own row.
  expect(body.sections[1]).toMatchObject({ pass: false, error: expect.stringMatching(/matches \d+ elements/) });
}, 40_000);

test('compare_page finds the sections on the page when none are given', async () => {
  const res: any = await client.callTool({ name: 'compare_page', arguments: { link: LINK, url: `${base}/hero.html`, width: 600 } });
  const body = JSON.parse(res.content[0].text);
  expect(body.found).toBe('page');
  expect(body.sections).toMatchObject([{ nodeId: '1:1', selector: '[data-figma-id="1:1"]', pass: true }]);
}, 40_000);

test('compare_page with a page frame link lists its visible children top to bottom, built or not', async () => {
  const res: any = await client.callTool({ name: 'compare_page', arguments: {
    link: 'https://www.figma.com/design/K/Landing?node-id=0-5', url: `${base}/hero.html`, width: 600 } });
  const body = JSON.parse(res.content[0].text);
  expect(body.found).toBe('figma-frame');
  expect(body.sections.map((r: any) => r.nodeId)).toEqual(['1:1', '1:20']);
  expect(body.sections[0].pass).toBe(true);
  expect(body.sections[1]).toMatchObject({ pass: false, error: expect.stringMatching(/No element matches/) });
}, 40_000);
