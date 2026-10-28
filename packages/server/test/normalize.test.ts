import { readFileSync } from 'node:fs';
import type { ResolvedVariable, TextDetail } from '@pixel-twin/shared';
import { toSectionData } from '../src/design/normalize.js';
import type { Layer } from '../src/design/types.js';

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
const { document: hero } = load<{ document: any }>('hero.rest.json');
const textDetails = load<TextDetail[]>('hero.text.json');
const variables = load<ResolvedVariable[]>('hero.vars.json');

function findLayer(root: Layer, id: string): Layer | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = findLayer(c, id);
    if (f) return f;
  }
  return undefined;
}

const s = toSectionData({ document: hero, textDetails, variables });
const byId = (id: string) => findLayer(s.root, id)!;

/** A small frame at (10, 20), 100 x 50, with the given extra fields and children. */
const frame = (extra: object = {}, children: object[] = []) => ({
  id: 'f:1', name: 'F', type: 'FRAME', visible: true,
  absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
  fills: [], strokes: [], effects: [], children, ...extra,
});
const one = (extra: object) => toSectionData({ document: frame(extra) as any, textDetails: [], variables: [] }).root;

test('section size', () => expect(s).toMatchObject({ rootId: '1:1', name: 'Hero', width: 600, height: 200 }));
test('positions are relative to the section', () =>
  expect(byId('1:2')).toMatchObject({ x: 24, y: 24, width: 300, height: 40 }));
test('children keep the REST order', () =>
  expect(s.root.children.map((c) => c.id)).toEqual(['1:2', '1:9', '1:3', '1:5', '1:6']));
test('text runs and line count', () => expect(byId('1:2').text).toMatchObject({
  runs: [{ fontFamily: 'Helvetica', fontWeight: 700, fontSize: 32, lineHeightPx: 40, letterSpacingPx: 0, color: { hex: '#111111', alpha: 1 } }],
  lineCount: 1 }));
test('auto layout, fill, radius and shadow', () => expect(byId('1:3')).toMatchObject({
  layout: { mode: 'row', gap: 8, padding: [12, 24, 12, 24], mainAlign: 'center', crossAlign: 'center' },
  fills: [{ type: 'solid', color: { hex: '#2255FF', alpha: 1 } }], radius: [8, 8, 8, 8],
  effects: [{ type: 'drop-shadow', x: 0, y: 2, blur: 4, spread: 0, color: { hex: '#000000', alpha: 0.25 } }] }));
test('hidden layers are left out', () => expect(findLayer(s.root, '1:8')).toBeUndefined());
test('mixed-style text: dominant run covers most characters', () => {
  const t = byId('1:9').text!;
  expect(t.runs).toHaveLength(3);                       // "Read the " / "full" / "\nstory"
  expect(t.runs.map((r) => [r.start, r.end, r.fontWeight])).toEqual([[0, 9, 400], [9, 13, 700], [13, 19, 400]]);
  expect(t.dominantRun).toBe(0);
  expect(t.runs[t.dominantRun].fontWeight).toBe(400);
  expect(t.lineCount).toBe(2);
});
test('fonts are listed once each', () => expect(s.fonts).toEqual([
  { family: 'Helvetica', style: 'Bold', weight: 700, missingInFigma: false },
  { family: 'Helvetica', style: 'Medium', weight: 500, missingInFigma: false },
  { family: 'Helvetica', style: 'Regular', weight: 400, missingInFigma: false }]));
test('variables are passed through', () => expect(s.variables).toEqual(variables));
test('a missing font in Figma is flagged', () => {
  const flagged = textDetails.map((d) => (d.id === '1:4' ? { ...d, hasMissingFont: true } : d));
  const m = toSectionData({ document: hero, textDetails: flagged, variables });
  expect(findLayer(m.root, '1:4')!.text!.hasMissingFont).toBe(true);
  expect(findLayer(m.root, '1:2')!.text!.hasMissingFont).toBe(false);
  expect(m.fonts.find((f) => f.style === 'Medium')!.missingInFigma).toBe(true);
  expect(m.fonts.find((f) => f.style === 'Bold')!.missingInFigma).toBe(false);
});
test('image fill, identity transform is not transformed', () => {
  expect(byId('1:5').fills).toEqual([{ type: 'image', imageRef: 'abc123', scaleMode: 'FILL', transformed: false }]);
  const img = (imageTransform?: number[][]) =>
    one({ fills: [{ type: 'IMAGE', scaleMode: 'STRETCH', imageRef: 'x', imageTransform }] }).fills[0];
  expect(img([[1, 0, 0], [0, 1, 0]])).toMatchObject({ transformed: false });
  expect(img([[0.5, 0, 0], [0, 1, 0]])).toMatchObject({ transformed: true });
});
test('layout defaults and mapping', () => {
  expect(s.root.layout).toEqual({ mode: 'none', gap: 0, padding: [0, 0, 0, 0], mainAlign: 'start', crossAlign: 'start',
    wrap: false, sizingH: 'fixed', sizingV: 'fixed', absolute: false });
  const l = one({ layoutMode: 'VERTICAL', primaryAxisAlignItems: 'SPACE_BETWEEN',
    counterAxisAlignItems: 'BASELINE', layoutWrap: 'WRAP', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
    layoutPositioning: 'ABSOLUTE' }).layout;
  expect(l).toMatchObject({ mode: 'column', mainAlign: 'space-between', crossAlign: 'baseline', wrap: true,
    sizingH: 'fill', sizingV: 'hug', absolute: true });
  expect(one({ layoutMode: 'GRID' }).layout.mode).toBe('none');
});
test('radius from per-corner values, opacity, blend mode, clipping', () => {
  const l = one({ rectangleCornerRadii: [1, 2, 3, 4], opacity: 0.5, blendMode: 'MULTIPLY', clipsContent: true });
  expect(l).toMatchObject({ radius: [1, 2, 3, 4], opacity: 0.5, blendMode: 'MULTIPLY', clips: true });
  expect(s.root).toMatchObject({ opacity: 1, blendMode: 'PASS_THROUGH', clips: true });
});
test('hidden paints and effects are dropped; alpha uses paint opacity', () => {
  const l = one({
    fills: [
      { type: 'SOLID', visible: false, color: { r: 1, g: 0, b: 0, a: 1 } },
      { type: 'SOLID', opacity: 0.5, color: { r: 1, g: 0, b: 0, a: 0.5 } }],
    effects: [{ type: 'LAYER_BLUR', visible: false, radius: 3 }, { type: 'LAYER_BLUR', visible: true, radius: 6 }],
    strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }], strokeWeight: 2, strokeAlign: 'CENTER' });
  expect(l.fills).toEqual([{ type: 'solid', color: { hex: '#FF0000', alpha: 0.25 } }]);
  expect(l.effects).toEqual([{ type: 'layer-blur', x: 0, y: 0, blur: 6, spread: 0, color: null }]);
  expect(l.strokes).toEqual([{ color: { hex: '#0000FF', alpha: 1 }, weight: 2, weights: [2, 2, 2, 2], align: 'CENTER' }]);
});
test('gradient angle is computed in pixel space', () => {
  const grad = (h: { x: number; y: number }[]) => one({ fills: [{
    type: 'GRADIENT_LINEAR', opacity: 0.5, gradientHandlePositions: h,
    gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] }] }).fills[0];
  // Box is 100 x 50. A diagonal top-left to bottom-right is atan2(100, -50) = 116.565 deg, not 135.
  const diag = grad([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]) as any;
  expect(diag.type).toBe('gradient');
  expect(diag.kind).toBe('linear');
  expect(diag.angleDeg).toBeCloseTo(116.565, 2);
  expect(diag.stops).toEqual([
    { position: 0, color: { hex: '#000000', alpha: 0.5 } }, { position: 1, color: { hex: '#FFFFFF', alpha: 0.5 } }]);
  expect((grad([{ x: 0.5, y: 1 }, { x: 0.5, y: 0 }, { x: 0, y: 1 }]) as any).angleDeg).toBeCloseTo(0, 5);
  expect((grad([{ x: 1, y: 0.5 }, { x: 0, y: 0.5 }, { x: 0, y: 1 }]) as any).angleDeg).toBeCloseTo(270, 5);
});
test('text run colour comes from the override fills when present', () => {
  const t = toSectionData({ textDetails: [], variables: [], document: frame({}, [{
    id: 't:1', name: 'T', type: 'TEXT', visible: true,
    absoluteBoundingBox: { x: 10, y: 20, width: 50, height: 20 },
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
    characters: 'ab', characterStyleOverrides: [0, 1],
    styleOverrideTable: { 1: { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] } },
    style: { fontFamily: 'Inter', fontStyle: 'Regular', fontWeight: 400, fontSize: 10, lineHeightPx: 20, letterSpacing: 1 },
  }]) as any }).root.children[0].text!;
  expect(t.runs.map((r) => r.color.hex)).toEqual(['#000000', '#FF0000']);
  expect(t.runs[0]).toMatchObject({ letterSpacingPx: 1, textCase: 'ORIGINAL', textDecoration: 'NONE' });
});

describe('warnings for things Pixel Twin cannot check', () => {
  const warnOf = (extra: object, children: object[] = []) =>
    toSectionData({ document: frame(extra, children) as any, textDetails: [], variables: [] }).warnings;
  const solid = { type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } };
  const grad = { type: 'GRADIENT_LINEAR', gradientHandlePositions: [], gradientStops: [] };
  const text = (extra: object) => ({
    id: 't:1', name: 'T', type: 'TEXT', visible: true, characters: 'a', characterStyleOverrides: [], styleOverrideTable: {},
    absoluteBoundingBox: { x: 10, y: 20, width: 50, height: 20 }, fills: [solid],
    style: { fontFamily: 'Inter', fontStyle: 'Regular', fontWeight: 400, fontSize: 10, lineHeightPx: 20 }, ...extra });

  test('the hero fixture has no warnings', () => expect(s.warnings).toEqual([]));
  test('1: non-solid stroke', () => {
    expect(warnOf({ strokes: [grad] })).toEqual([{ layerId: 'f:1', layerName: 'F', reason: expect.stringContaining('Border uses a gradient or image') }]);
    expect(warnOf({ strokes: [{ ...grad, visible: false }] })).toEqual([]);
  });
  test('2: texture and noise effects', () => {
    expect(warnOf({ effects: [{ type: 'NOISE', visible: true }] })[0].reason).toMatch(/texture\/noise/);
    expect(warnOf({ effects: [{ type: 'TEXTURE', visible: true }] })[0].reason).toMatch(/texture\/noise/);
    expect(warnOf({ effects: [{ type: 'NOISE', visible: false }] })).toEqual([]);
  });
  test('3: progressive blur is kept as a blur and warned', () => {
    const d = toSectionData({ document: frame({ effects: [{ type: 'LAYER_BLUR', visible: true, radius: 5, blurType: 'PROGRESSIVE' }] }) as any, textDetails: [], variables: [] });
    expect(d.root.effects).toHaveLength(1);
    expect(d.warnings[0].reason).toMatch(/progressive blur/);
    expect(warnOf({ effects: [{ type: 'LAYER_BLUR', visible: true, radius: 5, blurType: 'NORMAL' }] })).toEqual([]);
  });
  test('4: text without a visible solid fill', () => {
    expect(warnOf({}, [text({ fills: [grad] })])).toEqual([{ layerId: 't:1', layerName: 'T', reason: expect.stringContaining('Text colour') }]);
    expect(warnOf({}, [text({ fills: [{ ...solid, visible: false }] })])).toHaveLength(1);
    expect(warnOf({}, [text({})])).toEqual([]);
  });
  test('5: pattern fill', () => {
    expect(warnOf({ fills: [{ type: 'PATTERN' }] })[0].reason).toMatch(/pattern/);
    expect(warnOf({ fills: [{ type: 'PATTERN', visible: false }] })).toEqual([]);
  });
  test('6: rotated layer', () => {
    expect(warnOf({ rotation: 0.5 })[0].reason).toBe('Layer is rotated; its box is the rotated outline');
    expect(warnOf({ rotation: 0 })).toEqual([]);
  });
  test('7: rotated or filtered image', () => {
    const img = (extra: object) => ({ type: 'IMAGE', scaleMode: 'FILL', imageRef: 'x', ...extra });
    const r = toSectionData({ document: frame({ fills: [img({ rotation: 90 })] }) as any, textDetails: [], variables: [] });
    expect(r.root.fills[0]).toMatchObject({ transformed: true });
    expect(r.warnings[0].reason).toMatch(/Image is rotated\/filtered/);
    expect(warnOf({ fills: [img({ filters: { exposure: 0.2 } })] })[0].reason).toMatch(/Image is rotated\/filtered/);
    expect(warnOf({ fills: [img({})] })).toEqual([]);
  });
  test('8: a different stroke weight on each side is kept per side, not warned', () => {
    const stroke = { strokes: [solid], strokeWeight: 1 };
    expect(warnOf({ ...stroke, individualStrokeWeights: { top: 1, right: 2, bottom: 1, left: 1 } })).toEqual([]);
    expect(one({ ...stroke, individualStrokeWeights: { top: 0, right: 0, bottom: 1, left: 0 } }).strokes[0].weights).toEqual([0, 0, 1, 0]);
    expect(one({ ...stroke, strokeTopWeight: 3, strokeBottomWeight: 0 }).strokes[0].weights).toEqual([3, 1, 0, 1]);
    expect(one(stroke).strokes[0].weights).toEqual([1, 1, 1, 1]);
  });
  test('10: diamond gradient', () => {
    const diamond = { type: 'GRADIENT_DIAMOND', gradientHandlePositions: [], gradientStops: [] };
    expect(warnOf({ fills: [diamond] })[0].reason).toBe('Has a diamond gradient, which browsers can\'t draw exactly');
    expect(warnOf({ fills: [{ ...diamond, type: 'GRADIENT_RADIAL' }] })).toEqual([]);
  });
  test('9: no absoluteBoundingBox', () => {
    expect(warnOf({}, [{ id: 'n:1', name: 'N', type: 'GROUP', visible: true, children: [] }])[0])
      .toMatchObject({ layerId: 'n:1', reason: expect.stringContaining('no position or size') });
  });
  test('hidden layers do not warn', () =>
    expect(warnOf({}, [{ id: 'h:1', name: 'H', type: 'GROUP', visible: false, rotation: 1, children: [] }])).toEqual([]));
});

test('fonts used only by hidden text layers are not listed', () => {
  const doc = JSON.parse(JSON.stringify(hero));
  doc.children.push({
    id: '1:20', name: 'Old heading', type: 'TEXT', visible: false, characters: 'Old',
    absoluteBoundingBox: { x: 100, y: 50, width: 10, height: 10 },
    style: { fontFamily: 'Editorial New', fontWeight: 400, fontSize: 40, lineHeightPx: 48, letterSpacing: 0 }, fills: [],
  });
  const details = [...textDetails, { id: '1:20', hasMissingFont: true, fonts: [{ family: 'Editorial New', style: 'Regular', weight: 400 }] }];
  const r = toSectionData({ document: doc, textDetails: details, variables });
  expect(r.fonts.map((f) => f.family)).not.toContain('Editorial New');
});

describe('image placement', () => {
  const withPaint = (paint: object) => {
    const doc = JSON.parse(JSON.stringify(hero));
    doc.children.find((c: any) => c.id === '1:5').fills = [paint];
    return findLayer(toSectionData({ document: doc, textDetails, variables }).root, '1:5')!.fills[0];
  };

  test('a cropped image gives its crop and the CSS that shows the same part', () => {
    // Shows the middle half of the image across, and the bottom 60 % down.
    const f = withPaint({ type: 'IMAGE', scaleMode: 'STRETCH', imageRef: 'abc', blendMode: 'NORMAL',
      imageTransform: [[0.5, 0, 0.25], [0, 0.6, 0.4]] });
    expect(f).toMatchObject({ type: 'image', transformed: true,
      crop: { x: 0.25, y: 0.4, width: 0.5, height: 0.6 },
      css: { backgroundSize: '200% 166.667%', backgroundPosition: '50% 100%' } });
  });

  test('filter values and rotation are kept', () => {
    const f = withPaint({ type: 'IMAGE', scaleMode: 'FILL', imageRef: 'abc', blendMode: 'NORMAL', rotation: 90,
      filters: { exposure: 0.3, saturation: -0.5, contrast: 0 } });
    expect(f).toMatchObject({ rotation: 90, filters: { exposure: 0.3, saturation: -0.5 }, transformed: true });
    expect((f as any).filters).not.toHaveProperty('contrast');
  });
});

test('text keeps how its box resizes', () => {
  const doc = JSON.parse(JSON.stringify(hero));
  doc.children.find((c: any) => c.id === '1:2').style.textAutoResize = 'WIDTH_AND_HEIGHT';
  expect(findLayer(toSectionData({ document: doc, textDetails, variables }).root, '1:2')!.text!.autoResize).toBe('WIDTH_AND_HEIGHT');
});
