import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { isAllowedUrl } from '../src/browser/allowedUrl';
import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';

let browser: BrowserProvider;
let project: string;
let outside: string;
const allowed = (url: string) => isAllowedUrl(url, project);
const fileUrl = (...p: string[]) => pathToFileURL(path.join(...p)).href;

beforeAll(async () => {
  browser = createBrowserProvider();
  project = await mkdtemp(path.join(tmpdir(), 'pixel-twin-project-'));
  outside = await mkdtemp(path.join(tmpdir(), 'pixel-twin-outside-'));
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(200);
  for (const dir of [project, outside]) await writeFile(path.join(dir, 'dot.png'), PNG.sync.write(png));
  await writeFile(path.join(project, 'images.html'),
    `<img id="inside" src="dot.png"><img id="leak" src="${fileUrl(outside, 'dot.png')}">`);
  await writeFile(path.join(project, 'leave.html'),
    `<script>location.href = ${JSON.stringify(fileUrl(outside, 'dot.png'))};</script><p>leaving</p>`);
});
afterAll(async () => { await browser.close(); });

test('a project page can load its own pictures but not files outside the project', async () => {
  const s = await browser.open(fileUrl(project, 'images.html'), 600, 1, allowed);
  try {
    const widths = await s.page.evaluate(async () => {
      const imgs = [...document.images];
      await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
      return imgs.map((i) => [i.id, i.naturalWidth]);
    });
    expect(widths).toEqual([['inside', 4], ['leak', 0]]);
  } finally {
    await s.close();
  }
}, 30_000);

test('a page that moves to a file outside the project is refused', async () => {
  await expect(browser.open(fileUrl(project, 'leave.html'), 600, 1, allowed)).rejects.toThrow(
    'Pixel Twin only opens pages on this computer\'s development server (localhost) or files inside the project.');
}, 30_000);
