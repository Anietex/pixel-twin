import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MeasuredElement } from '../src/browser/measure';
import { diffSection, lineTargets } from '../src/compare/diffNumbers';
import { assetCoveredIds, planAssets } from '../src/design/assets';
import { toSectionData, type RestNode } from '../src/design/normalize';
import type { Layer, SectionData } from '../src/design/types';
import { WARNING } from '../src/design/warnings';

const load = (name: string) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const hero = (): SectionData => toSectionData({
  document: load('hero.rest.json').document as RestNode, textDetails: load('hero.text.json'), variables: load('hero.vars.json'),
});
const d = hero();
const covered = assetCoveredIds(d.root, planAssets(d.root));

const BASE: Record<string, string> = {
  'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none',
  'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
  'border-top-color': 'rgb(0, 0, 0)', 'border-right-color': 'rgb(0, 0, 0)', 'border-bottom-color': 'rgb(0, 0, 0)', 'border-left-color': 'rgb(0, 0, 0)',
  'border-top-left-radius': '0px', 'border-top-right-radius': '0px', 'border-bottom-right-radius': '0px', 'border-bottom-left-radius': '0px',
  'box-shadow': 'none', filter: 'none', 'backdrop-filter': 'none', opacity: '1',
  'font-family': 'Helvetica, Arial, sans-serif', 'font-weight': '400', 'font-size': '16px', 'line-height': 'normal',
  'letter-spacing': 'normal', color: 'rgb(0, 0, 0)',
};
const RADIUS_8 = {
  'border-top-left-radius': '8px', 'border-top-right-radius': '8px', 'border-bottom-right-radius': '8px', 'border-bottom-left-radius': '8px',
};
const el = (figmaId: string, tag: string, x: number, y: number, width: number, height: number,
  style: Record<string, string> = {}, lineCount: number | null = null): MeasuredElement =>
  ({ figmaId, tag, x, y, width, height, style: { ...BASE, ...style }, lineCount, visible: true, fontLoaded: true });

const exact: MeasuredElement[] = [
  el('1:1', 'section', 0, 0, 600, 200, { 'background-color': 'rgb(255, 255, 255)' }, 4),
  el('1:2', 'h1', 24, 24, 300, 40, { 'font-weight': '700', 'font-size': '32px', 'line-height': '40px', color: 'rgb(17, 17, 17)' }, 1),
  el('1:9', 'p', 24, 72, 300, 40, { 'line-height': '20px', color: 'rgb(51, 51, 51)' }, 2),
  el('1:3', 'a', 24, 120, 160, 48,
    { 'background-color': 'rgb(34, 85, 255)', ...RADIUS_8, 'box-shadow': 'rgba(0, 0, 0, 0.25) 0px 2px 4px 0px' }, 1),
  el('1:4', 'span', 48, 132, 112, 24, { 'font-weight': '500', 'line-height': '24px', color: 'rgb(255, 255, 255)' }, 1),
  el('1:5', 'img', 360, 24, 216, 152),
  el('1:6', 'img', 200, 132, 24, 24),
];

const BOX_KEYS = new Set(['x', 'y', 'width', 'height', 'lineCount', 'visible', 'fontLoaded']);
/** Copies the exact build, applies changes per layer id (box keys go to the box, the rest to style), and diffs it. */
function run(over: Record<string, Record<string, string | number | boolean>>, opts: {
  design?: SectionData; drop?: string[]; explained?: { layerId: string; reason: string }[]; extra?: MeasuredElement[];
} = {}) {
  const measured = [...(opts.extra ?? []), ...exact]
    .filter((m) => !opts.drop?.includes(m.figmaId))
    .map((m) => {
      const copy: MeasuredElement = { ...m, style: { ...m.style } };
      for (const [k, v] of Object.entries(over[m.figmaId] ?? {})) {
        if (BOX_KEYS.has(k)) (copy as any)[k] = v;
        else copy.style[k] = String(v);
      }
      return copy;
    });
  return diffSection(opts.design ?? d, measured, covered, opts.explained ?? []);
}

/** A copy of the hero design with one layer changed, and optional warnings on it. */
function withLayer(id: string, change: (l: Layer) => void, warnings: string[] = []): SectionData {
  const copy = hero();
  const find = (l: Layer): Layer | undefined => (l.id === id ? l : l.children.map(find).find(Boolean));
  const layer = find(copy.root)!;
  change(layer);
  for (const reason of warnings) copy.warnings.push({ layerId: id, layerName: layer.name, reason });
  return copy;
}

test('an exact build has no differences', () => {
  const r = diffSection(d, exact, covered, []);
  expect(r.differences).toEqual([]);
  expect(r.unmapped).toEqual([]);
  expect(r.paired).toBe(7);
  expect(r.checkByEye).toEqual([]);
  expect(r.cannotMatch).toEqual([]);
  expect(r.unchecked).toEqual([{ layerId: '1:6', layerName: 'Icon',
    reason: '1 layer inside is drawn by this exported SVG, so only the picture\'s box is checked' }]);
});

test('explained layers are listed as unchecked with their reason', () => {
  const r = diffSection(d, exact.filter((m) => m.figmaId !== '1:2'), covered, [{ layerId: '1:2', reason: 'part of the logo image' }]);
  expect(r.unmapped).toEqual([]);
  expect(r.unchecked).toContainEqual({ layerId: '1:2', layerName: 'Title', reason: 'Explained: part of the logo image' });
});

test('0.6 px off still matches; 1 px off does not', () => {
  expect(run({ '1:3': { x: 24.6 } }).differences).toEqual([]);
  expect(run({ '1:3': { x: 25 } }).differences).toEqual([{ layerId: '1:3', layerName: 'Button', property: 'x', design: 24, build: 25 }]);
  expect(run({ '1:1': { width: 590 } }).differences).toEqual([{ layerId: '1:1', layerName: 'Hero', property: 'width', design: 600, build: 590 }]);
});

test('colours must be equal; opacity within 0.01', () => {
  expect(run({ '1:3': { 'background-color': 'rgb(34, 85, 254)' } }).differences[0].property).toBe('background-color');
  expect(run({ '1:3': { 'box-shadow': 'rgba(0, 0, 0, 0.255) 0px 2px 4px 0px' } }).differences).toEqual([]);
  expect(run({ '1:3': { 'box-shadow': 'rgba(0, 0, 0, 0.27) 0px 2px 4px 0px' } }).differences).toHaveLength(1);
  expect(run({ '1:3': { opacity: '0.995' } }).differences).toEqual([]);
  expect(run({ '1:3': { opacity: '0.98' } }).differences).toEqual([{ layerId: '1:3', layerName: 'Button', property: 'opacity', design: 1, build: 0.98 }]);
  expect(run({ '1:2': { color: 'rgb(17, 17, 18)' } }).differences).toEqual([{ layerId: '1:2', layerName: 'Title', property: 'color', design: '#111111', build: '#111112' }]);
});

test('line height within 0.01 px; "normal" is a difference', () => {
  expect(run({ '1:2': { 'line-height': '40.005px' } }).differences).toEqual([]);
  expect(run({ '1:2': { 'line-height': '40.02px' } }).differences).toEqual([{ layerId: '1:2', layerName: 'Title', property: 'line-height', design: 40, build: 40.02 }]);
  expect(run({ '1:2': { 'line-height': 'normal' } }).differences).toEqual([{ layerId: '1:2', layerName: 'Title', property: 'line-height', design: 40, build: 'line height not set' }]);
  expect(run({ '1:2': { 'letter-spacing': '0.5px' } }).differences[0]).toMatchObject({ property: 'letter-spacing', design: 0, build: 0.5 });
  expect(run({ '1:2': { 'font-family': '"helvetica", sans-serif' } }).differences).toEqual([]);
  expect(run({ '1:2': { 'font-family': 'Arial, sans-serif' } }).differences[0]).toMatchObject({ property: 'font-family', design: 'Helvetica', build: 'Arial' });
  expect(run({ '1:9': { lineCount: 3 } }).differences).toEqual([{ layerId: '1:9', layerName: 'Body', property: 'lineCount', design: 2, build: 3 }]);
});

test('a layer with no element is unmapped unless covered or explained', () => {
  expect(run({}, { drop: ['1:2'] }).unmapped).toEqual([{ layerId: '1:2', layerName: 'Title' }]);
  expect(run({}, { drop: ['1:2'], explained: [{ layerId: '1:2', reason: 'drawn in the hero image' }] }).unmapped).toEqual([]);
});

test('GROUP layers and layers inside svg assets need no element', () => {
  const r = run({}, { drop: ['1:6'] });
  expect(r.unmapped).toEqual([]);   // 1:6 is a GROUP, 1:7 sits inside its SVG
  expect(r.paired).toBe(6);
  // The svg asset layer is still box-checked when it has an element, but nothing else is checked.
  expect(run({ '1:6': { x: 202, 'background-color': 'rgb(1, 2, 3)' } }).differences)
    .toEqual([{ layerId: '1:6', layerName: 'Icon', property: 'x', design: 200, build: 202 }]);
});

test('mixed-style text is checked against its dominant run', () => {
  expect(run({ '1:9': { 'font-weight': '400' } }).differences).toEqual([]);
  expect(run({ '1:9': { 'font-weight': '700' } }).differences[0]).toMatchObject({ property: 'font-weight', design: 400, build: 700 });
});

test('a background with no fill must stay transparent; the image layer skips the background check', () => {
  expect(run({ '1:5': { 'background-color': 'rgb(200, 200, 200)' } }).differences).toEqual([]);
  const noFill = withLayer('1:3', (l) => { l.fills = []; });
  expect(run({}, { design: noFill }).differences[0]).toMatchObject({ layerId: '1:3', property: 'background-color', design: 'none', build: '#2255FF' });
});

test('two or more fills go to the check-by-eye list, not the differences', () => {
  const stacked = withLayer('1:3', (l) => { l.fills = [...l.fills, { type: 'solid', color: { hex: '#000000', alpha: 0.5 } }]; });
  const r = run({}, { design: stacked });
  expect(r.differences).toEqual([]);
  expect(r.checkByEye).toEqual([{ layerId: '1:3', layerName: 'Button', property: 'fills', reason: expect.stringContaining('2 fills') }]);
});

test('warnings: things a browser can draw are checked by eye, the rest cannot match', () => {
  const diamond = withLayer('1:3', (l) => {
    l.fills = [{ type: 'gradient', kind: 'diamond', angleDeg: 0, stops: [] }];
  }, [WARNING.diamondGradient.reason]);
  const r = run({}, { design: diamond });
  expect(r.differences).toEqual([]);   // no background check for a fill no browser can draw
  expect(r.cannotMatch).toEqual([{ layerId: '1:3', layerName: 'Button', reason: WARNING.diamondGradient.reason }]);
  expect(r.checkByEye).toEqual([]);
  const painted = withLayer('1:3', () => undefined, [WARNING.paintedBorder.reason]);
  const p = run({ '1:3': { 'border-top-width': '2px' } }, { design: painted });
  expect(p.differences).toEqual([]);   // the border can't be compared by numbers
  expect(p.checkByEye).toEqual([{ layerId: '1:3', layerName: 'Button', property: 'border', reason: WARNING.paintedBorder.reason }]);
  const gradientText = withLayer('1:2', () => undefined, [WARNING.textColorNotSolid.reason]);
  expect(run({ '1:2': { color: 'rgb(0, 0, 0)' } }, { design: gradientText }).differences).toEqual([]);
  // A layer drawn inside an exported SVG is drawn exactly by the SVG, so its warnings don't count.
  const inSvg = withLayer('1:7', () => undefined, [WARNING.textureNoise.reason]);
  expect(run({}, { design: inSvg })).toMatchObject({ cannotMatch: [], checkByEye: [] });
});

test('gradients: same kind and stops, positions within 0.01, angle within 1 degree', () => {
  const g = withLayer('1:3', (l) => {
    l.fills = [{ type: 'gradient', kind: 'linear', angleDeg: 90, stops: [
      { color: { hex: '#FF0000', alpha: 1 }, position: 0 }, { color: { hex: '#0000FF', alpha: 0.5 }, position: 1 }] }];
  });
  const css = (s: string) => run({ '1:3': { 'background-color': 'rgba(0, 0, 0, 0)', 'background-image': s } }, { design: g }).differences;
  expect(css('linear-gradient(90deg, rgb(255, 0, 0) 0%, rgba(0, 0, 255, 0.5) 100%)')).toEqual([]);
  expect(css('linear-gradient(to right, rgb(255, 0, 0), rgba(0, 0, 255, 0.5))')).toEqual([]);
  expect(css('linear-gradient(90.5deg, rgb(255, 0, 0) 0.5%, rgba(0, 0, 255, 0.5) 100%)')).toEqual([]);
  expect(css('linear-gradient(92deg, rgb(255, 0, 0) 0%, rgba(0, 0, 255, 0.5) 100%)')[0])
    .toMatchObject({ property: 'background-image', design: 'linear-gradient(90deg, #FF0000 0%, rgba(0, 0, 255, 0.5) 100%)' });
  expect(css('linear-gradient(90deg, rgb(255, 0, 0) 2%, rgba(0, 0, 255, 0.5) 100%)')).toHaveLength(1);
  expect(css('radial-gradient(rgb(255, 0, 0) 0%, rgba(0, 0, 255, 0.5) 100%)')).toHaveLength(1);
  expect(css('linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 0) 50%, rgba(0, 0, 255, 0.5) 100%)')).toHaveLength(1);
});

test('borders are checked per side; a bottom-only divider passes', () => {
  const divider = withLayer('1:3', (l) => { l.strokes = [{ color: { hex: '#DDDDDD', alpha: 1 }, weight: 1, weights: [0, 0, 1, 0], align: 'INSIDE' }]; });
  expect(run({ '1:3': { 'border-bottom-width': '1px', 'border-bottom-color': 'rgb(221, 221, 221)' } }, { design: divider }).differences).toEqual([]);
  expect(run({ '1:3': { 'border-bottom-width': '1px' } }, { design: divider }).differences)
    .toEqual([{ layerId: '1:3', layerName: 'Button', property: 'border-bottom-color', design: '#DDDDDD', build: '#000000' }]);
  const outside = withLayer('1:3', (l) => { l.strokes = [{ color: { hex: '#FF0000', alpha: 1 }, weight: 1, weights: [1, 1, 1, 1], align: 'OUTSIDE' }]; });
  const r = run({ '1:3': { 'border-top-width': '1px' } }, { design: outside });
  expect(r.differences).toEqual([]);
  expect(r.checkByEye).toEqual([{ layerId: '1:3', layerName: 'Button', property: 'border', reason: expect.stringContaining('outside') }]);
});

test('borders: width and colour on every side, radius and shadow must match', () => {
  const bordered = withLayer('1:3', (l) => { l.strokes = [{ color: { hex: '#FF0000', alpha: 1 }, weight: 2, weights: [2, 2, 2, 2], align: 'INSIDE' }]; });
  const sides = (w: string, c: string) => Object.fromEntries(['top', 'right', 'bottom', 'left'].flatMap((s) =>
    [[`border-${s}-width`, w], [`border-${s}-color`, c]]));
  expect(run({ '1:3': sides('2px', 'rgb(255, 0, 0)') }, { design: bordered }).differences).toEqual([]);
  expect(run({ '1:3': { ...sides('2px', 'rgb(255, 0, 0)'), 'border-left-width': '1px' } }, { design: bordered }).differences)
    .toEqual([{ layerId: '1:3', layerName: 'Button', property: 'border-left-width', design: 2, build: 1 }]);
  expect(run({ '1:3': { 'border-top-width': '1px' } }).differences[0]).toMatchObject({ property: 'border-top-width', design: 0, build: 1 });
  expect(run({ '1:3': { 'border-top-left-radius': '6px' } }).differences)
    .toEqual([{ layerId: '1:3', layerName: 'Button', property: 'border-top-left-radius', design: 8, build: 6 }]);
  expect(run({ '1:3': { 'box-shadow': 'none' } }).differences[0])
    .toMatchObject({ property: 'box-shadow', design: 'rgba(0, 0, 0, 0.25) 0px 2px 4px 0px', build: 'none' });
});

test('with two elements for one layer, the visible one with a real box is used', () => {
  const hidden = { ...exact.find((m) => m.figmaId === '1:3')!, x: 0, visible: false };
  const empty = { ...exact.find((m) => m.figmaId === '1:3')!, x: 0, width: 0 };
  expect(run({}, { extra: [hidden, empty] }).differences).toEqual([]);
  // When none is visible, the first one is used.
  expect(run({ '1:3': { visible: false } }, { extra: [hidden] }).differences[0]).toMatchObject({ layerId: '1:3', property: 'x', build: 0 });
});

test('a web font that did not load is a difference', () => {
  expect(run({ '1:2': { fontLoaded: false } }).differences)
    .toEqual([{ layerId: '1:2', layerName: 'Title', property: 'font-not-loaded', design: 'Helvetica', build: 'fallback font' }]);
});

test('a line thinner than a whole pixel goes to checkByEye instead of failing forever', () => {
  const hairline = withLayer('1:3', (l) => { l.strokes = [{ color: { hex: '#DDDDDD', alpha: 1 }, weight: 0.5, weights: [0, 0, 0.5, 0], align: 'INSIDE' }]; });
  // Chromium draws the 0.5 px border as 1 px, or the agent draws it with a box-shadow and no border at all.
  for (const style of [{ 'border-bottom-width': '1px', 'border-bottom-color': 'rgb(221, 221, 221)' }, {}] as Record<string, string>[]) {
    const r = run({ '1:3': style }, { design: hairline });
    expect(r.differences).toEqual([]);
    expect(r.checkByEye).toContainEqual(expect.objectContaining({ layerId: '1:3', property: 'border', reason: expect.stringContaining('0.5 px') }));
  }
});

test('an inset box-shadow that draws a thin line is not an extra shadow', () => {
  const hairline = withLayer('1:3', (l) => { l.strokes = [{ color: { hex: '#DDDDDD', alpha: 1 }, weight: 0.5, weights: [0, 0, 0.5, 0], align: 'INSIDE' }]; });
  const shadow = 'rgba(0, 0, 0, 0.25) 0px 2px 4px 0px, rgb(221, 221, 221) 0px -0.5px 0px 0px inset';
  expect(run({ '1:3': { 'box-shadow': shadow } }, { design: hairline }).differences).toEqual([]);
  // A stray inset shadow in another colour is still a difference.
  const stray = 'rgba(0, 0, 0, 0.25) 0px 2px 4px 0px, rgb(255, 0, 0) 0px -0.5px 0px 0px inset';
  expect(run({ '1:3': { 'box-shadow': stray } }, { design: hairline }).differences.map((x) => x.property)).toEqual(['box-shadow']);
});

test('sharp shadows in the stroke colour are lines with a side and a place: inside, across or outside the edge', () => {
  const drop = 'rgba(0, 0, 0, 0.25) 0px 2px 4px 0px';   // the button's own shadow effect
  const GREY = 'rgb(221, 221, 221)';
  const stroked = (weights: [number, number, number, number], align: string) => withLayer('1:3', (l) => {
    l.strokes = [{ color: { hex: '#DDDDDD', alpha: 1 }, weight: Math.max(...weights), weights, align }];
  });
  const centred = stroked([1, 1, 1, 1], 'CENTER');
  // The skill's centred line: an inset and an outer shadow of half the weight each.
  const halves = run({ '1:3': { 'box-shadow': `${drop}, ${GREY} 0px 0px 0px 0.5px inset, ${GREY} 0px 0px 0px 0.5px` } }, { design: centred });
  expect(halves.differences).toEqual([]);
  expect(halves.checkByEye).toEqual([]);
  // Inside only is a quarter pixel off on every side.
  const inside = run({ '1:3': { 'box-shadow': `${drop}, ${GREY} 0px 0px 0px 0.5px inset` } }, { design: centred });
  expect(inside.differences).toEqual(['top', 'right', 'bottom', 'left'].map((side) => ({ layerId: '1:3', layerName: 'Button',
    property: `${side}-line`, design: '0.5 px inside + 0.5 px outside', build: '0.5 px inside' })));
  // One side outside: an outer shadow moved down draws the bottom line outside the box.
  expect(run({ '1:3': { 'box-shadow': `${drop}, ${GREY} 0px 1px 0px 0px` } }, { design: stroked([0, 0, 1, 0], 'OUTSIDE') }).differences).toEqual([]);
  // A line of the wrong weight, and a line on a side the design does not have.
  const hairline = stroked([0, 0, 0.5, 0], 'INSIDE');
  expect(run({ '1:3': { 'box-shadow': `${drop}, ${GREY} 0px -0.25px 0px 0px inset` } }, { design: hairline }).differences)
    .toEqual([{ layerId: '1:3', layerName: 'Button', property: 'bottom-line', design: '0.5 px inside', build: '0.25 px inside' }]);
  expect(run({ '1:3': { 'box-shadow': `${drop}, ${GREY} 0px 0.5px 0px 0px inset, ${GREY} 0px -0.5px 0px 0px inset` } }, { design: hairline }).differences)
    .toEqual([{ layerId: '1:3', layerName: 'Button', property: 'top-line', design: 'none', build: '0.5 px inside' }]);
  // A line drawn on a ::after layer above the children counts, and needs no check by eye.
  const onTop = run({ '1:3': {} }, { design: hairline, extra: [] });
  expect(onTop.checkByEye).toHaveLength(1);
  const measured = exact.map((m) => (m.figmaId === '1:3' ? { ...m, overlayShadows: [`${GREY} 0px -0.5px 0px 0px inset`] } : m));
  const drawnOnTop = diffSection(hairline, measured, covered, []);
  expect(drawnOnTop.differences).toEqual([]);
  expect(drawnOnTop.checkByEye).toEqual([]);
});

test('width and place differences that "fi" and "fl" explain are known limits, not differences', () => {
  const words = withLayer('1:2', (l) => { l.text!.characters = 'Fulfillment'; });
  // The title is 1.2 px wider in the browser, and pushes the next layer 1.2 px along.
  const r = run({ '1:2': { width: 301.2 }, '1:9': { x: 25.2 } }, { design: words });
  expect(r.differences).toEqual([]);
  expect(r.knownLimits.map((k) => [k.layerId, k.property, k.design, k.build])).toEqual([['1:2', 'width', 300, 301.2], ['1:9', 'x', 24, 25.2]]);
  expect(r.knownLimits[0].reason).toContain('"Fulfillment"');
  // Too big for one pair, a text with no such pair, or a text with another difference: still differences.
  expect(run({ '1:2': { width: 302.5 } }, { design: words }).differences.map((x) => x.property)).toEqual(['width']);
  expect(run({ '1:2': { width: 301.2 } }).differences.map((x) => x.property)).toEqual(['width']);
  const alsoBigger = run({ '1:2': { width: 301.2, 'font-size': '33px' } }, { design: words });
  expect(alsoBigger.differences.map((x) => x.property).sort()).toEqual(['font-size', 'width']);
  expect(alsoBigger.knownLimits).toEqual([]);
  // A layer before the text is not pushed by it.
  const second = withLayer('1:9', (l) => { l.text!.characters = 'Influencer'; });
  const before = run({ '1:9': { width: 301.2 }, '1:3': { x: 25.2 }, '1:2': { x: 25.2 } }, { design: second });
  expect(before.differences.map((x) => [x.layerId, x.property])).toEqual([['1:2', 'x']]);
  expect(before.knownLimits.map((k) => k.layerId)).toEqual(['1:9', '1:3']);
});

test('frame lines hidden under a child are differences; stroked frames with children are tested', () => {
  const framed = withLayer('1:1', (l) => { l.strokes = [{ color: { hex: '#DDDDDD', alpha: 1 }, weight: 0.5, weights: [0.5, 0, 0.5, 0], align: 'INSIDE' }]; });
  const centred = withLayer('1:1', (l) => { l.strokes = [{ color: { hex: '#DDDDDD', alpha: 1 }, weight: 2, weights: [2, 2, 2, 2], align: 'CENTER' }]; });
  const outside = withLayer('1:1', (l) => { l.strokes = [{ color: { hex: '#DDDDDD', alpha: 1 }, weight: 1, weights: [1, 1, 1, 1], align: 'OUTSIDE' }]; });
  const coveredHere = assetCoveredIds(framed.root, planAssets(framed.root));
  expect(lineTargets(framed, coveredHere)).toEqual([{ figmaId: '1:1', sides: [{ side: 'top', depth: 0.25 }, { side: 'bottom', depth: 0.25 }] }]);
  expect(lineTargets(centred, coveredHere)[0].sides).toEqual(['top', 'right', 'bottom', 'left'].map((side) => ({ side, depth: 0.5 })));
  expect(lineTargets(outside, coveredHere)).toEqual([]);
  expect(lineTargets(d, covered)).toEqual([]);   // no strokes on the hero

  const measured = exact.map((m) => ({ ...m, style: { ...m.style } }));
  const lines = [
    { figmaId: '1:1', side: 'top' as const, points: 40, hidden: 0, under: [] },
    { figmaId: '1:1', side: 'bottom' as const, points: 40, hidden: 8, under: ['[data-figma-id="1:5"]'] },
  ];
  const r = diffSection(framed, measured, coveredHere, [], lines);
  expect(r.differences).toEqual([{ layerId: '1:1', layerName: 'Hero', property: 'bottom-line-hidden',
    design: 'drawn above the children, as Figma draws it', build: 'hidden under [data-figma-id="1:5"] at 8 of 40 points' }]);
});

test('a text box that hugs its words matches Figma\'s rounded width', async () => {
  const { figmaHugWidth } = await import('../src/compare/diffNumbers');
  expect(figmaHugWidth(87.3, 0)).toBe(88);
  expect(figmaHugWidth(88.6, 0.6)).toBe(88);   // the spacing after the last letter is left out
  expect(figmaHugWidth(87, 0)).toBe(87);
  // 2 px letter spacing: the browser's box is 301.6 px, which includes 2 px after the last letter.
  // Figma leaves those out and rounds up: ceil(299.6) = 300, the design width.
  const spaced = (l: Layer) => { l.text!.runs = l.text!.runs.map((r) => ({ ...r, letterSpacingPx: 2 })); };
  const style = { width: 301.6, 'letter-spacing': '2px' };
  const hug = withLayer('1:2', (l) => { spaced(l); l.text!.autoResize = 'WIDTH_AND_HEIGHT'; });
  expect(run({ '1:2': style }, { design: hug }).differences).toEqual([]);
  // A fixed-width box gets no such allowance.
  const fixed = withLayer('1:2', spaced);
  expect(run({ '1:2': style }, { design: fixed }).differences.map((x) => x.property)).toEqual(['width']);
});

test('the shown words must match the design, ignoring extra spaces and line breaks', () => {
  const withText = (text: string) => diffSection(d, exact.map((m) => (m.figmaId === '1:2' ? { ...m, text } : m)), covered, []).differences;
  const heading = d.root.children.find((c) => c.id === '1:2')!.text!.characters;
  expect(withText(` ${heading.replace(/ /g, '\n  ')} `)).toEqual([]);
  expect(withText(`${heading}!`)).toEqual([{ layerId: '1:2', layerName: 'Title', property: 'text', design: heading, build: `${heading}!` }]);
});
