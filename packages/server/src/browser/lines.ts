import type { Page } from 'playwright';

export type Side = 'top' | 'right' | 'bottom' | 'left';
/** A frame line to test: on which sides, and how far inside the box edge the middle of each line is (px). */
export interface LineTarget { figmaId: string; sides: { side: Side; depth: number }[] }
/**
 * The result for one side of a frame line: how many points along it were tested, at how many something
 * inside the frame covers it, and what covers it (up to MAX_NAMES names).
 */
export interface LineResult { figmaId: string; side: Side; points: number; hidden: number; under: string[] }

/** One point is tested every this many px along a line, at least MIN_POINTS and at most MAX_POINTS per side. */
export const LINE_POINT_SPACING_PX = 8;
const MIN_POINTS = 5;
const MAX_POINTS = 200;
const MAX_NAMES = 3;

/**
 * Figma draws a frame's line (its stroke) above the frame's children. In CSS, a border or an inset
 * box-shadow is painted below them, so a child with a background or a picture at the frame's edge hides
 * the line. This tests points along each side's line in the browser: at each point, it walks down the
 * elements there from the top (Chrome's paint order), keeping only those whose box holds the exact point.
 * The line counts as shown when it reaches the frame itself, or an element
 * inside it that draws a line along the same edge (such as a ::after line drawn on top). It counts as
 * hidden when it first meets an element inside the frame that paints there: a background colour, a
 * background picture, an img, video, canvas or iframe. Elements outside the frame don't count, and nor do
 * points where the frame itself can't be reached (clipped or hidden). Corners are skipped.
 * pointer-events: none is ignored while it runs, and the scroll position is put back.
 */
export async function checkLines(page: Page, selector: string, targets: LineTarget[]): Promise<LineResult[]> {
  if (targets.length === 0) return [];
  return page.locator(selector).evaluate((root, { targets: list, spacing, minPoints, maxPoints, maxNames }) => {
    const style = document.createElement('style');
    style.textContent = '*, *::before, *::after { pointer-events: auto !important; }';
    (document.head ?? document.documentElement).append(style);
    const start = { x: window.scrollX, y: window.scrollY };
    const docBox = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { left: r.left + window.scrollX, top: r.top + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY };
    };
    const name = (e: Element, frame: Element): string => {
      const tagged = e.closest('[data-figma-id]');
      if (tagged && tagged !== frame && frame.contains(tagged)) return `[data-figma-id="${tagged.getAttribute('data-figma-id')}"]`;
      const tag = e.tagName.toLowerCase();
      if (e.id) return `${tag}#${e.id}`;
      const cls = [...e.classList][0];
      return cls ? `${tag}.${cls}` : tag;
    };
    const alpha = (colour: string): number => {
      if (colour === 'transparent') return 0;
      const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(colour);
      if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
      const rgba = /^rgba\(.*,\s*([\d.]+)\s*\)$/.exec(colour);
      return rgba ? Number(rgba[1]) : 1;
    };
    const paints = (e: Element): boolean => {
      if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      if (['IMG', 'VIDEO', 'CANVAS', 'IFRAME'].includes(e.tagName)) return true;
      const s = getComputedStyle(e);
      return s.backgroundImage !== 'none' || alpha(s.backgroundColor) > 0.1;
    };
    // An element that draws a line (border or box-shadow) along the frame's edge on this side.
    const drawsEdge = (e: Element, side: string, frame: { left: number; top: number; right: number; bottom: number }): boolean => {
      const s = getComputedStyle(e);
      const width = parseFloat(s.getPropertyValue(`border-${side}-width`)) || 0;
      if (width === 0 && s.boxShadow === 'none') return false;
      const b = docBox(e);
      const near = (a: number, c: number) => Math.abs(a - c) <= 1.5;
      if (side === 'top') return near(b.top, frame.top);
      if (side === 'bottom') return near(b.bottom, frame.bottom);
      if (side === 'left') return near(b.left, frame.left);
      return near(b.right, frame.right);
    };
    const firstValue = (v: string) => parseFloat(v) || 0;
    // Chrome's hit test reaches about 1 px past an element's edge, so an element counts only when its own box,
    // cut by every parent up to the frame that clips its overflow, holds the exact point.
    const holds = (e: Element, frame: Element, x: number, y: number): boolean => {
      for (let a: Element | null = e; a && a !== frame; a = a.parentElement) {
        if (a !== e) {
          const st = getComputedStyle(a);
          if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
        }
        const r = a.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
      }
      return true;
    };

    const results: { figmaId: string; side: 'top' | 'right' | 'bottom' | 'left'; points: number; hidden: number; under: string[] }[] = [];
    try {
      for (const target of list) {
        const candidates = [root, ...root.querySelectorAll('[data-figma-id]')]
          .filter((e) => e.getAttribute('data-figma-id') === target.figmaId);
        const el = candidates.find((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && e.checkVisibility({ visibilityProperty: true });
        });
        if (!el || el.children.length === 0) continue;
        const s = getComputedStyle(el);
        for (const { side, depth } of target.sides) {
          const box = docBox(el);
          const across = side === 'top' || side === 'bottom';
          // Corner radii at the two ends of this side: the line curves there, so those parts are skipped.
          const [r0, r1] = side === 'top' ? [s.borderTopLeftRadius, s.borderTopRightRadius]
            : side === 'bottom' ? [s.borderBottomLeftRadius, s.borderBottomRightRadius]
              : side === 'left' ? [s.borderTopLeftRadius, s.borderBottomLeftRadius]
                : [s.borderTopRightRadius, s.borderBottomRightRadius];
          const from = (across ? box.left : box.top) + Math.max(1, firstValue(r0));
          const to = (across ? box.right : box.bottom) - Math.max(1, firstValue(r1));
          if (to - from <= 2) continue;
          const fixed = side === 'top' ? box.top + depth : side === 'bottom' ? box.bottom - depth
            : side === 'left' ? box.left + depth : box.right - depth;
          const count = Math.min(maxPoints, Math.max(minPoints, Math.ceil((to - from) / spacing)));
          let points = 0;
          let hidden = 0;
          const under = new Set<string>();
          for (let i = 0; i < count; i++) {
            const along = from + ((i + 0.5) * (to - from)) / count;
            const x = across ? along : fixed;
            const y = across ? fixed : along;
            if (y - window.scrollY < 1 || y - window.scrollY > window.innerHeight - 1
              || x - window.scrollX < 1 || x - window.scrollX > window.innerWidth - 1) {
              window.scrollTo({ left: x - window.innerWidth / 2, top: y - window.innerHeight / 2, behavior: 'instant' });
            }
            const frame = docBox(el);
            let verdict: Element | 'shown' | null = null;
            const cx = x - window.scrollX;
            const cy = y - window.scrollY;
            for (const e of document.elementsFromPoint(cx, cy)) {
              if (e === el) { verdict = 'shown'; break; }
              if (!el.contains(e)) continue;   // outside the frame: page parts and siblings don't count
              if (!holds(e, el, cx, cy)) continue;
              if (drawsEdge(e, side, frame)) { verdict = 'shown'; break; }
              if (paints(e)) { verdict = e; break; }
            }
            if (verdict === null) continue;   // the frame can't be reached here
            points += 1;
            if (verdict !== 'shown') {
              hidden += 1;
              if (under.size < maxNames) under.add(name(verdict, el));
            }
          }
          results.push({ figmaId: target.figmaId, side, points, hidden, under: [...under] });
        }
      }
    } finally {
      style.remove();
      window.scrollTo({ left: start.x, top: start.y, behavior: 'instant' });
    }
    return results;
  }, { targets, spacing: LINE_POINT_SPACING_PX, minPoints: MIN_POINTS, maxPoints: MAX_POINTS, maxNames: MAX_NAMES });
}
