import type { Page } from 'playwright';
import { changedShare } from '../compare/overlay';
import { inBrowser, PageError } from '../browser/errors';
import type { BrowserProvider } from '../browser/launch';
import { settleSection } from '../browser/settle';

/** One animation or transition the page ran, as the browser reports it. Times are in ms. */
export interface AnimationRecord {
  element: string;               // [data-figma-id="…"], or tag#id / tag.class
  layerId: string | null;        // the nearest data-figma-id around the moving element
  kind: 'transition' | 'animation' | 'script';
  name: string | null;           // the @keyframes name of a CSS animation
  property: string;              // the CSS properties that move
  durationMs: number; delayMs: number; easing: string; iterations: number | 'infinite';
  phase: 'load' | 'hover' | 'scroll';
  hovered: string | null;        // in the hover phase: the layer id (or name) of the hovered element
}

export type MotionProblemKind =
  | 'layout-property' | 'moves-with-reduced-motion' | 'hidden-with-reduced-motion' | 'layout-shift'
  | 'slow-frames' | 'timing-differs' | 'marquee-jump';
export interface MotionProblem { kind: MotionProblemKind; element: string; detail: string }
/** Something to mention to the owner that is not a problem: a colour or opacity fade left on with reduce motion on. */
export interface MotionWarning { kind: 'fades-with-reduced-motion'; element: string; detail: string }

/** Properties that change colour or see-through only. Fading them moves nothing on screen, so it is not motion. */
export const FADE_PROPERTY = /^(color|opacity|fill|stroke|background-color|border(-(top|right|bottom|left))?-color|outline-color|text-decoration-color|caret-color|column-rule-color)$/;

/** A hover transition the designer set in Figma, as CSS. */
export interface ExpectedHover { layerId: string; layerName: string; durationMs: number; easing: string | null }

export interface MotionReport {
  width: number;
  hovered: number;
  animations: AnimationRecord[];
  scroll: { layoutShift: number; frames: number; slowFrames: number; worstFrameMs: number };
  problems: MotionProblem[];
  warnings: MotionWarning[];
}

/** Properties that make the browser lay the page out again on every frame when they move. */
export const LAYOUT_PROPERTY = /^(width|height|top|left|right|bottom|inset(-.*)?|margin(-.*)?|padding(-.*)?|(min|max)-(width|height)|font-size|line-height|border(-(top|right|bottom|left))?-width|gap|row-gap|column-gap|flex-basis|grid-template-(rows|columns))$/;
/** Layout shift above this during the scroll is a problem (Google's "good" limit is 0.1 for a whole visit). */
export const MAX_LAYOUT_SHIFT = 0.01;
/** A frame longer than this is a stutter (ms). */
export const SLOW_FRAME_MS = 50;
/** How long the test scroll from top to bottom takes (ms). */
export const SCROLL_MS = 3000;
/** Durations may differ from Figma's by this much (ms). */
export const TIMING_TOLERANCE_MS = 10;
/** With reduce motion on, anything longer than this counts as moving (ms). Many sites use 0.01 ms to switch motion off. */
export const STILL_MS = 10;
/** A marquee's loop restart counts as a jump when more than this share of its picture changes. */
export const LOOP_JUMP_SHARE = 0.01;
/** At most this many links and buttons are hovered. */
export const MAX_HOVERS = 30;
/** Wait after each hover for transitions to start and run (ms). */
const HOVER_WAIT_MS = 250;

type Recorder = {
  phase: AnimationRecord['phase']; hovered: string | null; records: AnimationRecord[];
  describe: (el: Element | null) => string; loops?: Animation[];
};

/**
 * Runs in the page before its own scripts. Watches every animation and transition, every frame, and
 * keeps one record for each the first time it appears.
 */
function installRecorder(): void {
  const describe = (el: Element | null): string => {
    if (!el) return 'page';
    const id = el.getAttribute('data-figma-id');
    if (id) return `[data-figma-id="${id}"]`;
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = [...el.classList][0];
    return cls ? `${tag}.${cls}` : tag;
  };
  const state: Recorder = { phase: 'load', hovered: null, records: [], describe };
  (window as unknown as { __pixelTwinMotion: Recorder }).__pixelTwinMotion = state;
  const seen = new WeakSet<Animation>();
  const kebab = (p: string) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const SKIP = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const tick = (): void => {
    for (const a of document.getAnimations()) {
      if (seen.has(a)) continue;
      seen.add(a);
      const effect = a.effect as KeyframeEffect | null;
      if (!effect) continue;
      const target = effect.target ?? null;
      const timing = effect.getTiming();
      const computed = effect.getComputedTiming();
      const frames = effect.getKeyframes();
      const kind = a instanceof CSSTransition ? 'transition' : a instanceof CSSAnimation ? 'animation' : 'script';
      const property = a instanceof CSSTransition
        ? a.transitionProperty
        : [...new Set(frames.flatMap((f) => Object.keys(f).filter((k) => !SKIP.has(k)).map(kebab)))].join(', ');
      const firstEasing = frames[0]?.easing;
      state.records.push({
        element: describe(target), layerId: target?.closest('[data-figma-id]')?.getAttribute('data-figma-id') ?? null,
        kind, name: a instanceof CSSAnimation ? a.animationName : null, property,
        durationMs: typeof computed.duration === 'number' ? computed.duration : 0, delayMs: timing.delay ?? 0,
        easing: timing.easing && timing.easing !== 'linear' ? timing.easing : typeof firstEasing === 'string' ? firstEasing : 'linear',
        iterations: computed.iterations === Infinity ? 'infinite' : computed.iterations ?? 1,
        phase: state.phase, hovered: state.hovered,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const recorder = (page: Page) => page.evaluate(() => (window as unknown as { __pixelTwinMotion: Recorder }).__pixelTwinMotion.records);
const setPhase = (page: Page, phase: AnimationRecord['phase'], hovered: string | null) => page.evaluate(([p, h]) => {
  const state = (window as unknown as { __pixelTwinMotion: Recorder }).__pixelTwinMotion;
  state.phase = p as AnimationRecord['phase'];
  state.hovered = h;
}, [phase, hovered] as const);

/**
 * The links and buttons inside `scope`, plus the elements of layers that have a hover in Figma. Each is
 * marked with a data-pixel-twin-hover number, so it can be found again.
 */
async function hoverTargets(page: Page, scope: string, layerIds: string[]): Promise<{ selector: string; label: string }[]> {
  const found = await page.locator(scope).first().evaluate((root, { ids, max }) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll('*')) {
      if (out.length >= max) break;
      const wanted = el.matches('a[href], button, [role="button"], summary') || ids.includes(el.getAttribute('data-figma-id') ?? '');
      const box = el.getBoundingClientRect();
      if (!wanted || box.width === 0 || box.height === 0) continue;
      el.setAttribute('data-pixel-twin-hover', String(out.length));
      out.push(el.closest('[data-figma-id]')?.getAttribute('data-figma-id') ?? el.tagName.toLowerCase());
    }
    return out;
  }, { ids: layerIds, max: MAX_HOVERS });
  return found.map((label, i) => ({ selector: `[data-pixel-twin-hover="${i}"]`, label }));
}

/** Moves the mouse over each target in turn, then away. */
async function hoverEach(page: Page, targets: { selector: string; label: string }[], waitMs: number): Promise<number> {
  let hovered = 0;
  for (const t of targets) {
    await setPhase(page, 'hover', t.label);
    try {
      await page.locator(t.selector).hover({ timeout: 1500 });
      hovered += 1;
      await page.waitForTimeout(waitMs);
    } catch {
      // covered or moved away: skip it
    }
    await page.mouse.move(0, 0);
    await page.waitForTimeout(50);
  }
  return hovered;
}

/** Scrolls the page from top to bottom over `durationMs`, one step per frame, and times the frames and layout shift. */
async function timedScroll(page: Page, durationMs: number): Promise<{ layoutShift: number; sources: string[]; frames: number; slowFrames: number; worstFrameMs: number }> {
  return page.evaluate(async ({ duration, slow }) => {
    const state = (window as unknown as { __pixelTwinMotion: Recorder }).__pixelTwinMotion;
    window.scrollTo(0, 0);
    await new Promise((r) => requestAnimationFrame(r));
    let layoutShift = 0;
    const sources: string[] = [];
    const take = (entries: PerformanceEntryList) => {
      for (const e of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node: Node | null }[] })[]) {
        if (e.hadRecentInput) continue;
        layoutShift += e.value;
        for (const s of e.sources ?? []) if (s.node instanceof Element) sources.push(state.describe(s.node));
      }
    };
    const observer = new PerformanceObserver((list) => take(list.getEntries()));
    observer.observe({ type: 'layout-shift', buffered: false });
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const times: number[] = [];
    await new Promise<void>((resolve) => {
      const start = performance.now();
      const step = (now: number) => {
        times.push(now);
        const p = Math.min(1, (now - start) / duration);
        window.scrollTo(0, p * max);
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    await new Promise((r) => setTimeout(r, 300));
    take(observer.takeRecords());
    observer.disconnect();
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    return { layoutShift, sources: [...new Set(sources)].slice(0, 5), frames: gaps.length,
      slowFrames: gaps.filter((g) => g > slow).length, worstFrameMs: Math.round(Math.max(0, ...gaps)) };
  }, { duration: durationMs, slow: SLOW_FRAME_MS });
}

/**
 * For each endless animation that moves something sideways or up and down (a marquee), compares a
 * picture at the start of a loop with one just before the loop restarts. A seamless loop looks the same.
 */
async function loopJumps(page: Page): Promise<MotionProblem[]> {
  const loops = await page.evaluate(() => {
    const state = (window as unknown as { __pixelTwinMotion: Recorder }).__pixelTwinMotion;
    const moves = (a: Animation) => (a.effect as KeyframeEffect | null)?.getKeyframes()
      .some((f) => 'transform' in f || 'translate' in f) ?? false;
    state.loops = document.getAnimations().filter((a) => {
      const t = a.effect?.getComputedTiming();
      return t?.iterations === Infinity && (t.direction === 'normal' || t.direction === 'reverse') && moves(a);
    });
    return state.loops.map((a) => {
      const target = (a.effect as KeyframeEffect).target ?? null;
      let clip: Element | null = target?.parentElement ?? null;
      for (let p = target?.parentElement ?? null; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { clip = p; break; }
      }
      const box = (clip ?? target)?.getBoundingClientRect();
      const timing = a.effect!.getComputedTiming();
      return { element: state.describe(target), duration: Number(timing.duration), delay: a.effect!.getTiming().delay ?? 0,
        box: box ? { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height } : null };
    });
  });
  const problems: MotionProblem[] = [];
  for (const [i, loop] of loops.entries()) {
    if (!loop.box || loop.box.width < 1 || loop.box.height < 1 || !(loop.duration > 2)) continue;
    const shotAt = async (time: number) => {
      await page.evaluate(([n, t]) => {
        const a = (window as unknown as { __pixelTwinMotion: Recorder }).__pixelTwinMotion.loops![n];
        a.pause();
        a.currentTime = t;
      }, [i, time] as const);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      return page.screenshot({ clip: loop.box!, fullPage: true });
    };
    // The start of the third loop, and 1 ms before the fourth starts: a seamless loop looks the same at both.
    const start = loop.delay + 2 * loop.duration;
    const share = changedShare(await shotAt(start), await shotAt(start + loop.duration - 1));
    await page.evaluate((n) => { (window as unknown as { __pixelTwinMotion: Recorder }).__pixelTwinMotion.loops![n].play(); }, i);
    if (share > LOOP_JUMP_SHARE) {
      problems.push({ kind: 'marquee-jump', element: loop.element,
        detail: `${Math.round(share * 100)}% of the strip changes where the loop restarts, so it jumps. Move it by exactly the width of one copy of its items, and repeat the items once.` });
    }
  }
  return problems;
}

/** Turns CSS easing keywords into their cubic-bezier numbers, so equal curves compare equal. */
export function normalEasing(easing: string): string {
  const named: Record<string, string> = {
    ease: 'cubic-bezier(0.25, 0.1, 0.25, 1)', 'ease-in': 'cubic-bezier(0.42, 0, 1, 1)',
    'ease-out': 'cubic-bezier(0, 0, 0.58, 1)', 'ease-in-out': 'cubic-bezier(0.42, 0, 0.58, 1)',
  };
  const e = easing.trim().toLowerCase();
  const full = named[e] ?? e;
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(full);
  return m ? `cubic-bezier(${m[1].split(',').map((v) => String(Math.round(Number(v) * 100) / 100)).join(', ')})` : full.replace(/\s+/g, ' ');
}

/** Hover transitions the page ran, against the ones the designer set in Figma. */
function timingProblems(expected: ExpectedHover[], records: AnimationRecord[], hoveredLabels: Set<string>): MotionProblem[] {
  const problems: MotionProblem[] = [];
  for (const want of expected) {
    const element = `[data-figma-id="${want.layerId}"]`;
    if (!hoveredLabels.has(want.layerId)) continue;   // its element was not found or could not be hovered
    const ran = records.filter((r) => r.phase === 'hover' && r.hovered === want.layerId);
    const wantEasing = want.easing === null ? null : normalEasing(want.easing);
    if (ran.length === 0) {
      problems.push({ kind: 'timing-differs', element,
        detail: `Figma sets a ${want.durationMs} ms hover transition on "${want.layerName}", but hovering it moves nothing` });
      continue;
    }
    for (const r of ran) {
      const offDuration = Math.abs(r.durationMs - want.durationMs) > TIMING_TOLERANCE_MS;
      const offEasing = wantEasing !== null && !wantEasing.startsWith('linear(') && normalEasing(r.easing) !== wantEasing;
      if (offDuration || offEasing) {
        problems.push({ kind: 'timing-differs', element: r.element,
          detail: `${r.property} moves for ${Math.round(r.durationMs)} ms with ${r.easing}; Figma's hover on "${want.layerName}" is ${want.durationMs} ms with ${want.easing ?? 'a spring'}` });
      }
    }
  }
  return problems;
}

export interface MotionOptions {
  url: string;
  scope: string;              // CSS selector of the part to hover in; the whole page scrolls
  width: number;
  expected: ExpectedHover[];
  isAllowed: (url: string) => boolean;
}

/**
 * Checks the motion of a built page, twice:
 * 1. With motion allowed: records every animation while the page loads, while each link and button is
 *    hovered, and during a 3-second scroll from top to bottom. Reports motion on layout properties, layout
 *    shift, slow frames, hover timings that differ from Figma's, and marquees that jump where they loop.
 * 2. With "reduce motion" on: hovers and scrolls again and reports anything that still moves, and any layer
 *    still hidden after scrolling. A colour or opacity fade that is still on is a warning, not a problem.
 */
export async function checkMotion(browser: BrowserProvider, opts: MotionOptions): Promise<MotionReport> {
  const problems: MotionProblem[] = [];
  const warnings: MotionWarning[] = [];
  const layerIds = opts.expected.map((e) => e.layerId);

  const moving = await inBrowser(() => browser.open(opts.url, opts.width, 1, opts.isAllowed, { reducedMotion: 'no-preference', initScript: installRecorder }));
  let report: Omit<MotionReport, 'problems' | 'warnings'>;
  try {
    const { page } = moving;
    if (!(await settleSection(page, opts.scope))) throw new PageError(`No element matches "${opts.scope}" on ${opts.url}`);
    await page.waitForTimeout(500);   // animations that run as the page loads
    const targets = await inBrowser(() => hoverTargets(page, opts.scope, layerIds));
    const hovered = await inBrowser(() => hoverEach(page, targets, HOVER_WAIT_MS));
    await setPhase(page, 'scroll', null);
    const scroll = await inBrowser(() => timedScroll(page, SCROLL_MS));
    problems.push(...await inBrowser(() => loopJumps(page)));
    const records = await recorder(page);

    for (const r of records) {
      const layout = r.property.split(',').map((p) => p.trim()).filter((p) => LAYOUT_PROPERTY.test(p));
      if (layout.length > 0) {
        problems.push({ kind: 'layout-property', element: r.element,
          detail: `${r.kind} moves ${layout.join(', ')}, which makes the page lay out again every frame and stutter. Move it with transform or opacity instead.` });
      }
    }
    if (scroll.layoutShift > MAX_LAYOUT_SHIFT) {
      problems.push({ kind: 'layout-shift', element: scroll.sources[0] ?? 'page',
        detail: `Content jumped while scrolling (layout shift ${scroll.layoutShift.toFixed(3)}, the limit is ${MAX_LAYOUT_SHIFT}). Moved: ${scroll.sources.join(', ') || 'unknown'}` });
    }
    if (scroll.slowFrames > 0) {
      problems.push({ kind: 'slow-frames', element: 'page',
        detail: `${scroll.slowFrames} of ${scroll.frames} frames took over ${SLOW_FRAME_MS} ms during the ${SCROLL_MS / 1000}-second scroll (worst ${scroll.worstFrameMs} ms). A headless browser can be slower than a real one: check the recording.` });
    }
    problems.push(...timingProblems(opts.expected, records, new Set(targets.map((t) => t.label))));
    report = { width: opts.width, hovered, animations: records,
      scroll: { layoutShift: Math.round(scroll.layoutShift * 1000) / 1000, frames: scroll.frames, slowFrames: scroll.slowFrames, worstFrameMs: scroll.worstFrameMs } };
  } finally {
    await moving.close().catch(() => undefined);
  }

  const still = await inBrowser(() => browser.open(opts.url, opts.width, 1, opts.isAllowed, { reducedMotion: 'reduce', initScript: installRecorder }));
  try {
    const { page } = still;
    await settleSection(page, opts.scope);
    await page.waitForTimeout(300);
    const targets = await inBrowser(() => hoverTargets(page, opts.scope, layerIds));
    await inBrowser(() => hoverEach(page, targets, 100));
    await setPhase(page, 'scroll', null);
    await inBrowser(() => timedScroll(page, 600));
    const records = await recorder(page);
    const seen = new Set<string>();
    for (const r of records) {
      const key = `${r.element}|${r.property}`;
      if (seen.has(key) || (r.durationMs <= STILL_MS && r.iterations !== 'infinite')) continue;
      seen.add(key);
      const time = r.iterations === 'infinite' ? 'endless' : `${Math.round(r.durationMs)} ms`;
      // A colour or opacity fade moves nothing: it may stay with reduce motion on. Mention it, but it is not a problem.
      if (r.property.split(',').every((p) => FADE_PROPERTY.test(p.trim()))) {
        warnings.push({ kind: 'fades-with-reduced-motion', element: r.element,
          detail: `${r.property} fades (${time}) with reduce motion on. A fade is not motion, so it may stay; check the owner is happy with it.` });
        continue;
      }
      problems.push({ kind: 'moves-with-reduced-motion', element: r.element,
        detail: `${r.property} still moves (${time}) when the visitor asks for less motion. Switch it off in @media (prefers-reduced-motion: reduce).` });
    }
    const hidden = await inBrowser(() => page.locator(opts.scope).first().evaluate((root) => {
      const state = (window as unknown as { __pixelTwinMotion: Recorder }).__pixelTwinMotion;
      return [...root.querySelectorAll('[data-figma-id]')].filter((el) => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && (Number(s.opacity) < 0.01 || s.visibility === 'hidden');
      }).map((el) => state.describe(el));
    }));
    for (const element of hidden) {
      problems.push({ kind: 'hidden-with-reduced-motion', element,
        detail: 'Still hidden after scrolling the whole page with reduce motion on. Content must show without its animation.' });
    }
  } finally {
    await still.close().catch(() => undefined);
  }
  return { ...report, problems, warnings };
}
