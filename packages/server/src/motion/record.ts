import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { inBrowser, PageError } from '../browser/errors';
import type { BrowserProvider } from '../browser/launch';
import { settleSection } from '../browser/settle';

/** The scroll from top to bottom takes 1 s per this many px of page, between the two limits (ms). */
const SCROLL_PX_PER_SECOND = 800;
const MIN_SCROLL_MS = 3000;
const MAX_SCROLL_MS = 12_000;
/** At most this many links and buttons are hovered in the video, each for HOVER_MS. */
export const MAX_RECORD_HOVERS = 8;
const HOVER_MS = 700;

/** Scrolls smoothly to `to` px over `ms`, one step per frame. */
function smoothScroll(page: Page, to: number, ms: number): Promise<void> {
  return page.evaluate(({ target, duration }) => new Promise<void>((resolve) => {
    const from = window.scrollY;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      window.scrollTo(0, from + (target - from) * p);
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  }), { target: to, duration: ms });
}

/**
 * Records a short video of the page with motion allowed: the first screen as it loads, a smooth scroll to
 * the bottom and back, then the mouse over the main links and buttons inside `scope`. Returns the video file.
 */
export async function recordPage(browser: BrowserProvider, opts: {
  url: string; width: number; scope: string; outFile: string; isAllowed: (url: string) => boolean;
}): Promise<{ file: string; seconds: number; hovered: number }> {
  const dir = path.dirname(opts.outFile);
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  const session = await inBrowser(() => browser.open(opts.url, opts.width, 1, opts.isAllowed, { reducedMotion: 'no-preference', recordVideoDir: dir }));
  const video = session.page.video();
  let hovered = 0;
  try {
    const { page } = session;
    if (!(await settleSection(page, opts.scope))) throw new PageError(`No element matches "${opts.scope}" on ${opts.url}`);
    await page.waitForTimeout(800);
    const height = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    const scrollMs = Math.min(MAX_SCROLL_MS, Math.max(MIN_SCROLL_MS, (height / SCROLL_PX_PER_SECOND) * 1000));
    await inBrowser(() => smoothScroll(page, height, scrollMs));
    await page.waitForTimeout(500);
    await inBrowser(() => smoothScroll(page, 0, Math.min(2000, scrollMs / 2)));
    const controls = page.locator(opts.scope).first().locator('a[href], button, [role="button"], summary');
    const count = Math.min(MAX_RECORD_HOVERS, await controls.count());
    for (let i = 0; i < count; i++) {
      try {
        await controls.nth(i).hover({ timeout: 1500 });
        hovered += 1;
        await page.waitForTimeout(HOVER_MS);
      } catch {
        // hidden or covered: skip it
      }
    }
  } finally {
    await session.close().catch(() => undefined);
  }
  if (!video) throw new PageError('The browser did not record a video.');
  await video.saveAs(opts.outFile);
  await video.delete().catch(() => undefined);
  return { file: opts.outFile, seconds: Math.round((Date.now() - started) / 1000), hovered };
}
