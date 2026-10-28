import type { Page } from 'playwright';
import type { Rgb } from '../compare/overlay';
import { parseColor } from '../compare/css';

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/**
 * The colour behind the section on the page: the first background colour that isn't transparent on the
 * section root or one of its parents, or white. Transparent parts of the Figma picture are drawn on it.
 */
export async function pageBackground(page: Page, selector: string): Promise<Rgb> {
  const raw = await page.locator(selector).evaluate((el) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
    }
    return null;
  });
  const c = raw ? parseColor(raw) : null;
  return c ? { r: c.r, g: c.g, b: c.b } : WHITE;
}
