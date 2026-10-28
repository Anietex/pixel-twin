import type { Layer } from '../src/design/types';
import { layoutHints, overlappingPairs } from '../src/design/layoutHints';

function box(id: string, x: number, y: number, width: number, height: number, children: Layer[] = []): Layer {
  return {
    id, name: id, type: 'FRAME', x, y, width, height,
    layout: { mode: 'none', gap: 0, padding: [0, 0, 0, 0], mainAlign: 'start', crossAlign: 'start', wrap: false, sizingH: 'fixed', sizingV: 'fixed', absolute: false },
    fills: [], strokes: [], radius: [0, 0, 0, 0], effects: [], opacity: 1, blendMode: 'NORMAL', clips: false,
    text: null, children,
  };
}
function parent(children: Layer[], mode: 'row' | 'column' | 'none' = 'none'): Layer {
  const p = box('p', 0, 0, 1000, 1000, children);
  p.layout.mode = mode;
  return p;
}

test('side by side → row with gap', () =>
  expect(layoutHints(parent([box('a', 0, 0, 100, 50), box('b', 116, 0, 100, 50), box('c', 232, 0, 100, 50)])))
    .toEqual([{ parentId: 'p', kind: 'row', childIds: ['a', 'b', 'c'], gap: 16 }]));

test('stacked → column with gap', () =>
  expect(layoutHints(parent([box('a', 0, 0, 100, 50), box('b', 0, 74, 100, 50), box('c', 0, 148, 100, 50)])))
    .toEqual([{ parentId: 'p', kind: 'column', childIds: ['a', 'b', 'c'], gap: 24 }]));

test('gap is the median, rounded to 0.5 px', () =>
  expect(layoutHints(parent([box('a', 0, 0, 100, 50), box('b', 110.2, 0, 100, 50), box('c', 330, 0, 100, 50)])))
    .toEqual([{ parentId: 'p', kind: 'row', childIds: ['a', 'b', 'c'], gap: 65 }]));

test('2 × 3 cards → grid', () => {
  const cards = [
    box('a', 0, 0, 100, 80), box('b', 120, 0, 100, 80), box('c', 240, 0, 100, 80),
    box('d', 0, 110, 100, 80), box('e', 120, 110, 100, 80), box('f', 240, 110, 100, 80),
  ];
  expect(layoutHints(parent(cards))).toEqual([
    { parentId: 'p', kind: 'grid', childIds: ['a', 'b', 'c', 'd', 'e', 'f'], columns: 3, columnGap: 20, rowGap: 30 },
  ]);
});

test('badge on top of image → overlay, not part of the row', () =>
  expect(layoutHints(parent([box('text', 0, 0, 100, 100), box('image', 116, 0, 100, 100), box('badge', 180, 8, 30, 20)])))
    .toEqual([
      { parentId: 'p', kind: 'overlay', childIds: ['image', 'badge'] },
      { parentId: 'p', kind: 'row', childIds: ['text', 'image'], gap: 16 },
    ]));

test('header row above a body → column of bands plus a row', () =>
  expect(layoutHints(parent([box('logo', 0, 0, 100, 40), box('nav', 300, 0, 200, 40), box('body', 0, 60, 500, 400)])))
    .toEqual([
      { parentId: 'p', kind: 'column', childIds: ['logo', 'nav', 'body'], groups: [['logo', 'nav'], ['body']], gap: 20 },
      { parentId: 'p', kind: 'row', childIds: ['logo', 'nav'], gap: 200 },
    ]));

test('auto layout parents get no hints', () =>
  expect(layoutHints(parent([box('a', 0, 0, 100, 50), box('b', 116, 0, 100, 50)], 'row'))).toEqual([]));

test('auto layout parents still pass hints for their own children', () => {
  const inner = box('inner', 0, 0, 400, 100, [box('a', 0, 0, 100, 50), box('b', 120, 0, 100, 50)]);
  const root = parent([inner, box('other', 0, 200, 100, 50)], 'column');
  expect(layoutHints(root)).toEqual([{ parentId: 'inner', kind: 'row', childIds: ['a', 'b'], gap: 20 }]);
});

test('a parent with one child gets no hints', () =>
  expect(layoutHints(parent([box('a', 0, 0, 100, 50)]))).toEqual([]));

test('overlappingPairs finds only real overlaps', () => {
  const tree = parent([
    box('image', 0, 0, 100, 100), box('badge', 80, 80, 40, 40),
    box('touching', 100, 0, 50, 50), box('far', 300, 300, 10, 10),
  ]);
  expect(overlappingPairs(tree)).toEqual([['image', 'badge']]);
});

test('overlappingPairs finds overlaps at any depth, but not a layer with its own children', () => {
  const group = box('group', 0, 0, 100, 100, [box('inside', 10, 10, 20, 20)]);
  expect(overlappingPairs(parent([group, box('other', 5, 5, 50, 50)]))).toEqual([['group', 'other'], ['inside', 'other']]);
});

test('background rectangle + 3 cards in a row → background and row', () =>
  expect(layoutHints(parent([
    box('bg', 0, 0, 400, 150),
    box('a', 10, 10, 100, 50), box('b', 130, 10, 100, 50), box('c', 250, 10, 100, 50),
  ]))).toEqual([
    { parentId: 'p', kind: 'background', childIds: ['bg'] },
    { parentId: 'p', kind: 'row', childIds: ['a', 'b', 'c'], gap: 20 },
  ]));

test('background + 2 × 2 cards → background and grid', () =>
  expect(layoutHints(parent([
    box('bg', 0, 0, 400, 300),
    box('a', 10, 10, 100, 80), box('b', 130, 10, 100, 80),
    box('c', 10, 120, 100, 80), box('d', 130, 120, 100, 80),
  ]))).toEqual([
    { parentId: 'p', kind: 'background', childIds: ['bg'] },
    { parentId: 'p', kind: 'grid', childIds: ['a', 'b', 'c', 'd'], columns: 2, columnGap: 20, rowGap: 30 },
  ]));

test('nested overlays use the smallest containing sibling as host', () =>
  expect(layoutHints(parent([box('A', 0, 0, 300, 300), box('B', 50, 50, 100, 100), box('C', 60, 60, 20, 20)])))
    .toEqual([
      { parentId: 'p', kind: 'background', childIds: ['A'] },
      { parentId: 'p', kind: 'overlay', childIds: ['B', 'C'] },
    ]));

test('a band with partly overlapping siblings gets no row hint', () => {
  const hints = layoutHints(parent([
    box('top', 0, 0, 500, 40), box('a', 0, 100, 100, 50), box('b', 60, 110, 100, 50),
  ]));
  expect(hints.map((h) => h.kind)).toEqual(['column']);
});
