import { applyMotion, describeInteraction, easingCss, springCurve } from '../src/design/motion';
import { motionHints } from '../src/design/motionHints';
import { toSectionData, type RestNode } from '../src/design/normalize';
import type { Layer } from '../src/design/types';

function box(id: string, x: number, y: number, width: number, height: number, children: Layer[] = [], over: Partial<Layer> = {}): Layer {
  return {
    id, name: id, type: 'FRAME', x, y, width, height,
    layout: { mode: 'none', gap: 0, padding: [0, 0, 0, 0], mainAlign: 'start', crossAlign: 'start', wrap: false, sizingH: 'fixed', sizingV: 'fixed', absolute: false },
    fills: [], strokes: [], radius: [0, 0, 0, 0], effects: [], opacity: 1, blendMode: 'NORMAL', clips: false,
    text: null, children, ...over,
  };
}
const label = (id: string, x: number, y: number, characters: string, color = '#555555'): Layer => box(id, x, y, 150, 24, [], {
  type: 'TEXT', text: { characters, dominantRun: 0, align: 'LEFT', autoResize: 'WIDTH_AND_HEIGHT', lineCount: 1, hasMissingFont: false,
    runs: [{ start: 0, end: characters.length, fontFamily: 'Inter', fontStyle: 'Regular', fontWeight: 400, fontSize: 16, lineHeightPx: 24,
      letterSpacingPx: 0, textCase: 'ORIGINAL', textDecoration: 'NONE', color: { hex: color, alpha: 1 } }] },
});

test('Figma easings become CSS timing functions', () => {
  expect(easingCss({ type: 'LINEAR' })).toBe('linear');
  expect(easingCss({ type: 'EASE_OUT' })).toBe('cubic-bezier(0, 0, 0.58, 1)');
  expect(easingCss({ type: 'CUSTOM_CUBIC_BEZIER', bezier: [0.2, 0, 0, 1] })).toBe('cubic-bezier(0.2, 0, 0, 1)');
  expect(easingCss({ type: 'GENTLE' })).toMatch(/^linear\(0, /);
  expect(easingCss({ type: 'CUSTOM_SPRING', spring: { bounce: 0.3 } })).toBeNull();
});

test('a spring becomes a linear() curve that ends at 1, and a stiffer spring settles sooner', () => {
  const gentle = springCurve({ mass: 1, stiffness: 100, damping: 15 });
  const quick = springCurve({ mass: 1, stiffness: 300, damping: 20 });
  const points = gentle.css.slice('linear('.length, -1).split(', ').map(Number);
  expect(points).toHaveLength(41);
  expect(points[0]).toBe(0);
  expect(points.at(-1)).toBe(1);
  expect(Math.max(...points)).toBeGreaterThan(1);   // a gentle spring overshoots a little
  expect(quick.settleMs).toBeLessThan(gentle.settleMs);
});

test('interactions read as plain words', () => {
  expect(describeInteraction({ trigger: 'AFTER_TIMEOUT', delayMs: 800, action: 'NAVIGATE', destinationId: '2:1', destinationName: 'Next',
    transition: { type: 'SLIDE_IN', direction: 'LEFT', durationMs: 300, easing: { type: 'EASE_IN_AND_OUT' } } }))
    .toBe('after 800 ms → go to "Next" (2:1), slide in from left 300 ms, ease-in-and-out = cubic-bezier(0.42, 0, 0.58, 1)');
  expect(describeInteraction({ trigger: 'ON_CLICK', action: 'URL', url: 'https://example.com' })).toBe('on click → open link "https://example.com"');
});

test('the export gives fixed, sticky, inner scrolling and GIF fills; the plugin adds the rest', () => {
  const doc = { id: '1:1', name: 'Page', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 }, children: [
    { id: '1:2', name: 'Bar', type: 'FRAME', scrollBehavior: 'STICKY_SCROLLS', absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 60 } },
    { id: '1:3', name: 'Chat', type: 'FRAME', scrollBehavior: 'FIXED', absoluteBoundingBox: { x: 700, y: 500, width: 60, height: 60 } },
    { id: '1:4', name: 'List', type: 'FRAME', overflowDirection: 'VERTICAL_SCROLLING', absoluteBoundingBox: { x: 0, y: 100, width: 300, height: 200 } },
    { id: '1:5', name: 'Loop', type: 'RECTANGLE', fills: [{ type: 'IMAGE', imageRef: 'i1', gifRef: 'g1', scaleMode: 'FILL' }],
      absoluteBoundingBox: { x: 400, y: 100, width: 200, height: 200 } },
  ] };
  const section = toSectionData({ document: doc as unknown as RestNode, textDetails: [], variables: [] });
  const [bar, chat, list, loop] = section.root.children;
  expect(bar.motion).toEqual({ scroll: 'sticky' });
  expect(chat.motion).toEqual({ scroll: 'fixed' });
  expect(list.motion).toEqual({ overflow: 'VERTICAL' });
  expect(loop.motion).toEqual({ media: [{ kind: 'gif', ref: 'g1' }] });
  applyMotion(section.root, [{ id: '1:2', fixed: true }, { id: '1:5', media: [{ kind: 'video', hash: 'v1' }] }]);
  expect(bar.motion).toEqual({ scroll: 'sticky' });   // sticky from the export wins over the plugin's fixed
  expect(loop.motion!.media).toEqual([{ kind: 'gif', ref: 'g1' }, { kind: 'video', ref: 'v1' }]);
});

test('a row of logos cut off at both ends of a clipping strip is a marquee', () => {
  const logos = [-60, 100, 260, 420, 580].map((x, i) => box(`logo${i}`, x, 10, 120, 40));
  const strip = box('strip', 0, 0, 600, 60, [box('track', -60, 10, 760, 40, logos)], { name: 'Logos', clips: true });
  expect(motionHints(box('root', 0, 0, 600, 400, [strip]))).toEqual([{ kind: 'marquee', layerId: 'track', layerName: 'track',
    confidence: 'high', reason: 'A row of 5 items cut off at both ends by "Logos": it usually scrolls on its own (a marquee)' }]);
});

test('same-size cards running past one edge are a carousel', () => {
  const cards = [0, 320, 640].map((x, i) => box(`card${i}`, x, 0, 300, 200));
  const hints = motionHints(box('root', 0, 0, 800, 400, [box('row', 0, 100, 940, 200, cards)], { clips: true }));
  expect(hints).toMatchObject([{ kind: 'carousel', layerId: 'row', confidence: 'medium' }]);
});

test('a list with one item that looks selected, next to a picture named like it, is tabs', () => {
  const list = box('list', 0, 0, 200, 120, [label('a', 0, 0, 'Employee Swag', '#111111'), label('b', 0, 40, 'Client Gifts'), label('c', 0, 80, 'Events')]);
  const photo = box('photo', 300, 0, 400, 300, [], { name: 'Employee Swag image', fills: [{ type: 'image', imageRef: 'x', scaleMode: 'FILL', transformed: false }] });
  expect(motionHints(box('root', 0, 0, 800, 400, [list, photo]))).toMatchObject([{ kind: 'tabs', layerId: 'list', confidence: 'medium',
    reason: expect.stringContaining('"Employee Swag image"') }]);
  expect(motionHints(box('root', 0, 0, 800, 400, [list]))).toMatchObject([{ kind: 'tabs', confidence: 'low' }]);
});

test('layers named like a moving pattern are hinted, and plain rows are not', () => {
  const named = box('acc', 0, 0, 400, 300, [], { name: 'FAQ Accordion' });
  const row = box('row', 0, 320, 400, 40, [label('x', 0, 0, 'One'), label('y', 160, 0, 'Two'), label('z', 320, 0, 'Three')]);
  expect(motionHints(box('root', 0, 0, 800, 400, [named, row]))).toEqual([{ kind: 'named', layerId: 'acc', layerName: 'FAQ Accordion',
    confidence: 'high', reason: 'Named "FAQ Accordion": the designer marked it as a moving pattern (accordion)' }]);
});
