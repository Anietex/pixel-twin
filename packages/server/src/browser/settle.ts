import type { Page } from 'playwright';

/** How long to wait for the section to appear on the page (ms). */
export const APPEAR_TIMEOUT_MS = 10_000;
/** How long to wait for the section's pictures to load (ms). */
export const IMAGE_TIMEOUT_MS = 5_000;
/** How long to wait for an element to be ready to hover or focus (ms). */
const STATE_TIMEOUT_MS = 5_000;

export interface SettleOptions {
  /** How long to wait for the section to appear (ms). Default APPEAR_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Load every picture in the section, not only those already loading (see loadPictures). For checks that
   * picture the page. Leave it off for checks that read the page's own loading attributes.
   */
  loadAllPictures?: boolean;
}

/**
 * Gets the page ready to measure. Waits for `selector` to be on the page, then for fonts and the
 * section's pictures, then ends every animation that has an end and waits two frames.
 * Endless animations are left running. Returns false when the selector never appears.
 */
export async function settleSection(page: Page, selector: string, options: SettleOptions = {}): Promise<boolean> {
  const root = page.locator(selector).first();
  try {
    await root.waitFor({ state: 'attached', timeout: options.timeoutMs ?? APPEAR_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return false;
    throw err;
  }
  if (options.loadAllPictures) {
    await loadPictures(page, selector);
  } else {
    await root.evaluate(async (section, imageTimeout) => {
      await document.fonts.ready;
      const loading = [...section.querySelectorAll('img')].filter((img) => !img.complete);
      const loaded = Promise.all(loading.map((img) => img.decode().catch(() => undefined)));
      await Promise.race([loaded, new Promise((r) => setTimeout(r, imageTimeout))]);
    }, IMAGE_TIMEOUT_MS);
  }
  await finishAnimations(page);
  return true;
}

/**
 * Loads every picture in the section and waits until each one is loaded and decoded, for at most
 * IMAGE_TIMEOUT_MS. Lazy pictures load only near the window, so they are switched to eager, and the
 * section is scrolled past once for pictures that a script loads as they come into view. Background
 * pictures are loaded again by address, which makes sure they are ready. The scroll position is put back.
 */
export async function loadPictures(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate(async (section, imageTimeout) => {
    const twoFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const eager = () => section.querySelectorAll('img[loading="lazy"]').forEach((img) => { (img as HTMLImageElement).loading = 'eager'; });
    await document.fonts.ready;
    eager();
    const startY = window.scrollY;
    const box = section.getBoundingClientRect();
    const top = box.top + startY;
    for (let y = top; y < top + box.height; y += window.innerHeight / 2) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await twoFrames();
    }
    window.scrollTo({ top: startY, behavior: 'instant' });
    eager();   // pictures a script added while scrolling
    const ready = (img: HTMLImageElement) => (img.complete ? Promise.resolve() : new Promise<void>((r) => {
      img.addEventListener('load', () => r(), { once: true });
      img.addEventListener('error', () => r(), { once: true });
    })).then(() => img.decode().catch(() => undefined));
    const addresses = new Set<string>();
    for (const el of [section, ...section.querySelectorAll('*')]) {
      for (const m of getComputedStyle(el).backgroundImage.matchAll(/url\("?(.*?)"?\)/g)) addresses.add(m[1]);
    }
    const backgrounds = [...addresses].map((src) => {
      const img = new Image();
      img.src = src;
      return img.decode().catch(() => undefined);
    });
    const all = Promise.all([...[...section.querySelectorAll('img')].map(ready), ...backgrounds]);
    await Promise.race([all, new Promise((r) => setTimeout(r, imageTimeout))]);
  }, IMAGE_TIMEOUT_MS);
}

/** Marks the page parts prepareCapture makes invisible, and its style sheet. */
const CAPTURE_HIDDEN = 'data-pixel-twin-capture-hidden';
const CAPTURE_STYLE = 'pixel-twin-capture';

/**
 * Gets the page ready for a picture of `selector` (or of any of several) without changing its layout:
 * - fixed and sticky parts outside the section are made invisible, so a sticky menu bar is not painted
 *   over the top of a section taller than the window;
 * - smooth scrolling, scroll padding and scroll margins are switched off, so the picture is taken where
 *   the section really is.
 * Returns a function that puts the page back.
 */
export async function prepareCapture(page: Page, selector: string | string[]): Promise<() => Promise<void>> {
  await page.evaluate(({ selectors, attr, id }) => {
    const sections = selectors.map((s) => document.querySelector(s)).filter((s): s is Element => s !== null);
    const style = document.createElement('style');
    style.id = id;
    style.textContent = 'html, body { scroll-behavior: auto !important; scroll-padding: 0 !important; } '
      + `* { scroll-margin: 0 !important; } [${attr}] { opacity: 0 !important; transition: none !important; }`;
    (document.head ?? document.documentElement).append(style);
    for (const el of document.body.querySelectorAll('*')) {
      if (sections.some((section) => section.contains(el) || el.contains(section))) continue;
      const position = getComputedStyle(el).position;
      if (position === 'fixed' || position === 'sticky') el.setAttribute(attr, '');
    }
  }, { selectors: Array.isArray(selector) ? selector : [selector], attr: CAPTURE_HIDDEN, id: CAPTURE_STYLE });
  return async () => {
    await page.evaluate(({ attr, id }) => {
      document.getElementById(id)?.remove();
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
    }, { attr: CAPTURE_HIDDEN, id: CAPTURE_STYLE }).catch(() => undefined);
  };
}

/** Ends every animation and transition that has an end, then waits two frames. Endless ones keep running. */
export async function finishAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) {
      const iterations = animation.effect?.getComputedTiming().iterations;
      if (iterations === undefined || !Number.isFinite(iterations)) continue;
      try {
        animation.finish();
      } catch {
        // an animation with no end in time (for example playback rate 0): leave it
      }
    }
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

export type StateKind = 'hover' | 'focus' | 'active';

/**
 * Puts the element `selector` matches into a state: the mouse over it (hover), keyboard focus on it
 * (focus), or the mouse pressed on it (active). Then ends the transitions it started.
 * Returns a plain error, or null when the state is on.
 */
export async function applyState(page: Page, kind: StateKind, selector: string): Promise<string | null> {
  const el = page.locator(selector);
  const count = await el.count();
  if (count !== 1) return `The state target "${selector}" matches ${count} elements; it must match exactly one`;
  try {
    if (kind === 'focus') {
      await el.focus({ timeout: STATE_TIMEOUT_MS });
    } else {
      await el.hover({ timeout: STATE_TIMEOUT_MS });
      if (kind === 'active') await page.mouse.down();
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return `Could not ${kind === 'focus' ? 'focus' : 'move the mouse onto'} "${selector}": something covers it, or it is hidden`;
    throw err;
  }
  await finishAnimations(page);
  return null;
}
