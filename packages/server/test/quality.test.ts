import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import { checkQuality, type QualityReport } from '../src/quality/checkQuality';

const fixtures = path.join(__dirname, 'fixtures');
let site: Server;
let base: string;
let browser: BrowserProvider;
let bad: QualityReport;
let good: QualityReport;
let dev: QualityReport;

/** A square of random noise, which PNG can't shrink: about 4 bytes a pixel. */
function noise(size: number): Buffer {
  const p = new PNG({ width: size, height: size });
  for (let i = 0; i < p.data.length; i++) p.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
  return PNG.sync.write(p);
}
function plain(size: number): Buffer {
  const p = new PNG({ width: size, height: size });
  p.data.fill(200);
  return PNG.sync.write(p);
}

const run = (file: string) => checkQuality(browser, { url: `${base}/${file}`, scope: 'body', width: 800, isAllowed: () => true });

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-quality-site-'));
  for (const f of ['quality-bad.html', 'quality-good.html']) await copyFile(path.join(fixtures, f), path.join(dir, f));
  await writeFile(path.join(dir, 'big.png'), noise(600));
  await writeFile(path.join(dir, 'medium.png'), plain(600));
  await writeFile(path.join(dir, 'small.png'), plain(80));
  await writeFile(path.join(dir, 'wide.png'), plain(1200));
  await writeFile(path.join(dir, 'big.js'), `// ${'x'.repeat(400 * 1024)}\n`);
  await writeFile(path.join(dir, 'small.js'), 'window.ok = true;\n');
  // The bad page as a Vite development server sends it: its script sizes say nothing about the real build.
  const badHtml = await readFile(path.join(fixtures, 'quality-bad.html'), 'utf8');
  await writeFile(path.join(dir, 'quality-dev.html'), badHtml.replace('<script src="big.js"></script>',
    '<script type="module" src="/@vite/client"></script><script src="big.js"></script>'));
  site = createServer(async (req, res) => {
    try {
      const file = path.join(dir, path.basename(new URL(req.url ?? '/', 'http://x').pathname));
      const body = await readFile(file);   // before writeHead, so a missing file can still get a 404
      const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'content-type': type }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = createBrowserProvider();
  bad = await run('quality-bad.html');
  good = await run('quality-good.html');
  dev = await run('quality-dev.html');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
});

test('a page done right has no findings', () => {
  expect(good.findings).toEqual([]);
  expect(good.headings).toEqual(['h1 Gifts', 'h2 Details']);
});

test('a bad page reports every kind of finding', () => {
  expect(new Set(bad.findings.map((f) => f.kind))).toEqual(new Set(['low-contrast', 'contrast-on-image', 'missing-alt', 'no-name', 'no-h1',
    'heading-skip', 'heavy-image', 'oversized-image', 'no-srcset', 'not-lazy', 'lazy-above-fold', 'hero-not-priority',
    'unsafe-link', 'new-tab-without-rel', 'svg-script', 'font-display', 'heavy-code']));
});

test('low contrast names the colours and the ratio (2.35:1 for these two)', () => {
  expect(bad.findings).toContainEqual({ kind: 'low-contrast', element: '[data-figma-id="1:2"]',
    detail: '"FROM $12" is #AAA59B on #FCFAF4: contrast 2.3:1, needs 4.5:1 for normal text' });
});

test('image weight counts the first screen and the whole page', () => {
  expect(bad.images.firstScreenKB).toBeGreaterThan(1000);
  expect(bad.images.totalKB).toBeGreaterThanOrEqual(bad.images.firstScreenKB);
  expect(bad.images.biggest[0].url).toMatch(/big\.png$/);
});

test('security findings name the link or SVG', () => {
  expect(bad.findings).toContainEqual(expect.objectContaining({ kind: 'unsafe-link', detail: expect.stringContaining('javascript:void(0)') }));
  expect(bad.findings).toContainEqual(expect.objectContaining({ kind: 'new-tab-without-rel', element: 'a' }));
  expect(bad.findings).toContainEqual(expect.objectContaining({ kind: 'svg-script', element: 'svg' }));
  expect(bad.findings).toContainEqual(expect.objectContaining({ kind: 'font-display', element: 'Brand Sans normal normal' }));
  expect(bad.findings).toContainEqual(expect.objectContaining({ kind: 'no-srcset', element: expect.stringMatching(/wide\.png$/) }));
});

test('script and style sizes are measured, and judged only on a production build', () => {
  expect(bad.code).toMatchObject({ devServer: false });
  expect(bad.code.scriptKB).toBeGreaterThan(300);
  expect(dev.code.devServer).toBe(true);
  expect(dev.findings.some((f) => f.kind === 'heavy-code')).toBe(false);
});
