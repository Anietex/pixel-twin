import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { inBrowser, PageError } from '../browser/errors';
import { VIEWPORT_HEIGHT, type BrowserProvider } from '../browser/launch';
import { prepareCapture, settleSection } from '../browser/settle';

export type ProblemKind = 'sideways-scroll' | 'overlap' | 'small-text' | 'small-tap' | 'image-shape' | 'not-centred' | 'not-full-width';

/** One problem, with the ranges of checked widths where it happens. */
export interface Problem { kind: ProblemKind; element: string; other?: string; detail: string; widths: [number, number][] }

/** No text may be smaller than this (px). */
export const MIN_TEXT_PX = 12;
/** Buttons and links need a tap area at least this wide and tall at phone and tablet widths (px). */
export const MIN_TAP_PX = 44;
/** An image's width-to-height ratio may differ from its file's by this share. */
export const IMAGE_RATIO_TOLERANCE = 0.01;
/** On wide screens the content must sit this close to the centre (px). */
export const CENTRE_TOLERANCE_PX = 1;
/** Widths where a screenshot is saved for the agent to look at. The widest checked width is added too. */
export const SHOT_WIDTHS = [390, 768, 1920];
/** The widest screen checked: 1920 px, or 1.5 × the design's width when the design is wider than 1280 px. */
export function widestWidth(designWidth: number): number {
  return Math.max(1920, Math.ceil(designWidth * 1.5));
}

/** A shown picture may differ by this many px from the size its file's shape gives, for rounding. */
export const IMAGE_ROUNDING_PX = 1;

export interface ResponsiveOptions {
  url: string;
  selector: string;
  designWidth: number;
  designOverlaps: [string, string][];   // pairs of layer ids that overlap in the design
  tabletMax: number;
  /**
   * A separate phone design, used at widths up to maxWidth: its section root (default: selector) and the
   * pairs of its layer ids that overlap in the phone design (default: designOverlaps).
   */
  phone?: { maxWidth: number; selector?: string; overlaps?: [string, string][] };
  fromWidth?: number;   // default 320
  toWidth?: number;     // default 1920
  step?: number;        // default 10
  shotsDir: string;
  isAllowed: (url: string) => boolean;
}

interface Finding { kind: ProblemKind; element: string; other?: string; detail: string }
/** A part whose content must stay centred: its name, the layer ids of its content, and where that content starts (px). */
interface CentredPart { name: string; ids: string[]; left: number | null }
interface PageResult { findings: Finding[]; parts: CentredPart[]; rootWidth: number }

/**
 * Runs inside the page at one width. Finds every problem except centring, which needs two widths. It
 * returns the parts whose content must stay centred, with where that content starts, and the section's width.
 * - The parts: when the root holds two or more full-width tagged parts that have tagged content (a whole
 *   page of sections), each of those; else the root. Their content is every tagged element inside them that
 *   is narrower than the window, so full-width backgrounds don't count. Pass `parts` from the design width
 *   to measure the same content at another width.
 * - A tap area is measured by tapping (hit testing) around the element's middle, so a bigger invisible tap
 *   area counts. The window scrolls to the element and back.
 * It must not use anything from outside its own body.
 */
function checkPage(root: Element, arg: {
  tapLimit: boolean; overlapsAllowed: string[]; minText: number; minTap: number; ratioTolerance: number; imageRounding: number;
  parts: { name: string; ids: string[] }[] | null;
}): PageResult {
  const findings: Finding[] = [];
  const name = (el: Element): string => {
    const id = el.getAttribute('data-figma-id');
    if (id) return `[data-figma-id="${id}"]`;
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = [...el.classList][0];
    return cls ? `${tag}.${cls}` : tag;
  };
  const shown = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const all = [root, ...root.querySelectorAll('*')].filter(shown);
  const interactive = (el: Element) => el.matches('a[href], button, [role="button"], input, select, textarea, summary');

  // The page scrolls sideways. Name the first part of the section that sticks out, or the page.
  const page = document.documentElement;
  if (page.scrollWidth > window.innerWidth) {
    const culprit = all.find((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5);
    findings.push({ kind: 'sideways-scroll', element: culprit ? name(culprit) : 'page',
      detail: `The page is ${page.scrollWidth} px wide in a ${window.innerWidth} px window` });
  }

  // The part of an element left showing after every parent that clips its overflow.
  const shownBox = (el: Element): { left: number; top: number; right: number; bottom: number } => {
    const r = el.getBoundingClientRect();
    const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      const clipsX = s.overflowX !== 'visible' || s.contain.includes('paint');
      const clipsY = s.overflowY !== 'visible' || s.contain.includes('paint');
      if (!clipsX && !clipsY) continue;
      const c = p.getBoundingClientRect();
      if (clipsX) { box.left = Math.max(box.left, c.left); box.right = Math.min(box.right, c.right); }
      if (clipsY) { box.top = Math.max(box.top, c.top); box.bottom = Math.min(box.bottom, c.bottom); }
    }
    return box;
  };
  // The layer ids of an element and of every tagged element around it, nearest first.
  const layerChain = (el: Element): string[] => {
    const ids: string[] = [];
    for (let e: Element | null = el.closest('[data-figma-id]'); e; e = e.parentElement?.closest('[data-figma-id]') ?? null) {
      ids.push(e.getAttribute('data-figma-id') ?? '');
    }
    return ids;
  };
  const allowed = new Set(arg.overlapsAllowed);

  // Overlaps between leaf layers and controls, unless the design has the same overlap: between the two
  // layers, or between layers around them. Parts hidden by a clipping parent don't count.
  const leaves = all.filter((el) => (el.hasAttribute('data-figma-id') && !el.querySelector('[data-figma-id]')) || interactive(el));
  const boxes = new Map(leaves.map((el) => [el, shownBox(el)]));
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i];
      const b = leaves[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = boxes.get(a)!;
      const rb = boxes.get(b)!;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 1 || h <= 1) continue;
      const ca = layerChain(a);
      const cb = layerChain(b);
      if (ca.length > 0 && ca[0] === cb[0]) continue;   // two parts of one layer
      if (ca.some((x) => cb.some((y) => allowed.has(`${x}|${y}`)))) continue;
      findings.push({ kind: 'overlap', element: name(a), other: name(b), detail: `They overlap by ${Math.round(w)} × ${Math.round(h)} px` });
    }
  }

  // How far from the element's middle a tap still reaches it, in each direction (px), by hit testing.
  // `covered` names what a tap in its middle reaches instead, when that is not the element.
  const startY = window.scrollY;
  const tapArea = (el: Element): { width: number; height: number; covered: string | null } => {
    const first = el.getBoundingClientRect();
    window.scrollBy({ top: first.top + first.height / 2 - window.innerHeight / 2, behavior: 'instant' });
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const hits = (x: number, y: number) => {
      const e = document.elementFromPoint(x, y);
      return !!e && (e === el || el.contains(e));
    };
    if (!hits(cx, cy)) {
      const top = document.elementFromPoint(cx, cy);
      return { width: 0, height: 0, covered: top ? name(top) : 'nothing (outside the window)' };
    }
    const half = arg.minTap / 2 - 0.5;
    if (hits(cx - half, cy) && hits(cx + half, cy) && hits(cx, cy - half) && hits(cx, cy + half)) {
      return { width: arg.minTap, height: arg.minTap, covered: null };
    }
    const reach = (dx: number, dy: number) => {
      let d = 0;
      while (d < arg.minTap && hits(cx + (d + 1) * dx, cy + (d + 1) * dy)) d += 1;
      return d;
    };
    return { width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1, covered: null };
  };

  for (const el of all) {
    const style = getComputedStyle(el);
    // Text that is too small to read. Only elements that hold text themselves count.
    const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
    const size = parseFloat(style.fontSize);
    if (ownText && size < arg.minText) {
      findings.push({ kind: 'small-text', element: name(el), detail: `Text is ${size} px; the smallest allowed is ${arg.minText} px` });
    }
    // Tap areas that are too small. A link inside running text is exempt.
    if (arg.tapLimit && interactive(el)) {
      const parent = el.parentElement;
      const inline = el.tagName === 'A' && style.display === 'inline' && parent !== null
        && (parent.textContent ?? '').trim() !== (el.textContent ?? '').trim();
      const box = el.getBoundingClientRect();
      if (!inline && (box.width < arg.minTap || box.height < arg.minTap)) {
        const tap = tapArea(el);
        if (tap.covered) {
          findings.push({ kind: 'small-tap', element: name(el), detail: `A tap in its middle reaches ${tap.covered} instead` });
        } else if (tap.width < arg.minTap - 1 || tap.height < arg.minTap - 1) {
          findings.push({ kind: 'small-tap', element: name(el),
            detail: `Tap area is ${tap.width} × ${tap.height} px (measured by tapping around it); it must be at least ${arg.minTap} × ${arg.minTap} px` });
        }
      }
    }
    // Stretched or squashed images. A pixel of rounding is allowed (80 × 10 shown for an 80 × 9 file).
    if (el instanceof HTMLImageElement && el.naturalWidth > 0 && el.naturalHeight > 0 && style.objectFit === 'fill') {
      const box = el.getBoundingClientRect();
      const natural = el.naturalWidth / el.naturalHeight;
      const shownRatio = box.width / box.height;
      const rounded = Math.abs(box.height - box.width / natural) <= arg.imageRounding || Math.abs(box.width - box.height * natural) <= arg.imageRounding;
      if (Math.abs(shownRatio - natural) / natural > arg.ratioTolerance && !rounded) {
        findings.push({ kind: 'image-shape', element: name(el),
          detail: `Shown at ${Math.round(box.width)} × ${Math.round(box.height)} px but the file is ${el.naturalWidth} × ${el.naturalHeight} px` });
      }
    }
  }

  window.scrollTo({ top: startY, behavior: 'instant' });

  // Where each part's content starts. At the design width, the parts and their content are found first.
  const taggedIn = (el: Element) => [...el.querySelectorAll('[data-figma-id]')];
  let plan = arg.parts;
  if (!plan) {
    const full = (el: Element) => shown(el) && el.getBoundingClientRect().width >= window.innerWidth - 1;
    const tops = taggedIn(root).filter((el) => {
      const around = el.parentElement?.closest('[data-figma-id]');
      return !around || around === root || !root.contains(around);
    });
    const sections = tops.filter((el) => full(el) && taggedIn(el).length > 0);
    const units = sections.length >= 2 ? sections : [root];
    plan = units.map((unit) => ({ name: name(unit), ids: taggedIn(unit).filter((el) => shown(el) && !full(el)).map((el) => el.getAttribute('data-figma-id') ?? '') }))
      .filter((p) => p.ids.length > 0);
  }
  const parts = plan.map((p) => {
    const lefts = taggedIn(root).filter((el) => p.ids.includes(el.getAttribute('data-figma-id') ?? '') && shown(el)).map((el) => el.getBoundingClientRect().left);
    return { ...p, left: lefts.length > 0 ? Math.min(...lefts) : null };
  });
  return { findings, parts, rootWidth: root.getBoundingClientRect().width };
}

/** Sets the window width and waits two frames for the layout to settle. */
async function resize(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Joins the checked widths where a problem happens into ranges of neighbouring checked widths. */
function toRanges(hits: Set<number>, checked: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  let open: [number, number] | null = null;
  for (const w of checked) {
    if (hits.has(w)) {
      if (open) open[1] = w;
      else ranges.push(open = [w, w]);
    } else {
      open = null;
    }
  }
  return ranges;
}

/**
 * Checks a built section at every `step` px from `fromWidth` to `toWidth` (default: widestWidth), plus the screenshot widths.
 * Reports sideways scrolling, overlaps the design doesn't have, text under 12 px, tap areas under
 * 44 × 44 px (up to `tabletMax`), stretched images, and, on screens wider than the design, content
 * that isn't centred (per section on a whole page) or a section that doesn't fill the width. Saves
 * screenshots at SHOT_WIDTHS. With `phone`, phone widths use the phone design's root and overlaps.
 */
export async function checkResponsive(browser: BrowserProvider, opts: ResponsiveOptions): Promise<{ problems: Problem[]; screenshots: Record<number, string> }> {
  const from = opts.fromWidth ?? 320;
  const to = opts.toWidth ?? widestWidth(opts.designWidth);
  const step = opts.step ?? 10;
  const grid = new Set<number>();
  for (let w = from; w <= to; w += step) grid.add(w);
  for (const w of [...SHOT_WIDTHS, to]) if (w >= from && w <= to) grid.add(w);
  grid.add(to);
  const widths = [...grid].sort((a, b) => a - b);
  const shots = [...new Set([...SHOT_WIDTHS, to])].filter((w) => w >= from && w <= to);
  const pairs = (list: [string, string][]) => list.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]);
  const overlapsAllowed = pairs(opts.designOverlaps);
  const phone = opts.phone;
  const phoneOverlaps = phone?.overlaps ? pairs(phone.overlaps) : overlapsAllowed;
  const isPhone = (w: number) => !!phone && w <= phone.maxWidth;
  const selectors = [...new Set([opts.selector, phone?.selector ?? opts.selector])];

  const session = await inBrowser(() => browser.open(opts.url, opts.designWidth, 1, opts.isAllowed));
  try {
    const { page } = session;
    for (const selector of selectors) {
      if (!(await settleSection(page, selector, { loadAllPictures: true }))) throw new PageError(`No element matches "${selector}" on ${opts.url}`);
      const count = await inBrowser(() => page.locator(selector).count());
      if (count > 1) throw new PageError(`The selector "${selector}" matches ${count} elements; it must match exactly one`);
    }
    const desktopRoot = page.locator(opts.selector);
    const phoneRoot = page.locator(phone?.selector ?? opts.selector);
    const rootAt = (w: number) => (isPhone(w) ? phoneRoot : desktopRoot);
    // For the screenshots: no sticky menu bar painted over the section, no smooth scrolling. The page closes after.
    await inBrowser(() => prepareCapture(page, selectors));
    const check = (w: number, parts: CentredPart[] | null = null, root = rootAt(w)) => inBrowser(() => root.evaluate(checkPage, {
      tapLimit: w <= opts.tabletMax, overlapsAllowed: isPhone(w) ? phoneOverlaps : overlapsAllowed,
      minText: MIN_TEXT_PX, minTap: MIN_TAP_PX, ratioTolerance: IMAGE_RATIO_TOLERANCE, imageRounding: IMAGE_ROUNDING_PX,
      parts: parts && parts.map(({ name, ids }) => ({ name, ids })),
    }));

    // Where each part's content starts at the design's own width (always the desktop layout), for the centring check.
    await inBrowser(() => resize(page, opts.designWidth));
    const atDesign = (await check(opts.designWidth, null, desktopRoot)).parts;

    const found = new Map<string, { finding: Finding; hits: Set<number> }>();
    const note = (finding: Finding, w: number) => {
      const key = `${finding.kind}|${finding.element}|${finding.other ?? ''}`;
      const entry = found.get(key) ?? { finding, hits: new Set<number>() };
      entry.hits.add(w);
      found.set(key, entry);
    };
    const screenshots: Record<number, string> = {};
    await mkdir(opts.shotsDir, { recursive: true });

    for (const w of widths) {
      await inBrowser(() => resize(page, w));
      const wide = w === to && to > opts.designWidth;
      const result = await check(w, wide ? atDesign : null);
      for (const f of result.findings) note(f, w);
      if (wide) {
        if (Math.abs(result.rootWidth - w) > 0.5) {
          note({ kind: 'not-full-width', element: 'section', detail: `The section is ${Math.round(result.rootWidth)} px wide on a ${w} px screen; its background should fill the width` }, w);
        }
        for (const part of result.parts) {
          const before = atDesign.find((p) => p.name === part.name)?.left ?? null;
          if (before === null || part.left === null) continue;
          const expected = (w - opts.designWidth) / 2 + before;
          if (Math.abs(part.left - expected) > CENTRE_TOLERANCE_PX) {
            note({ kind: 'not-centred', element: part.name,
              detail: `Content starts at ${Math.round(part.left)} px; centred at the design's width it would start at ${Math.round(expected)} px` }, w);
          }
        }
      }
      if (shots.includes(w) && await inBrowser(() => rootAt(w).isVisible())) {   // a layout hidden at this width has no picture
        const file = path.join(opts.shotsDir, `${w}.png`);
        await inBrowser(() => rootAt(w).screenshot({ path: file, animations: 'disabled' }));
        screenshots[w] = file;
      }
    }

    const problems = [...found.values()].map(({ finding, hits }) => ({ ...finding, widths: toRanges(hits, widths) }));
    return { problems, screenshots };
  } finally {
    await session.close().catch(() => undefined);
  }
}
