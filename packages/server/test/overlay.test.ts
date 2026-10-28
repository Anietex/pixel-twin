import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { downscalePng, findRegions, makeOverlay } from '../src/compare/overlay';

/** A mask with filled squares given as [x, y, size]. */
function mask(width: number, height: number, squares: [number, number, number][]): Uint8Array {
  const m = new Uint8Array(width * height);
  for (const [x0, y0, s] of squares) {
    for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) m[y * width + x] = 1;
  }
  return m;
}

/** A solid PNG with an optional coloured square [x, y, size]. */
function png(width: number, height: number, rgb: [number, number, number], square?: { at: [number, number, number]; rgb: [number, number, number] }): Buffer {
  const p = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = square && x >= square.at[0] && x < square.at[0] + square.at[2] && y >= square.at[1] && y < square.at[1] + square.at[2];
      const c = inside ? square.rgb : rgb;
      p.data.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
    }
  }
  return PNG.sync.write(p);
}

test('blobs 3 px apart merge, 20 px apart do not', () => {
  expect(findRegions(mask(60, 20, [[5, 5, 5], [13, 5, 5]]), 60, 20, 8)).toEqual([{ x: 5, y: 5, width: 13, height: 5 }]);
  expect(findRegions(mask(60, 20, [[5, 5, 5], [30, 5, 5]]), 60, 20, 8)).toEqual([
    { x: 5, y: 5, width: 5, height: 5 }, { x: 30, y: 5, width: 5, height: 5 }]);
  expect(findRegions(new Uint8Array(60 * 20), 60, 20, 8)).toEqual([]);
});

test('makeOverlay saves three images and gives regions in 1x px', async () => {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-')), 'out');
  const design = png(80, 40, [255, 255, 255], { at: [20, 10, 10], rgb: [0, 0, 0] });
  const build = png(80, 40, [255, 255, 255], { at: [40, 10, 10], rgb: [0, 0, 0] });
  const r = await makeOverlay(design, build, dir, 2);
  for (const p of [r.designPath, r.buildPath, r.diffPath]) expect(existsSync(p)).toBe(true);
  expect(r.diffPixels).toBeGreaterThan(0);
  // Both squares are 10 device px apart, so they merge into one region from x 10 to x 25 in 1x px.
  expect(r.regions).toMatchObject([{ x: 10, y: 5, width: 15, height: 5 }]);
  expect(existsSync(r.regions[0].crop!)).toBe(true);
  const diff = PNG.sync.read(await readFile(r.diffPath));
  expect([diff.width, diff.height]).toEqual([80, 40]);
});

test('makeOverlay pads the smaller image with magenta and marks the extra area', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-'));
  const r = await makeOverlay(png(80, 40, [255, 255, 255]), png(80, 30, [255, 255, 255]), dir, 2);
  expect(r.regions).toMatchObject([{ x: 0, y: 15, width: 40, height: 5 }]);
  // All ten padded rows count: magenta is nowhere near in the design, so no shift explains them.
  expect(r.diffPixels).toBe(80 * 10);
});

test('downscalePng halves a 2x picture', () => {
  const small = PNG.sync.read(downscalePng(png(80, 41, [10, 20, 30]), 2));
  expect([small.width, small.height]).toEqual([40, 21]);
  expect([...small.data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
});

/** A transparent PNG with an opaque coloured square. */
function clearPng(width: number, height: number, square: [number, number, number], rgb: [number, number, number]): Buffer {
  const p = new PNG({ width, height });
  for (let y = square[1]; y < square[1] + square[2]; y++) {
    for (let x = square[0]; x < square[0] + square[2]; x++) p.data.set([...rgb, 255], (y * width + x) * 4);
  }
  return PNG.sync.write(p);
}

test('a one-device-pixel shift is not a change', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-'));
  const design = png(80, 40, [255, 255, 255], { at: [20, 10, 10], rgb: [0, 0, 0] });
  const build = png(80, 40, [255, 255, 255], { at: [21, 11, 10], rgb: [0, 0, 0] });
  const r = await makeOverlay(design, build, dir, 2);
  expect(r.regions).toEqual([]);
  expect(r.diffPixels).toBe(0);
});

test('transparent parts of the design are drawn on the page background', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-'));
  const design = clearPng(80, 40, [20, 10, 10], [0, 0, 0]);
  const build = png(80, 40, [200, 220, 255], { at: [20, 10, 10], rgb: [0, 0, 0] });
  expect((await makeOverlay(design, build, dir, 2, { background: { r: 200, g: 220, b: 255 } })).regions).toEqual([]);
  // On the default white background the same pair differs everywhere outside the square.
  expect((await makeOverlay(design, build, dir, 2)).diffPixels).toBeGreaterThan(0);
});

test('changed areas come biggest first, each with a crop, and old crops are cleared', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-'));
  const base = png(200, 60, [255, 255, 255]);
  const two = PNG.sync.read(base);
  for (const [x0, size] of [[10, 4], [120, 30]] as const) {
    for (let y = 10; y < 10 + size; y++) for (let x = x0; x < x0 + size; x++) two.data.set([0, 0, 0, 255], (y * 200 + x) * 4);
  }
  const r = await makeOverlay(base, PNG.sync.write(two), dir, 2);
  expect(r.regions.map((g) => g.x)).toEqual([60, 5]);
  expect(r.regions[0].pixels).toBeGreaterThan(r.regions[1].pixels);
  const crop = PNG.sync.read(await readFile(r.regions[0].crop!));
  expect(crop.width).toBeGreaterThan(crop.height);   // three pictures side by side
  const again = await makeOverlay(base, base, dir, 2);
  expect(again.regions).toEqual([]);
  expect(existsSync(path.join(dir, 'areas'))).toBe(false);
});

/** A white picture with blocks painted on it: [x, y, width, height, rgb]. */
function paint(width: number, height: number, blocks: [number, number, number, number, [number, number, number]][]): Buffer {
  const p = PNG.sync.read(png(width, height, [255, 255, 255]));
  for (const [x0, y0, w, h, rgb] of blocks) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) p.data.set([...rgb, 255], (y * width + x) * 4);
  }
  return PNG.sync.write(p);
}

test('a thin line only the build has is a change, not a shift', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-'));
  const r = await makeOverlay(paint(400, 200, []), paint(400, 200, [[20, 100, 300, 2, [0, 0, 0]]]), dir, 2);
  expect(r.regions).toMatchObject([{ x: 10, y: 50, width: 150, height: 1 }]);
});

test('a thin area gets a crop at least 40 px tall, enlarged, with the three panels stacked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-'));
  const r = await makeOverlay(paint(400, 200, []), paint(400, 200, [[20, 100, 300, 2, [0, 0, 0]]]), dir, 2);
  const crop = PNG.sync.read(await readFile(r.regions[0].crop!));
  // 40 px tall plus 8 px space above and below is 112 device px; 332 device px wide; enlarged 2 times.
  expect([crop.width, crop.height]).toEqual([332 * 2, 3 * 112 * 2 + 2 * 8]);
});

test('inside matching text, letter-edge noise is left out and counted; a real change stays', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-'));
  const design = paint(200, 100, [[20, 20, 4, 4, [100, 100, 100]]]);
  // A slightly lighter edge, a 3 × 3 speck and a 12 × 12 square that the design does not have.
  const build = paint(200, 100, [[20, 20, 4, 4, [140, 140, 140]], [60, 20, 3, 3, [0, 0, 0]], [120, 20, 12, 12, [0, 0, 0]]]);
  const plain = await makeOverlay(design, build, dir, 2);
  expect(plain.regions).toHaveLength(3);
  expect(plain.textEdgeAreas).toBe(0);
  const text = await makeOverlay(design, build, dir, 2, { textBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] });
  expect(text.regions).toMatchObject([{ x: 60, y: 10, width: 6, height: 6 }]);
  expect(text.textEdgeAreas).toBe(1);
});

/** A picture drawn by `paint`, which gives the colour of each device pixel. */
function draw(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) p.data.set([...paint(x, y), 255], (y * width + x) * 4);
  return PNG.sync.write(p);
}
const WHITE: [number, number, number] = [255, 255, 255];
const inBox = (x: number, y: number, [bx, by, bw, bh]: number[]) => x >= bx && x < bx + bw && y >= by && y < by + bh;
const box = (b: number[], rgb: [number, number, number]) => (x: number, y: number) => (inBox(x, y, b) ? rgb : WHITE);
const kinds = async (design: Buffer, build: Buffer, options = {}) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-overlay-'));
  return (await makeOverlay(design, build, dir, 2, options)).regions.map((r) => ({ kind: r.kind, label: r.label, shift: r.shift }));
};

test('each changed area is named with what it most likely is', async () => {
  // The same square, 4 device px (2 px) to the right.
  expect(await kinds(draw(80, 40, box([20, 10, 10, 10], [0, 0, 0])), draw(80, 40, box([24, 10, 10, 10], [0, 0, 0]))))
    .toEqual([{ kind: 'shifted', label: 'same content shifted 2 px right', shift: { x: 2, y: 0 } }]);
  // A square only the design has, only the build has, or in another colour.
  const red = draw(80, 40, box([20, 10, 12, 12], [255, 0, 0]));
  const plain = draw(80, 40, () => WHITE);
  expect(await kinds(red, plain)).toMatchObject([{ kind: 'missing', label: 'content in design, missing in build' }]);
  expect(await kinds(plain, red)).toMatchObject([{ kind: 'extra', label: 'content in build, not in design' }]);
  expect(await kinds(red, draw(80, 40, box([20, 10, 12, 12], [0, 0, 255]))))
    .toMatchObject([{ kind: 'colour', label: 'colour differs: design #FF0000, build #0000FF' }]);
  // A photo that is blank in the build.
  const photo = draw(80, 40, (x, y) => (inBox(x, y, [10, 5, 30, 30]) ? [x * 8, y * 7, (x * y) % 256] : WHITE));
  expect(await kinds(photo, plain)).toMatchObject([{ kind: 'blank-picture', label: 'picture blank in build' }]);
});

test('thin areas are named as lines, or as edges drawn a little differently', async () => {
  const GREY: [number, number, number] = [136, 136, 136];
  const line = (from: number, rgb = GREY) => draw(100, 40, (x, y) => (y === 20 && x >= from ? rgb : WHITE));
  const onLine = { lineBoxes: [{ x: 0, y: 10, width: 50, height: 0.5 }] };
  const over = (lineFrom: number) => draw(100, 40, (x, y) => (y === 20 && x >= lineFrom ? GREY : y > 20 ? [x * 2, 60, 90] : WHITE));
  // An edge between two shaded parts, drawn in another grey.
  const edge = (grey: number) => draw(80, 40, (x) => (x < 40 ? [x * 3, 0, 0] : x === 40 ? [grey, grey, grey] : [255, 255 - x, 255]));
  // The design's line is missing over its left half in the build, found from the pixels alone…
  expect(await kinds(line(0), line(50))).toMatchObject([{ kind: 'line-missing', label: 'line in design, missing in build' }]);
  expect(await kinds(line(50), line(0))).toMatchObject([{ kind: 'line-extra', label: 'line in build, not in design' }]);
  // …and where the design says it draws a line (1x px): there it counts even next to a plain colour, where
  // pixelmatch takes it for edge smoothing.
  expect(await kinds(over(0), over(50))).toEqual([]);
  expect(await kinds(over(0), over(50), onLine)).toMatchObject([{ kind: 'line-missing' }]);
  expect(await kinds(line(0), line(0, [170, 170, 170]), onLine))
    .toMatchObject([{ kind: 'line-differs', label: 'line drawn a little differently (colour, weight or place)' }]);
  expect(await kinds(edge(128), edge(60))).toMatchObject([{ kind: 'edge-smoothing' }]);
});

test('the areas are counted by kind for the summary', async () => {
  const { areaKindSummary } = await import('../src/compare/overlay');
  const r = (kind: string) => ({ x: 0, y: 0, width: 1, height: 1, pixels: 1, kind, label: '', similarity: 0 }) as any;
  expect(areaKindSummary([r('line-missing'), r('shifted'), r('line-missing')]))
    .toBe('2× line in design, missing in build; 1× same content shifted');
});
