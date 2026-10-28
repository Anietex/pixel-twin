import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import type { Client } from '@modelcontextprotocol/client';
import { PluginBridge } from '../src/bridge';
import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import type { ServerDeps } from '../src/createServer';
import { checkResponsive, type Problem } from '../src/responsive/checks';
import { connectTestClient, startFakePlugin } from './helpers/mcp';

const fixtures = path.join(__dirname, 'fixtures');

let site: Server;
let base: string;
let browser: BrowserProvider;
let shotsDir: string;
let good: Problem[];
let bad: { problems: Problem[]; screenshots: Record<number, string> };

const run = (file: string, over: Partial<Parameters<typeof checkResponsive>[1]> = {}) => checkResponsive(browser, {
  url: `${base}/${file}`, selector: 'section', designWidth: 600, designOverlaps: [], tabletMax: 1023,
  shotsDir, isAllowed: () => true, ...over,
});

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-responsive-site-'));
  for (const f of ['responsive-good.html', 'responsive-bad.html', 'responsive-phone.html', 'hero.html']) await copyFile(path.join(fixtures, f), path.join(dir, f));
  site = createServer(async (req, res) => {
    try {
      const body = await readFile(path.join(dir, path.basename(new URL(req.url ?? '/', 'http://x').pathname)));
      res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = createBrowserProvider();
  shotsDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-shots-'));
  good = (await run('responsive-good.html')).problems;
  bad = await run('responsive-bad.html');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
});

const kinds = (problems: Problem[]) => new Set(problems.map((p) => p.kind));

test('a good page has no problems', () => {
  expect(good).toEqual([]);
});

test('a bad page reports every kind', () => {
  expect(kinds(bad.problems)).toEqual(new Set(['sideways-scroll', 'overlap', 'small-text', 'small-tap', 'image-shape', 'not-centred', 'not-full-width']));
});

test('sideways scroll is reported as a width range starting at 320', () => {
  const scroll = bad.problems.find((p) => p.kind === 'sideways-scroll')!;
  expect(scroll.widths[0][0]).toBe(320);
  expect(scroll.element).toBe('[data-figma-id="1:1"]');
});

test('small tap areas are checked only up to tabletMax', () => {
  const taps = bad.problems.filter((p) => p.kind === 'small-tap');
  expect(taps.map((p) => p.element)).toEqual(['[data-figma-id="1:3"]']);
  expect(taps.flatMap((p) => p.widths).every(([, to]) => to <= 1023)).toBe(true);
});

test('a link inside a paragraph is not a tap-area problem', () => {
  expect(bad.problems.some((p) => p.element.includes('inline-link') || p.other?.includes('inline-link'))).toBe(false);
});

test('overlaps are reported only at the widths where they happen', () => {
  const overlap = bad.problems.find((p) => p.kind === 'overlap')!;
  expect([overlap.element, overlap.other]).toEqual(['[data-figma-id="1:5"]', '[data-figma-id="1:6"]']);
  expect(overlap.widths.every(([, to]) => to < 500)).toBe(true);
});

test('overlaps that exist in the design are allowed', async () => {
  const r = await run('responsive-bad.html', { designOverlaps: [['1:6', '1:5']], toWidth: 520, step: 40 });
  expect(r.problems.some((p) => p.kind === 'overlap')).toBe(false);
}, 60_000);

test('screenshots at 390, 768 and 1920 are saved', () => {
  expect(Object.keys(bad.screenshots).map(Number)).toEqual([390, 768, 1920]);
  for (const file of Object.values(bad.screenshots)) expect(existsSync(file)).toBe(true);
});

describe('a whole page with a separate phone layout', () => {
  let page: { problems: Problem[]; screenshots: Record<number, string> };
  const phone = { maxWidth: 767, selector: '#phone', overlaps: [['20:3', '20:4']] as [string, string][] };
  beforeAll(async () => {
    page = await run('responsive-phone.html', { selector: '#desktop', designWidth: 1000, phone });
  }, 60_000);

  test('centring is checked per section, and full-width backgrounds don\'t count', () => {
    expect(page.problems.filter((p) => p.kind === 'not-centred').map((p) => p.element)).toEqual(['[data-figma-id="10:7"]']);
  });

  test('a tap area is measured by tapping around the element, so an invisible bigger area counts', () => {
    const taps = page.problems.filter((p) => p.kind === 'small-tap');
    expect(taps.map((p) => p.element)).toEqual(['[data-figma-id="10:10"]']);
    expect(taps[0].detail).toBe('Tap area is 24 × 24 px (measured by tapping around it); it must be at least 44 × 44 px');
  });

  test('a picture one pixel off its file\'s shape is rounding, not a stretched picture', () => {
    expect(page.problems.filter((p) => p.kind === 'image-shape')).toEqual([]);
  });

  test('phone widths use the phone layout and the phone design\'s overlaps', async () => {
    expect(page.problems.filter((p) => p.kind === 'overlap')).toEqual([]);
    expect(Object.keys(page.screenshots).map(Number)).toEqual([390, 768, 1920]);
    const without = await run('responsive-phone.html', { selector: '#desktop', designWidth: 1000, phone: { maxWidth: 767, selector: '#phone' }, toWidth: 800, step: 100 });
    const overlaps = without.problems.filter((p) => p.kind === 'overlap');
    expect(overlaps.map((p) => [p.element, p.other])).toEqual([['[data-figma-id="20:3"]', '[data-figma-id="20:4"]']]);
    expect(overlaps[0].widths.every(([, to]) => to <= 767)).toBe(true);
  }, 60_000);

  test('a layout hidden at a screenshot width has no screenshot there', async () => {
    const r = await run('responsive-phone.html', { selector: '#desktop', designWidth: 1000, toWidth: 800, step: 100 });
    expect(Object.keys(r.screenshots).map(Number)).toEqual([768, 800]);
  }, 60_000);
});

describe('check_responsive tool', () => {
  const rest = JSON.parse(readFileSync(path.join(fixtures, 'hero.rest.json'), 'utf8'));
  const textDetails = JSON.parse(readFileSync(path.join(fixtures, 'hero.text.json'), 'utf8'));
  const vars = JSON.parse(readFileSync(path.join(fixtures, 'hero.vars.json'), 'utf8'));
  let bridge: PluginBridge;
  let socket: WebSocket;
  let client: Client;
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-responsive-'));
    bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs: 5000, secret: 'test-secret' });
    await bridge.start();
    socket = await startFakePlugin(bridge,
      { type: 'hello', fileName: 'Landing', fileKey: 'K', editorType: 'figma', pluginVersion: '0.1.0' },
      (method) => {
        switch (method) {
          case 'hasNode': return { exists: true, pageId: '0:1' };
          case 'getNodeJson': return rest;
          case 'getTextDetails': return textDetails;
          case 'resolveVariables': return vars;
          default: throw new Error(`unexpected ${method}`);
        }
      });
    const deps: ServerDeps = { bridge, bridgeError: null, workDir, browser };
    client = await connectTestClient(deps);
  });

  afterEach(async () => {
    await client?.close();
    socket?.terminate();
    await bridge.stop();
  });

  const call = (args: Record<string, unknown>): Promise<any> => client.callTool({
    name: 'check_responsive',
    arguments: { link: 'https://www.figma.com/design/K/Landing?node-id=1-1', url: `${base}/hero.html`, selector: '#hero', ...args },
  });

  test('checks the linked section against its design width and saves screenshots', async () => {
    const res = await call({});
    expect(res.isError).toBeFalsy();
    const r = JSON.parse(res.content[0].text);
    expect(r.designWidth).toBe(600);
    // The hero is a fixed 600 px wide, so it scrolls sideways on phones.
    expect(r.problems).toContainEqual(expect.objectContaining({ kind: 'sideways-scroll', screen: 'phone' }));
    for (const file of Object.values(r.screenshots) as string[]) {
      expect(file.startsWith(path.join(workDir, '.pixel-twin', 'responsive'))).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
  }, 60_000);

  test('takes a phone design and a phone root for phone widths', async () => {
    const res = await call({ phoneNodeId: '1-1', phoneSelector: '#hero' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).problems).toContainEqual(expect.objectContaining({ kind: 'sideways-scroll', screen: 'phone' }));
    const missing = await call({ phoneSelector: '#nope' });
    expect(missing.content[0].text).toBe(`No element matches "#nope" on ${base}/hero.html`);
  }, 60_000);

  test('refuses pages that are not on this computer', async () => {
    const res = await call({ url: 'https://example.com/' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Pixel Twin only opens pages on this computer\'s development server (localhost) or files inside the project.');
  });

  test('a selector that matches nothing gives a plain error', async () => {
    const res = await call({ selector: '#nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`No element matches "#nope" on ${base}/hero.html`);
  }, 30_000);
});

test('wide designs are checked up to 1.5 × their width', async () => {
  const { widestWidth } = await import('../src/responsive/checks');
  expect(widestWidth(600)).toBe(1920);
  expect(widestWidth(1440)).toBe(2160);
  expect(widestWidth(1920)).toBe(2880);
});
