import type { Browser, Page, Request } from 'playwright';
import { URL_NOT_ALLOWED } from './allowedUrl';
import { PageError } from './errors';

/**
 * Extra choices for a page.
 * - reducedMotion: what the page is told about the visitor's motion setting. Default 'reduce', so pages that
 *   honour it skip their animations while they are measured.
 * - initScript: runs in the page before any of the page's own scripts.
 * - recordVideoDir: records a video of the page into this folder. The file is complete after close().
 */
export interface OpenOptions {
  reducedMotion?: 'reduce' | 'no-preference';
  initScript?: () => void;
  recordVideoDir?: string;
}

export interface BrowserProvider {
  /**
   * Opens `url` in a new page of the given width. Always call the returned close() when done.
   * The page may not move to an address `isAllowed` refuses, and may not load such a file: address.
   */
  open(url: string, width: number, deviceScaleFactor: number, isAllowed: (url: string) => boolean, options?: OpenOptions): Promise<{ page: Page; close(): Promise<void> }>;
  /** Closes the browser, if it was started. */
  close(): Promise<void>;
}

/** Window height in px. A taller section is still measured and pictured in full. */
export const VIEWPORT_HEIGHT = 900;

/** True for a request that would replace the page itself (not a picture, script or inner frame). */
function movesPage(request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    return false; // a service worker request has no frame
  }
}

/** Starts headless Chromium on first use and reuses it after that. */
export function createBrowserProvider(): BrowserProvider {
  let started: Promise<Browser> | null = null;

  const browser = (): Promise<Browser> => {
    if (started) return started;
    const launch: Promise<Browser> = (async () => {
      const { chromium } = await import('playwright');
      const b = await chromium.launch({ headless: true });
      b.on('disconnected', () => { if (started === launch) started = null; });   // start again next time if it crashes
      return b;
    })().catch((err: unknown) => {
      if (started === launch) started = null;
      const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new PageError(`Could not start the headless browser (${reason}). Run: npx playwright install chromium`);
    });
    started = launch;
    return launch;
  };

  return {
    async open(url, width, deviceScaleFactor, isAllowed, options = {}) {
      // Reduced motion asks pages that honour it to skip their animations.
      const context = await (await browser()).newContext({
        viewport: { width, height: VIEWPORT_HEIGHT }, deviceScaleFactor, reducedMotion: options.reducedMotion ?? 'reduce',
        ...(options.recordVideoDir ? { recordVideo: { dir: options.recordVideoDir, size: { width, height: VIEWPORT_HEIGHT } } } : {}),
      });
      try {
        if (options.initScript) await context.addInitScript(options.initScript);
        // Stop the page from moving to a refused address, and from reading refused files.
        // Other http(s) files, such as fonts and pictures from the internet, still load.
        let blocked = false;
        await context.route('**/*', (route) => {
          const request = route.request();
          const moves = movesPage(request);
          if ((moves || request.url().startsWith('file:')) && !isAllowed(request.url())) {
            if (moves) blocked = true;
            return route.abort('blockedbyclient');
          }
          return route.continue();
        });
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: 'load' });
        } catch {
          throw new PageError(blocked ? URL_NOT_ALLOWED : `Could not open ${url}. Is the app running?`);
        }
        if (blocked || !isAllowed(page.url())) throw new PageError(URL_NOT_ALLOWED);
        await page.evaluate(async () => { await document.fonts.ready; });
        return { page, close: () => context.close() };
      } catch (err) {
        await context.close().catch(() => undefined);
        throw err;
      }
    },
    async close() {
      const pending = started;
      started = null;
      const b = await pending?.catch(() => null);
      await b?.close();
    },
  };
}
