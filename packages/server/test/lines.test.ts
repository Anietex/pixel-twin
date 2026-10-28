import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import { checkLines, type LineTarget } from '../src/browser/lines';

let browser: BrowserProvider;
beforeAll(() => { browser = createBrowserProvider(); });
afterAll(async () => { await browser?.close(); });

const PIXEL = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22%3E%3Crect width=%221%22 height=%221%22 fill=%22red%22/%3E%3C/svg%3E';
const PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; }
  .frame { position: relative; width: 300px; height: 100px; display: flex; margin-bottom: 20px; box-shadow: inset 0 0 0 0.5px #000; }
  .pic { width: 100px; height: 100px; background: #f00; flex: none; }
  .on-top::after { content: ''; position: absolute; inset: 0; box-shadow: inset 0 0 0 0.5px #000; pointer-events: none; }
  .bordered { border: 1px solid #000; box-shadow: none; }
  .faded { opacity: 0; }
</style></head><body><div id="root">
  <div class="frame" data-figma-id="1:1"><div class="pic" data-figma-id="1:2" style="pointer-events: none"></div><span>words</span></div>
  <div class="frame on-top" data-figma-id="2:1"><div class="pic" data-figma-id="2:2"></div></div>
  <div class="frame bordered" data-figma-id="3:1"><div class="pic"></div></div>
  <div class="frame" data-figma-id="4:1"><div class="pic faded"></div></div>
  <div class="frame" data-figma-id="5:1" style="margin-top: 1500px"><img src="${PIXEL}" alt="" style="width: 300px; height: 100px"></div>
</div></body></html>`;

const ALL_SIDES = (figmaId: string): LineTarget => ({ figmaId, sides: (['top', 'right', 'bottom', 'left'] as const).map((side) => ({ side, depth: 0.25 })) });

test('a frame line is hidden where a child with a background or picture covers its edge, and shown when drawn on top', async () => {
  const session = await browser.open(`data:text/html,${encodeURIComponent(PAGE)}`, 400, 2, () => true);
  try {
    const results = await checkLines(session.page, '#root', ['1:1', '2:1', '3:1', '4:1', '5:1'].map(ALL_SIDES));
    const of = (id: string, side: string) => results.find((r) => r.figmaId === id && r.side === side)!;
    // The red picture covers the left 100 px: a third of the top and bottom lines, and the whole left line.
    expect(of('1:1', 'left')).toMatchObject({ hidden: of('1:1', 'left').points, under: ['[data-figma-id="1:2"]'] });
    expect(of('1:1', 'top').hidden / of('1:1', 'top').points).toBeCloseTo(1 / 3, 1);
    expect(of('1:1', 'right').hidden).toBe(0);
    for (const id of ['2:1', '3:1', '4:1']) {
      expect(results.filter((r) => r.figmaId === id).map((r) => r.hidden)).toEqual([0, 0, 0, 0]);
    }
    // Below the first screen, under a picture that has no data-figma-id.
    expect(of('5:1', 'top')).toMatchObject({ hidden: of('5:1', 'top').points, under: ['img'] });
    expect(of('5:1', 'top').points).toBeGreaterThan(0);
    expect(await session.page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    await session.close();
  }
});
