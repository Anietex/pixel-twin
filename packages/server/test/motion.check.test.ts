import { mkdtemp, readFile, copyFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import { checkMotion, normalEasing, type MotionReport } from '../src/motion/checkMotion';
import { recordPage } from '../src/motion/record';
import { compactAnimations } from '../src/tools/motion';

const fixtures = path.join(__dirname, 'fixtures');
let site: Server;
let base: string;
let browser: BrowserProvider;
let bad: MotionReport;
let good: MotionReport;

/** Figma's hover on the link: 300 ms, ease-out. */
const expected = [{ layerId: '1:2', layerName: 'Read more', durationMs: 300, easing: 'cubic-bezier(0, 0, 0.58, 1)' }];
const run = (file: string) => checkMotion(browser, { url: `${base}/${file}`, scope: '#motion', width: 800, expected, isAllowed: () => true });

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-motion-site-'));
  for (const f of ['motion-bad.html', 'motion-good.html']) await copyFile(path.join(fixtures, f), path.join(dir, f));
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
  bad = await run('motion-bad.html');
  good = await run('motion-good.html');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
});

const kinds = (r: MotionReport) => new Set(r.problems.map((p) => p.kind).filter((k) => k !== 'slow-frames'));

test('a page done right has no motion problems', () => {
  expect(good.problems.filter((p) => p.kind !== 'slow-frames')).toEqual([]);
  expect(good.hovered).toBe(2);
  expect(good.animations).toContainEqual(expect.objectContaining({ element: '[data-figma-id="1:2"]', kind: 'transition', property: 'color',
    durationMs: 300, phase: 'hover', hovered: '1:2' }));
});

test('a bad page reports every kind of motion problem', () => {
  expect(kinds(bad)).toEqual(new Set(['layout-property', 'moves-with-reduced-motion', 'hidden-with-reduced-motion', 'layout-shift', 'timing-differs', 'marquee-jump']));
});

test('each problem names the element', () => {
  const find = (kind: string) => bad.problems.filter((p) => p.kind === kind);
  expect(find('layout-property')).toContainEqual(expect.objectContaining({ element: '[data-figma-id="1:3"]', detail: expect.stringContaining('width') }));
  expect(find('marquee-jump')).toContainEqual(expect.objectContaining({ element: 'div.track' }));
  expect(find('hidden-with-reduced-motion')).toContainEqual(expect.objectContaining({ element: '[data-figma-id="1:5"]' }));
  expect(find('timing-differs')).toContainEqual(expect.objectContaining({ element: '[data-figma-id="1:2"]', detail: expect.stringContaining('200 ms') }));
  expect(bad.scroll.layoutShift).toBeGreaterThan(0.01);
});

test('a colour fade left on with reduce motion is a warning, not a problem', () => {
  const still = bad.problems.filter((p) => p.kind === 'moves-with-reduced-motion');
  expect(still.map((p) => p.element)).not.toContain('[data-figma-id="1:2"]');
  expect(still.map((p) => p.element)).toContain('[data-figma-id="1:3"]');   // width still moves: a problem
  expect(bad.warnings).toEqual([{ kind: 'fades-with-reduced-motion', element: '[data-figma-id="1:2"]',
    detail: 'color fades (200 ms) with reduce motion on. A fade is not motion, so it may stay; check the owner is happy with it.' }]);
  expect(good.warnings).toEqual([]);
});

test('CSS easing words compare equal to their curves', () => {
  expect(normalEasing('ease-out')).toBe(normalEasing('cubic-bezier(0, 0, 0.58, 1)'));
  expect(normalEasing('ease-in')).not.toBe(normalEasing('ease-out'));
});

test('record saves a video of the page', async () => {
  const outFile = path.join(await mkdtemp(path.join(tmpdir(), 'pixel-twin-record-')), 'page.webm');
  const r = await recordPage(browser, { url: `${base}/motion-good.html`, width: 800, scope: '#motion', outFile, isAllowed: () => true });
  expect(r.file).toBe(outFile);
  expect(r.hovered).toBe(2);
  expect((await stat(outFile)).size).toBeGreaterThan(1000);
}, 60_000);

test('the reply joins animations that differ only in the property they move, and leaves out empty fields', () => {
  const fade = { element: '[data-figma-id="1:2"]', layerId: '1:2', kind: 'transition', name: null, property: 'opacity', durationMs: 600,
    delayMs: 0, easing: 'ease', iterations: 1, phase: 'load', hovered: null } as const;
  const shared = { kind: 'transition', durationMs: 600, delayMs: 0, easing: 'ease', iterations: 1 };
  expect(compactAnimations([
    fade, { ...fade, property: 'transform' }, { ...fade, property: 'opacity' },
    { ...fade, property: 'color', phase: 'hover', hovered: '1:2' },
    { ...fade, element: 'section', layerId: '1:1' },
  ])).toEqual([
    { ...shared, element: '[data-figma-id="1:2"]', property: 'opacity, transform', phase: 'load' },
    { ...shared, element: '[data-figma-id="1:2"]', property: 'color', phase: 'hover', hovered: '1:2' },
    { ...shared, element: 'section', layerId: '1:1', property: 'opacity', phase: 'load' },
  ]);
});
