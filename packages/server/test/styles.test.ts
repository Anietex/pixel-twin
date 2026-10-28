import { readFileSync } from 'node:fs';
import path from 'node:path';
import { collectStyles } from '../src/design/styles';

const hero = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/hero.rest.json'), 'utf8'));

test('lists linked styles of visible layers with their names', () => {
  expect(collectStyles(hero.document, hero.styles)).toEqual([{ layerId: '1:3', kind: 'fill', name: 'Brand/Primary' }]);
});

test('uses the style id when the name is missing', () => {
  expect(collectStyles(hero.document, undefined)).toEqual([{ layerId: '1:3', kind: 'fill', name: 'S:brand' }]);
  expect(collectStyles(hero.document, {})).toEqual([{ layerId: '1:3', kind: 'fill', name: 'S:brand' }]);
});

test('skips children of hidden layers', () => {
  const doc = { id: 'a', visible: true, children: [{ id: 'b', visible: false, children: [{ id: 'c', styles: { text: 'S:x' } }] }] };
  expect(collectStyles(doc, {})).toEqual([]);
});
