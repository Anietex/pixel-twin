import type { Page } from 'playwright';

export interface MeasuredElement {
  figmaId: string; tag: string;
  x: number; y: number; width: number; height: number;   // relative to the section root's top-left corner
  style: Record<string, string>;                           // computed values of MEASURED_PROPERTIES
  lineCount: number | null;                                // null when the element has no text
  text?: string | null;                                    // the text as shown (innerText); null or missing when it has none
  visible: boolean;                                        // false for display: none or visibility: hidden
  fontLoaded: boolean;                                     // false when its text uses a web font that did not load
  overlayShadows?: string[];                               // box-shadow of each ::before / ::after layer that covers the element exactly
}

/** The computed CSS values read for every element with a data-figma-id. */
export const MEASURED_PROPERTIES = [
  'background-color', 'background-image',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'filter', 'backdrop-filter', 'opacity',
  'font-family', 'font-weight', 'font-size', 'line-height', 'letter-spacing', 'color',
] as const;

/** A text piece joins a line when their heights overlap by more than this share of the smaller height. */
export const LINE_OVERLAP_SHARE = 0.5;

/**
 * Measures the one element `selector` matches (the section root) and every element inside it with a
 * data-figma-id, in one call into the page. The root counts too when it has a data-figma-id.
 */
export async function measureSection(page: Page, selector: string): Promise<{
  root: { x: number; y: number; width: number; height: number };
  elements: MeasuredElement[];
}> {
  return page.locator(selector).evaluate((root, { props, share }) => {
    const rootBox = root.getBoundingClientRect();
    const range = document.createRange();
    // Groups the boxes of the text pieces into lines by how much their heights overlap,
    // so a bigger word on a line does not count as a second line.
    const lineCount = (el: Element): number | null => {
      const spans: { top: number; bottom: number }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? '').trim()) continue;
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (r.height > 0) spans.push({ top: r.top, bottom: r.bottom });
      }
      if (spans.length === 0) return null;
      spans.sort((a, b) => a.top - b.top);
      const lines: { top: number; bottom: number }[] = [];
      for (const s of spans) {
        const line = lines.find((l) => Math.min(l.bottom, s.bottom) - Math.max(l.top, s.top)
          > share * Math.min(l.bottom - l.top, s.bottom - s.top));
        if (line) {
          line.top = Math.min(line.top, s.top);
          line.bottom = Math.max(line.bottom, s.bottom);
        } else {
          lines.push({ ...s });
        }
      }
      return lines.length;
    };
    // document.fonts.check is false only for a web font (@font-face) that failed or has not loaded.
    const fontLoaded = (style: Record<string, string>, hasText: boolean): boolean => {
      if (!hasText) return true;
      const family = (style['font-family'].split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').replace(/["\\]/g, '\\$&');
      try {
        return document.fonts.check(`${style['font-weight']} ${style['font-size']} "${family}"`);
      } catch {
        return true; // a value check() can't read: don't report it
      }
    };
    // A ::before or ::after layer placed exactly over the element (absolute, every side 0) can draw its lines on top.
    const overlayShadows = (el: Element, own: CSSStyleDeclaration): string[] => {
      if (own.position === 'static') return [];
      return ['::before', '::after'].flatMap((which) => {
        const p = getComputedStyle(el, which);
        const covers = p.content !== 'none' && p.content !== 'normal' && p.position === 'absolute'
          && [p.top, p.right, p.bottom, p.left].every((v) => v === '0px');
        return covers && p.boxShadow !== 'none' ? [p.boxShadow] : [];
      });
    };
    const tagged = [root, ...root.querySelectorAll('[data-figma-id]')].filter((el) => el.hasAttribute('data-figma-id'));
    return {
      root: { x: rootBox.left + window.scrollX, y: rootBox.top + window.scrollY, width: rootBox.width, height: rootBox.height },
      elements: tagged.map((el) => {
        const box = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const p of props) style[p] = computed.getPropertyValue(p);
        const lines = lineCount(el);
        const overlays = overlayShadows(el, computed);
        return {
          figmaId: el.getAttribute('data-figma-id') ?? '', tag: el.tagName.toLowerCase(),
          x: box.left - rootBox.left, y: box.top - rootBox.top, width: box.width, height: box.height,
          style, lineCount: lines, text: lines === null ? null : (el as HTMLElement).innerText,
          visible: el.checkVisibility({ visibilityProperty: true }),
          fontLoaded: fontLoaded(style, lines !== null),
          ...(overlays.length ? { overlayShadows: overlays } : {}),
        };
      }),
    };
  }, { props: [...MEASURED_PROPERTIES], share: LINE_OVERLAP_SHARE });
}
