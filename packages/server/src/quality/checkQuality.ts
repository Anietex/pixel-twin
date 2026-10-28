import type { Page } from 'playwright';
import { inBrowser, PageError } from '../browser/errors';
import { VIEWPORT_HEIGHT, type BrowserProvider } from '../browser/launch';
import { settleSection } from '../browser/settle';

export type QualityKind =
  | 'low-contrast' | 'contrast-on-image' | 'missing-alt' | 'no-name' | 'no-h1' | 'many-h1' | 'heading-skip'
  | 'heavy-image' | 'oversized-image' | 'no-srcset' | 'not-lazy' | 'lazy-above-fold' | 'hero-not-priority'
  | 'unsafe-link' | 'new-tab-without-rel' | 'svg-script' | 'font-display' | 'heavy-code';

/** One finding for the owner to decide on. Pixel Twin reports these; it never changes the design for them. */
export interface QualityFinding { kind: QualityKind; element: string; detail: string }

export interface QualityReport {
  width: number;
  headings: string[];                                   // "h1 Title", in page order
  images: { firstScreenKB: number; totalKB: number; biggest: { url: string; kb: number }[] };
  // Script and style files the page loaded. A development server sends unminified code, so its sizes say little.
  code: { scriptKB: number; styleKB: number; devServer: boolean };
  findings: QualityFinding[];
}

/** WCAG AA contrast: 4.5:1 for normal text, 3:1 for large text (24 px, or 18.66 px bold). */
export const CONTRAST_NORMAL = 4.5;
export const CONTRAST_LARGE = 3;
/** An image heavier than this is reported (KB). */
export const HEAVY_IMAGE_KB = 500;
/** An image file more than this many times wider than twice its shown width is reported. */
export const OVERSIZED_FACTOR = 2.5;
/** A phone needs a file at most this wide: a 430 px screen at 2x. A wider file with no srcset is reported. */
export const PHONE_NEED_PX = 860;
/** Script and style files a page may load at most, on a production build (KB, as served). */
export const SCRIPT_BUDGET_KB = 300;
export const STYLE_BUDGET_KB = 100;
/** At most this many of the heaviest images are listed. */
const BIGGEST_COUNT = 10;
/** Files only a development server sends. */
const DEV_SERVER_FILE = /\/@vite\/client|\/@react-refresh|\/node_modules\/\.vite\/|__webpack_hmr|webpack-dev-server|\/_next\/static\/development\//;

type Rgba = [number, number, number, number];

/**
 * Runs in the page. Finds text with too little contrast against what is behind it, images with no alt
 * text, links and buttons with no name, heading order problems, images that load too early or too late,
 * links that run code or open a new tab unsafely, and inline SVGs that hold scripts.
 * It must not use anything from outside its own body.
 */
function inspect(root: Element, arg: {
  normal: number; large: number; screen: number; whole: boolean;
}): { findings: QualityFinding[]; headings: string[] } {
  const findings: QualityFinding[] = [];
  const name = (el: Element): string => {
    const id = el.getAttribute('data-figma-id');
    if (id) return `[data-figma-id="${id}"]`;
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = [...el.classList][0];
    return cls ? `${tag}.${cls}` : tag;
  };
  const parse = (c: string): Rgba | null => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  const over = (top: Rgba, under: Rgba): Rgba => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const luminance = (c: Rgba): number => {
    const ch = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const hex = (c: Rgba) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  const shown = (el: Element) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const all = [root, ...root.querySelectorAll('*')].filter(shown);

  // What is painted behind a point, top first, down to the first solid colour. Null when an image is behind it.
  const behind = (el: Element): Rgba[] | null => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const b = el.getBoundingClientRect();
    const stack = document.elementsFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    const at = stack.indexOf(el);
    const layers: Element[] = at >= 0 ? stack.slice(at) : [];
    if (at < 0) {   // something covers the point: use the element and its parents instead
      for (let p: Element | null = el; p; p = p.parentElement) layers.push(p);
    }
    const colours: Rgba[] = [];
    for (const layer of layers) {
      const s = getComputedStyle(layer);
      if (layer !== el && /^(img|video|canvas|picture|svg|iframe)$/i.test(layer.tagName)) return null;
      if (s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0) {
        colours.push(c);
        if (c[3] >= 1) break;
      }
    }
    return colours;
  };

  for (const el of all) {
    const ownText = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim();
    if (!ownText) continue;
    const s = getComputedStyle(el);
    const colour = parse(s.color);
    if (!colour) continue;
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const need = large ? arg.large : arg.normal;
    const layers = behind(el);
    const sample = ownText.length > 40 ? `${ownText.slice(0, 40)}…` : ownText;
    if (layers === null) {
      findings.push({ kind: 'contrast-on-image', element: name(el), detail: `"${sample}" sits on an image or gradient: check its contrast by eye (needs ${need}:1)` });
      continue;
    }
    let bg: Rgba = [255, 255, 255, 1];
    for (const c of layers.reverse()) bg = over(c, bg);
    const fg = over(colour, bg);
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < need - 1e-9) {
      findings.push({ kind: 'low-contrast', element: name(el),
        detail: `"${sample}" is ${hex(fg)} on ${hex(bg)}: contrast ${ratio.toFixed(1)}:1, needs ${need}:1 for ${large ? 'large' : 'normal'} text` });
    }
  }

  for (const img of root.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) findings.push({ kind: 'missing-alt', element: name(img), detail: `Image ${img.currentSrc || img.src} has no alt text. Describe it, or use alt="" if it is decoration.` });
  }
  for (const el of all.filter((e) => e.matches('a[href], button, [role="button"]'))) {
    const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')
      || (el.textContent ?? '').trim() || [...el.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).join('').trim()
      || [...el.querySelectorAll('svg title')].map((t) => t.textContent).join('').trim();
    if (!label) findings.push({ kind: 'no-name', element: name(el), detail: 'This link or button has no text a screen reader can read. Add aria-label.' });
  }

  const headings = all.filter((e) => /^H[1-6]$/.test(e.tagName));
  const levels = headings.map((h) => Number(h.tagName[1]));
  if (arg.whole && !levels.includes(1)) findings.push({ kind: 'no-h1', element: 'page', detail: 'The page has no h1 heading.' });
  if (levels.filter((l) => l === 1).length > 1) findings.push({ kind: 'many-h1', element: 'page', detail: `The page has ${levels.filter((l) => l === 1).length} h1 headings; use one.` });
  levels.forEach((l, i) => {
    if (i > 0 && l > levels[i - 1] + 1) {
      findings.push({ kind: 'heading-skip', element: name(headings[i]), detail: `h${levels[i - 1]} is followed by h${l}; a level is skipped` });
    }
  });

  for (const a of root.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (/^(javascript|data|vbscript):/i.test(href)) {
      findings.push({ kind: 'unsafe-link', element: name(a), detail: `The link runs code or opens raw data (${href.slice(0, 40)}). Use a real address, or # and tell the owner.` });
    }
    const rel = (a.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (a.getAttribute('target') === '_blank' && !(rel.includes('noopener') && rel.includes('noreferrer'))) {
      findings.push({ kind: 'new-tab-without-rel', element: name(a), detail: 'Opens a new tab without rel="noopener noreferrer", so the other site can reach back into this page.' });
    }
  }
  for (const svg of root.querySelectorAll('svg')) {
    if (svg.parentElement?.closest('svg')) continue;   // checked with the outer one
    const risky = [svg, ...svg.querySelectorAll('*')].find((el) => ['script', 'foreignobject'].includes(el.tagName.toLowerCase())
      || [...el.attributes].some((at) => /^on/i.test(at.name) || /^\s*javascript:/i.test(at.value)));
    if (risky) {
      findings.push({ kind: 'svg-script', element: name(svg),
        detail: `The inline SVG holds a ${risky.tagName.toLowerCase() === 'script' ? 'script' : 'script hook or embedded HTML'}. Remove it, or use the SVG as an <img> file.` });
    }
  }

  window.scrollTo(0, 0);
  for (const img of root.querySelectorAll('img')) {
    const top = img.getBoundingClientRect().top + window.scrollY;
    const lazy = img.getAttribute('loading') === 'lazy';
    if (top > arg.screen && !lazy) findings.push({ kind: 'not-lazy', element: name(img), detail: `Below the first screen (${Math.round(top)} px down) but not loading="lazy"` });
    if (top < arg.screen && lazy) findings.push({ kind: 'lazy-above-fold', element: name(img), detail: 'On the first screen but loading="lazy", which delays it. Remove loading="lazy".' });
  }
  return { findings, headings: headings.map((h) => `${h.tagName.toLowerCase()} ${(h.textContent ?? '').trim().slice(0, 60)}`) };
}

/**
 * Runs in the page after every image has had the chance to load. Finds image files far bigger than they
 * are shown, and big files with no srcset, which phones download in full.
 */
function imageSizes(root: Element, arg: { oversized: number; phoneNeed: number }): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const name = (el: Element): string => {
    const id = el.getAttribute('data-figma-id');
    return id ? `[data-figma-id="${id}"]` : `img ${(el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src}`;
  };
  for (const img of root.querySelectorAll('img')) {
    const shownWidth = img.getBoundingClientRect().width;
    if (img.naturalWidth === 0 || shownWidth === 0) continue;
    if (img.naturalWidth > shownWidth * 2 * arg.oversized) {
      findings.push({ kind: 'oversized-image', element: name(img),
        detail: `The file is ${img.naturalWidth} px wide but shown at ${Math.round(shownWidth)} px; ${Math.round(shownWidth * 2)} px is enough for sharp screens` });
    }
    const vector = /\.svg(\?|#|$)/i.test(img.currentSrc) || img.currentSrc.startsWith('data:image/svg');
    const sources = img.parentElement?.tagName === 'PICTURE' && img.parentElement.querySelector('source[srcset]') !== null;
    if (!vector && !sources && !img.hasAttribute('srcset') && img.naturalWidth > arg.phoneNeed) {
      findings.push({ kind: 'no-srcset', element: name(img),
        detail: `The file is ${img.naturalWidth} px wide and has no srcset, so phones download all of it; they need at most ${arg.phoneNeed} px. Use the srcset sizes from export_assets.` });
    }
  }
  return findings;
}

/** Web fonts in use that keep text invisible while they load (font-display auto or block). */
function blockingFonts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    document.fonts.forEach((f) => {
      if (f.status !== 'unloaded' && (f.display === 'auto' || f.display === 'block')) out.add(`${f.family.replace(/["']/g, '')} ${f.weight} ${f.style}`);
    });
    return [...out];
  });
}

/** The script and style files the page loaded, and whether a development server sent them. */
function codeFiles(page: Page, devPattern: string): Promise<{ scripts: number; styles: number; devServer: boolean }> {
  return page.evaluate((pattern) => {
    const dev = new RegExp(pattern);
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const size = (e: PerformanceResourceTiming) => e.encodedBodySize || e.transferSize || 0;
    const scripts = entries.filter((e) => e.initiatorType === 'script' || /\.m?js(\?|#|$)/i.test(e.name));
    const styles = entries.filter((e) => /\.css(\?|#|$)/i.test(e.name) || (e.initiatorType === 'link' && /css/i.test(e.name)));
    const tags = [...document.querySelectorAll('script[src]')].map((t) => t.getAttribute('src') ?? '');
    return {
      scripts: scripts.reduce((n, e) => n + size(e), 0), styles: styles.reduce((n, e) => n + size(e), 0),
      devServer: [...entries.map((e) => e.name), ...tags].some((u) => dev.test(u)),
    };
  }, devPattern);
}

/** Every image file the page loaded so far, with its size. */
function loadedImages(page: Page): Promise<{ url: string; bytes: number }[]> {
  return page.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .filter((e) => e.initiatorType === 'img' || /\.(png|jpe?g|webp|avif|gif|svg)(\?|#|$)/i.test(e.name))
    .map((e) => ({ url: e.name, bytes: e.encodedBodySize || e.transferSize || 0 })));
}

/** The largest thing drawn on the first screen, when it is an image. */
function heroImage(page: Page): Promise<{ element: string; priority: string | null } | null> {
  return page.evaluate(() => new Promise((resolve) => {
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1) as (PerformanceEntry & { element?: Element | null }) | undefined;
      const el = last?.element;
      if (!(el instanceof HTMLImageElement)) return resolve(null);
      const id = el.getAttribute('data-figma-id');
      resolve({ element: id ? `[data-figma-id="${id}"]` : `img ${el.currentSrc || el.src}`, priority: el.getAttribute('fetchpriority') });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    setTimeout(() => resolve(null), 1000);
  }));
}

/**
 * Checks a built page for things the owner should decide on: text contrast (WCAG AA), alt text and names,
 * heading order, image weight and size, srcset, lazy loading below the first screen, priority for the main
 * image, unsafe links, scripts in inline SVGs, fonts that hide text while loading, and script and style size.
 */
export async function checkQuality(browser: BrowserProvider, opts: {
  url: string; scope: string; width: number; isAllowed: (url: string) => boolean;
}): Promise<QualityReport> {
  const session = await inBrowser(() => browser.open(opts.url, opts.width, 1, opts.isAllowed));
  try {
    const { page } = session;
    if (!(await settleSection(page, opts.scope))) throw new PageError(`No element matches "${opts.scope}" on ${opts.url}`);
    const hero = await inBrowser(() => heroImage(page));
    const firstScreen = await inBrowser(() => loadedImages(page));
    const result = await inBrowser(() => page.locator(opts.scope).first().evaluate(inspect, {
      normal: CONTRAST_NORMAL, large: CONTRAST_LARGE, screen: VIEWPORT_HEIGHT, whole: opts.scope === 'body',
    }));
    // Scroll to the bottom so images that load late are counted too.
    await page.evaluate(async () => {
      for (let y = 0; y <= document.documentElement.scrollHeight; y += window.innerHeight) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.waitForTimeout(500);
    const all = await inBrowser(() => loadedImages(page));
    const sized = await inBrowser(() => page.locator(opts.scope).first().evaluate(imageSizes, { oversized: OVERSIZED_FACTOR, phoneNeed: PHONE_NEED_PX }));
    const fonts = await inBrowser(() => blockingFonts(page));
    const code = await inBrowser(() => codeFiles(page, DEV_SERVER_FILE.source));
    const findings = [...result.findings, ...sized];
    for (const font of fonts) {
      findings.push({ kind: 'font-display', element: font, detail: 'Text in this font stays invisible until the font loads. Add font-display: swap to its @font-face.' });
    }
    const codeKB = { scriptKB: Math.round(code.scripts / 1024), styleKB: Math.round(code.styles / 1024) };
    if (!code.devServer && codeKB.scriptKB > SCRIPT_BUDGET_KB) {
      findings.push({ kind: 'heavy-code', element: 'scripts', detail: `The page loads ${codeKB.scriptKB} KB of scripts; keep it under ${SCRIPT_BUDGET_KB} KB. Remove unused packages, or load big parts only when needed.` });
    }
    if (!code.devServer && codeKB.styleKB > STYLE_BUDGET_KB) {
      findings.push({ kind: 'heavy-code', element: 'styles', detail: `The page loads ${codeKB.styleKB} KB of styles; keep it under ${STYLE_BUDGET_KB} KB. Remove unused styles.` });
    }
    if (hero && hero.priority !== 'high') {
      findings.push({ kind: 'hero-not-priority', element: hero.element, detail: 'The biggest image on the first screen should load first: add fetchpriority="high".' });
    }
    for (const img of all) {
      if (img.bytes > HEAVY_IMAGE_KB * 1024) {
        findings.push({ kind: 'heavy-image', element: img.url, detail: `${Math.round(img.bytes / 1024)} KB. Save photos as WebP or JPG, at most twice the shown size.` });
      }
    }
    const kb = (list: { bytes: number }[]) => Math.round(list.reduce((n, i) => n + i.bytes, 0) / 1024);
    return {
      width: opts.width, headings: result.headings,
      images: { firstScreenKB: kb(firstScreen), totalKB: kb(all),
        biggest: [...all].sort((a, b) => b.bytes - a.bytes).slice(0, BIGGEST_COUNT).map((i) => ({ url: i.url, kb: Math.round(i.bytes / 1024) })) },
      code: { ...codeKB, devServer: code.devServer },
      findings,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}
