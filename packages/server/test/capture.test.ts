import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import { prepareCapture, settleSection } from '../src/browser/settle';

let site: Server;
let base: string;
let browser: BrowserProvider;

/** A one-colour PNG. */
function solid(width: number, height: number, rgb: [number, number, number]): Buffer {
  const p = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) p.data.set([...rgb, 255], i * 4);
  return PNG.sync.write(p);
}

const PAGES: Record<string, string> = {
  // A sticky menu bar, smooth scrolling and scroll padding, and a section taller than the 900 px window
  // with a red top strip, a blue middle and a green bottom strip.
  '/sticky.html': `<!doctype html><html><head><style>
    html { scroll-behavior: smooth; scroll-padding-top: 80px; }
    html, body { margin: 0; }
    header { position: sticky; top: 0; height: 60px; background: #000; z-index: 5; }
    .spacer { height: 1500px; }
    #tall { height: 1200px; background: #0000ff; border-top: 8px solid #ff0000; border-bottom: 8px solid #00ff00; box-sizing: border-box; }
    .cookie { position: fixed; bottom: 0; left: 0; right: 0; height: 50px; background: #ff00ff; }
  </style></head><body><header></header><div class="spacer"></div><section id="tall"></section><div class="spacer"></div><div class="cookie"></div></body></html>`,
  // A lazy picture far below the first screen, and a picture that a script loads when it comes into view.
  '/lazy.html': `<!doctype html><html><head><style>html, body { margin: 0; } img { display: block; width: 40px; height: 40px; }</style></head>
    <body><section id="s"><div style="height: 3000px"></div><img id="lazy" loading="lazy" src="/slow.png" alt="">
    <div style="height: 3000px"></div><img id="observed" data-src="/slow.png?b" alt=""></section>
    <script>
      new IntersectionObserver((entries, o) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.src = e.target.dataset.src; o.unobserve(e.target); }
      })).observe(document.getElementById('observed'));
    </script></body></html>`,
};

beforeAll(async () => {
  site = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/slow.png') {
      setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(solid(40, 40, [0, 128, 0])), 300);
      return;
    }
    const page = PAGES[url.pathname];
    if (page) res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = createBrowserProvider();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
});

/** The colour bands down the middle of a screenshot: the first row of each, with its colour. */
function bands(png: Buffer): string[] {
  const p = PNG.sync.read(png);
  const out: string[] = [];
  let last = '';
  for (let y = 0; y < p.height; y++) {
    const i = (y * p.width + Math.floor(p.width / 2)) * 4;
    const colour = [p.data[i], p.data[i + 1], p.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (colour !== last) out.push(`${y}:${colour}`);
    last = colour;
  }
  return out;
}

test('a tall section is pictured without the sticky menu bar, a fixed banner or a scroll shift, and the page is put back', async () => {
  const session = await browser.open(`${base}/sticky.html`, 400, 1, () => true);
  try {
    const { page } = session;
    expect(await settleSection(page, '#tall', { loadAllPictures: true })).toBe(true);
    const restore = await prepareCapture(page, '#tall');
    const shot = await page.locator('#tall').screenshot({ animations: 'disabled' });
    // Only the section's own strips: no menu bar or banner painted over it, and nothing shifted.
    expect(bands(shot)).toEqual(['0:ff0000', '8:0000ff', '1192:00ff00']);
    await restore();
    const after = await page.evaluate(() => ({
      header: getComputedStyle(document.querySelector('header')!).opacity,
      smooth: getComputedStyle(document.documentElement).scrollBehavior,
    }));
    expect(after).toEqual({ header: '1', smooth: 'smooth' });
  } finally {
    await session.close();
  }
});

test('lazy pictures and pictures loaded on view are ready before the picture is taken', async () => {
  const session = await browser.open(`${base}/lazy.html`, 400, 1, () => true);
  try {
    const { page } = session;
    expect(await settleSection(page, '#s', { loadAllPictures: true })).toBe(true);
    const state = await page.evaluate(() => ['lazy', 'observed'].map((id) => {
      const img = document.getElementById(id) as HTMLImageElement;
      return { complete: img.complete, width: img.naturalWidth };
    }));
    expect(state).toEqual([{ complete: true, width: 40 }, { complete: true, width: 40 }]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);   // the scroll position is put back
  } finally {
    await session.close();
  }
});
