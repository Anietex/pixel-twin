import type { MeasuredElement } from '../src/browser/measure';
import type { Region } from '../src/compare/overlay';
import { designLineBoxes, layersInArea } from '../src/compare/runCompare';
import type { Layer } from '../src/design/types';

const el = (figmaId: string, x: number, y: number, width: number, height: number): MeasuredElement =>
  ({ figmaId, tag: 'div', x, y, width, height, style: {}, lineCount: null, visible: true, fontLoaded: true });
const area = (x: number, y: number, width: number, height: number, kind: Region['kind'] = 'different'): Region =>
  ({ x, y, width, height, pixels: 1, kind, label: '', similarity: 0 });
const names = new Map([['1:1', 'Card'], ['1:2', 'Photo'], ['1:3', 'Title'], ['1:4', 'Strip']]);
const elements = [el('1:1', 0, 0, 400, 200), el('1:2', 0, 0, 200, 200), el('1:3', 220, 20, 160, 40), el('1:4', 0, 199, 400, 1)];

test('a changed area names the most specific layers it touches, the biggest overlap first', () => {
  expect(layersInArea(area(10, 10, 300, 40), elements, names, '1:1'))
    .toEqual([{ layerId: '1:2', layerName: 'Photo' }, { layerId: '1:3', layerName: 'Title' }]);
  // A layer id the design does not have keeps an empty name.
  expect(layersInArea(area(500, 0, 10, 10), [el('9:9', 495, 0, 20, 20)], names, '1:1')).toEqual([{ layerId: '9:9', layerName: '' }]);
  expect(layersInArea(area(500, 0, 10, 10), elements, names, '1:1')).toEqual([]);
  // An area over a whole button names the button and the label inside it; inside the label, only the label.
  const button = [el('1:1', 0, 0, 400, 200), el('2:1', 20, 100, 160, 48), el('2:2', 44, 112, 112, 24)];
  expect(layersInArea(area(19, 99, 164, 50), button, names, '1:1').map((l) => l.layerId)).toEqual(['2:1', '2:2']);
  expect(layersInArea(area(50, 115, 20, 10), button, names, '1:1').map((l) => l.layerId)).toEqual(['2:2']);
  // Only the section itself: it is named.
  expect(layersInArea(area(300, 10, 20, 20), button, names, '1:1').map((l) => l.layerId)).toEqual(['1:1']);
});

test('a line area names the elements with an edge along it first', () => {
  expect(layersInArea(area(0, 0, 200, 1, 'line-missing'), elements, names, '1:1').map((l) => l.layerId)).toEqual(['1:2', '1:1']);
  expect(layersInArea(area(0, 199, 400, 1, 'line-missing'), elements, names, '1:1').map((l) => l.layerId)).toEqual(['1:4', '1:2', '1:1']);
});

test('the design draws lines along each stroked side and along thin layers', () => {
  const layer = (over: Partial<Layer>): Layer => ({
    id: '1:1', name: 'L', type: 'FRAME', x: 10, y: 20, width: 100, height: 50,
    layout: { mode: 'none', gap: 0, padding: [0, 0, 0, 0], mainAlign: 'MIN', crossAlign: 'MIN', wrap: false, sizingH: 'FIXED', sizingV: 'FIXED', absolute: false },
    fills: [], strokes: [], radius: [0, 0, 0, 0], effects: [], opacity: 1, blendMode: 'NORMAL', clips: false, text: null, children: [], ...over,
  });
  const stroke = (weights: [number, number, number, number], align: string) => [{ color: { hex: '#000000', alpha: 1 }, weight: Math.max(...weights), weights, align }];
  expect(designLineBoxes(layer({ strokes: stroke([1, 0, 2, 0], 'INSIDE') }), new Set()))
    .toEqual([{ x: 10, y: 20, width: 100, height: 1 }, { x: 10, y: 68, width: 100, height: 2 }]);
  expect(designLineBoxes(layer({ strokes: stroke([0, 0, 0, 1], 'CENTER') }), new Set())).toEqual([{ x: 9.5, y: 20, width: 1, height: 50 }]);
  expect(designLineBoxes(layer({ strokes: stroke([0, 1, 0, 0], 'OUTSIDE') }), new Set())).toEqual([{ x: 110, y: 20, width: 1, height: 50 }]);
  // A line layer: no height, a stroke across it.
  expect(designLineBoxes(layer({ type: 'LINE', height: 0, strokes: stroke([1, 1, 1, 1], 'CENTER') }), new Set()))
    .toEqual([{ x: 10, y: 19.5, width: 100, height: 1 }]);
  // Layers drawn inside an exported picture are left out.
  expect(designLineBoxes(layer({ strokes: stroke([1, 1, 1, 1], 'INSIDE') }), new Set(['1:1']))).toEqual([]);
});
