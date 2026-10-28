import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import { measureSection, type MeasuredElement } from '../src/browser/measure';

let browser: BrowserProvider;
beforeAll(() => { browser = createBrowserProvider(); });
afterAll(async () => { await browser.close(); });

/** Measures `<div id="root">` + body inside a blank page. */
async function measure(body: string): Promise<Map<string, MeasuredElement>> {
  const s = await browser.open('about:blank', 600, 1, () => true);
  try {
    await s.page.setContent(`<style>
      @font-face { font-family: "Broken"; src: url(missing-font.woff2); }
      body { margin: 0; font: 16px/20px Helvetica; }
    </style><div id="root" data-figma-id="0:1">${body}</div>`);
    await s.page.evaluate(async () => { await document.fonts.ready; });
    const r = await measureSection(s.page, '#root');
    return new Map(r.elements.map((e) => [e.figmaId, e]));
  } finally {
    await s.close();
  }
}

test('a bigger word on the same line is still one line', async () => {
  const m = await measure(`
    <p data-figma-id="1" style="margin: 0; width: 400px">$<span style="font-size: 32px">99</span> per month</p>
    <p data-figma-id="2" style="margin: 0">Read the <b>full</b><br>story</p>
    <p data-figma-id="3" style="margin: 0; line-height: 14px">tight<br>lines<br>here</p>
    <div data-figma-id="4" style="width: 10px; height: 10px"></div>`);
  expect(m.get('1')!.lineCount).toBe(1);
  expect(m.get('2')!.lineCount).toBe(2);
  expect(m.get('3')!.lineCount).toBe(3);
  expect(m.get('4')!.lineCount).toBeNull();
  expect(m.get('2')!.text).toBe('Read the full\nstory');
  expect(m.get('4')!.text).toBeNull();
}, 30_000);

test('the shown text follows text-transform', async () => {
  const m = await measure('<p data-figma-id="1" style="text-transform: uppercase">from $12</p>');
  expect(m.get('1')!.text).toBe('FROM $12');
}, 30_000);

test('reads the box-shadow of a ::before or ::after layer placed exactly over the element', async () => {
  const m = await measure(`<style>
      .over { position: relative; width: 50px; height: 20px; }
      .over::after { content: ''; position: absolute; inset: 0; box-shadow: inset 0 0 0 0.5px #ddd; }
      .moved::after { inset: 2px; }
      .static { position: static; }
    </style>
    <div data-figma-id="1" class="over"></div>
    <div data-figma-id="2" class="over moved"></div>
    <div data-figma-id="3" class="over static"></div>
    <div data-figma-id="4" style="width: 10px; height: 10px"></div>`);
  expect(m.get('1')!.overlayShadows).toEqual(['rgb(221, 221, 221) 0px 0px 0px 0.5px inset']);
  for (const id of ['2', '3', '4']) expect(m.get(id)!.overlayShadows).toBeUndefined();
}, 30_000);

test('reports whether each element is visible', async () => {
  const m = await measure(`
    <p data-figma-id="1">shown</p>
    <p data-figma-id="2" style="visibility: hidden">hidden</p>
    <p data-figma-id="3" style="display: none">gone</p>`);
  expect([m.get('1')!.visible, m.get('2')!.visible, m.get('3')!.visible]).toEqual([true, false, false]);
}, 30_000);

test('reports when the asked-for font did not load', async () => {
  const m = await measure(`
    <p data-figma-id="1">system font</p>
    <p data-figma-id="2" style="font-family: Broken">web font that failed</p>
    <div data-figma-id="3" style="font-family: Broken; width: 5px; height: 5px"></div>`);
  expect([m.get('1')!.fontLoaded, m.get('2')!.fontLoaded, m.get('3')!.fontLoaded]).toEqual([true, false, true]);
}, 30_000);

test('pages open asking for reduced motion', async () => {
  const s = await browser.open('about:blank', 600, 1, () => true);
  try {
    expect(await s.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  } finally {
    await s.close();
  }
}, 30_000);
