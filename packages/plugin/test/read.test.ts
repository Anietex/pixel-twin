import { beforeEach, expect, test } from 'vitest';
import { makeFakeFigma, type FakeTree } from './fakeFigma';
import { handleRequest } from '../src/router';
import { getOutline } from '../src/read/outline';
import { getNodeJson } from '../src/read/nodeJson';
import { getTextDetails } from '../src/read/text';
import { listSections } from '../src/read/sections';
import { exportNode } from '../src/read/export';
import { getImageBytes } from '../src/read/images';
import { resolveVariables } from '../src/read/variables';

const tree: FakeTree = {
  loadedPages: ['0:1', '0:3'],
  pages: [
    { id: '0:1', name: 'Home', type: 'PAGE', children: [
      { id: '1:1', name: 'Landing', type: 'FRAME', x: 0, y: 0, width: 1440, height: 900, children: [
        { id: '1:2', name: 'Title', type: 'TEXT', characters: 'Hello', hasMissingFont: false,
          segments: [{ fontName: { family: 'Helvetica', style: 'Bold' }, fontWeight: 700 }] },
        { id: '1:3', name: 'Hero', type: 'FRAME', width: 1440, height: 400, children: [
          { id: '1:4', name: 'Sub', type: 'TEXT', characters: 'World', hasMissingFont: true,
            segments: [{ fontName: { family: 'Inter', style: 'Regular' }, fontWeight: 400 }] },
        ] },
        { id: '1:5', name: 'Box', type: 'RECTANGLE', width: 10, height: 10,
          boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'V:1' }] } },
      ] },
    ] },
    { id: '0:3', name: 'Sections', type: 'PAGE', children: [
      { id: '7:1', name: 'Wrapper', type: 'SECTION', width: 1000, children: [
        { id: '7:2', name: 'Card', type: 'INSTANCE', children: [
          { id: '7:3', name: 'T', type: 'TEXT', characters: 'In instance' } ] },
        { id: '7:4', name: 'Line', type: 'RECTANGLE' },
      ] },
    ] },
    { id: '0:2', name: 'Blog', type: 'PAGE', children: [
      { id: '5:1', name: 'Post', type: 'FRAME', width: 800, height: 600, children: [
        { id: '5:2', name: 'A', type: 'FRAME', children: [] },
        { id: '5:3', name: 'B', type: 'FRAME', children: [] },
      ] },
    ] },
  ],
  variables: [{ id: 'V:1', name: 'color/primary', collectionId: 'C:1', value: { r: 0.13, g: 0.33, b: 1, a: 1 } }],
  collections: [{ id: 'C:1', name: 'Tokens' }],
  images: { abc: [9, 8, 7] },
};

let api: PluginAPI;
let exportCalls: unknown[];
let loadCalls: string[];
beforeEach(() => ({ api, exportCalls, loadCalls } = makeFakeFigma(tree)));

test('outline without node lists pages', async () => {
  expect(await getOutline(api, { nodeId: null, depth: 1 })).toEqual([
    expect.objectContaining({ id: '0:1', name: 'Home', type: 'PAGE' }), expect.objectContaining({ name: 'Sections' }), expect.objectContaining({ name: 'Blog' })]);
});
test('outline loads an unloaded page before reading', async () => {
  const out = await getOutline(api, { nodeId: '5:1', depth: 1 });
  expect(out[0].children?.length).toBe(2);
  expect(loadCalls).toEqual(['0:2']);
});
test('outline depth 1 has no grandchildren, depth 2 does', async () => {
  const one = await getOutline(api, { nodeId: '1:1', depth: 1 });
  expect(one[0].childCount).toBe(3);
  expect(one[0].children?.[1].children).toBeUndefined();
  const two = await getOutline(api, { nodeId: '1:1', depth: 2 });
  expect(two[0].children?.[1].children?.[0].id).toBe('1:4');
});
test('outline accepts a page id', async () => {
  const out = await getOutline(api, { nodeId: '0:2', depth: 1 });
  expect(out[0].children?.[0].id).toBe('5:1');
});
test('missing layer gives a plain error', async () => {
  await expect(getOutline(api, { nodeId: '9:9', depth: 1 })).rejects.toThrow('Layer 9:9 not found in this file');
});
test('missing params give plain errors, not TypeErrors', async () => {
  await expect(getNodeJson(api, {} as any)).rejects.toThrow('Missing layer id in the request.');
  await expect(listSections(api, {} as any)).rejects.toThrow('Missing page id in the request.');
  await expect(getImageBytes(api, {} as any)).rejects.toThrow('Missing image hash in the request.');
});
test('node json uses the REST export', async () => {
  const res = await getNodeJson(api, { nodeId: '1:1' });
  expect(exportCalls.at(-1)).toEqual({ format: 'JSON_REST_V1' });
  expect(res).toEqual({ document: { id: '1:1', name: 'Landing' } });
});
test('text details report missing fonts and fonts used', async () => {
  const out = await getTextDetails(api, { nodeId: '1:1' });
  expect(out).toEqual([
    { id: '1:2', hasMissingFont: false, fonts: [{ family: 'Helvetica', style: 'Bold', weight: 700 }] },
    { id: '1:4', hasMissingFont: true, fonts: [{ family: 'Inter', style: 'Regular', weight: 400 }] },
  ]);
});
test('text details work on a single text layer', async () => {
  expect(await getTextDetails(api, { nodeId: '1:2' })).toHaveLength(1);
});
test('listSections returns frames, widths and texts', async () => {
  expect(await listSections(api, { pageId: '0:1' })).toEqual([
    { frameId: '1:1', frameName: 'Landing', frameWidth: 1440,
      sections: [{ id: '1:3', name: 'Hero', texts: ['World'] }] },
  ]);
});
test('listSections accepts a SECTION container and an INSTANCE section', async () => {
  expect(await listSections(api, { pageId: '0:3' })).toEqual([
    { frameId: '7:1', frameName: 'Wrapper', frameWidth: 1000,
      sections: [{ id: '7:2', name: 'Card', texts: ['In instance'] }] },
  ]);
});
test('exportNode PNG returns base64, SVG returns a string', async () => {
  expect(await exportNode(api, { nodeId: '1:1', format: 'PNG', scale: 2 })).toEqual({ base64: 'AQID' });
  expect(exportCalls.at(-1)).toEqual({ format: 'PNG', constraint: { type: 'SCALE', value: 2 }, useAbsoluteBounds: true });
  expect(await exportNode(api, { nodeId: '1:1', format: 'SVG', scale: 1 })).toEqual({ svg: '<svg id="1:1"/>' });
  expect(exportCalls.at(-1)).toEqual({ format: 'SVG_STRING' });
});
test('exportNode rejects a bad scale', async () => {
  await expect(exportNode(api, { nodeId: '1:1', format: 'PNG', scale: 0 })).rejects.toThrow('The export scale must be a number above 0.');
});
test('image bytes come back as base64', async () => {
  expect(await getImageBytes(api, { imageHash: 'abc' })).toEqual({ base64: 'CQgH' });
});
test('missing image hash gives a plain error', async () => {
  await expect(getImageBytes(api, { imageHash: 'nope' })).rejects.toThrow('Image nope not found');
});
test('variables resolve to name, collection and value', async () => {
  expect(await resolveVariables(api, { nodeId: '1:1' })).toEqual([
    { nodeId: '1:5', property: 'fills[0]', variableName: 'color/primary', collectionName: 'Tokens',
      value: { r: 0.13, g: 0.33, b: 1, a: 1 } },
  ]);
});
test('the fake is frozen, so any write throws', () => {
  expect(() => { (api.root as any).name = 'x'; }).toThrow();
});
test('the fake is frozen all the way down', async () => {
  const frame: any = await api.getNodeByIdAsync('1:1');
  const text: any = await api.getNodeByIdAsync('1:2');
  expect(() => { frame.name = 'x'; }).toThrow();
  expect(() => { text.characters = 'x'; }).toThrow();
  expect(() => { frame.children.push(text); }).toThrow();
  expect(() => { (api.root.children as any).length = 0; }).toThrow();
});

test('router: hasNode finds the page of an existing layer', async () => {
  expect(await handleRequest(api, 'hasNode', { nodeId: '5:2' })).toEqual({ exists: true, pageId: '0:2' });
});
test('router: hasNode reports a missing layer', async () => {
  expect(await handleRequest(api, 'hasNode', { nodeId: '9:9' })).toEqual({ exists: false, pageId: null });
});
test('router: unknown method gives a plain error', async () => {
  await expect(handleRequest(api, 'nope', {})).rejects.toThrow('Unknown request: nope');
});
test('router: routes every read method', async () => {
  expect(await handleRequest(api, 'getImageBytes', { imageHash: 'abc' })).toEqual({ base64: 'CQgH' });
  expect((await handleRequest(api, 'getOutline', { nodeId: null, depth: 1 }) as unknown[]).length).toBe(3);
});

test('layer extras give rotation, size before rotating, and style names (incl. mixed text styles)', async () => {
  const { getLayerExtras } = await import('../src/read/extras');
  const { api: a } = makeFakeFigma({
    loadedPages: ['0:1'],
    styles: [{ id: 'S:fill', name: 'Brand/Primary' }, { id: 'S:h1', name: 'Heading 56' }, { id: 'S:body', name: 'Body 16' }],
    pages: [{ id: '0:1', name: 'Home', type: 'PAGE', children: [
      { id: '2:1', name: 'Card', type: 'FRAME', width: 300, height: 200, fillStyleId: 'S:fill', children: [
        { id: '2:2', name: 'Photo', type: 'RECTANGLE', width: 120, height: 80, rotation: -8 },
        { id: '2:3', name: 'Copy', type: 'TEXT', characters: 'Hi there', width: 100, height: 20, textStyleId: 'MIXED',
          segments: [
            { fontName: { family: 'Inter', style: 'Bold' }, fontWeight: 700, textStyleId: 'S:h1' },
            { fontName: { family: 'Inter', style: 'Regular' }, fontWeight: 400, textStyleId: 'S:body' },
          ] },
        { id: '2:4', name: 'Plain', type: 'RECTANGLE', width: 10, height: 10 },
      ] },
    ] }],
  });
  expect(await getLayerExtras(a, { nodeId: '2:1' })).toEqual([
    { id: '2:1', rotation: 0, width: 300, height: 200, styles: [{ kind: 'fill', id: 'S:fill', name: 'Brand/Primary' }] },
    { id: '2:2', rotation: -8, width: 120, height: 80, styles: [] },
    { id: '2:3', rotation: 0, width: 100, height: 20, styles: [
      { kind: 'text', id: 'S:h1', name: 'Heading 56' }, { kind: 'text', id: 'S:body', name: 'Body 16' }] },
  ]);
});

test('exportNode can export a JPG for shrunk photos', async () => {
  const r = await exportNode(api, { nodeId: '1:5', format: 'JPG', scale: 2 });
  expect(r.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  expect(exportCalls.at(-1)).toEqual({ format: 'JPG', constraint: { type: 'SCALE', value: 2 }, useAbsoluteBounds: true });
});

test('motion lists interactions, component states, scrolling, video, links and keyframes', async () => {
  const { getMotion } = await import('../src/read/motion');
  const hoverToFilled = { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: '5:2', navigation: 'CHANGE_TO',
    transition: { type: 'SMART_ANIMATE', duration: 0.3, easing: { type: 'EASE_OUT' } } }] };
  const { api: a } = makeFakeFigma({
    loadedPages: ['0:1'],
    pages: [{ id: '0:1', name: 'Home', type: 'PAGE', children: [
      { id: '5:0', name: 'Heart', type: 'COMPONENT_SET', children: [
        { id: '5:1', name: 'State=Default', type: 'COMPONENT', variantProperties: { State: 'Default' }, reactions: [hoverToFilled] },
        { id: '5:2', name: 'State=Filled', type: 'COMPONENT', variantProperties: { State: 'Filled' }, reactions: [] },
      ] },
      { id: '6:1', name: 'Page', type: 'FRAME', overflowDirection: 'NONE', numberOfFixedChildren: 1, reactions: [], children: [
        { id: '6:2', name: 'Logos', type: 'FRAME', overflowDirection: 'HORIZONTAL', reactions: [
          { trigger: { type: 'AFTER_TIMEOUT', timeout: 0.8 }, actions: [{ type: 'NODE', destinationId: '6:9', navigation: 'SCROLL_TO',
            transition: { type: 'MOVE_IN', direction: 'LEFT', duration: 0.6, matchLayers: false,
              easing: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 } } } }] }] },
        { id: '6:3', name: 'Save', type: 'INSTANCE', mainComponentId: '5:1', reactions: [hoverToFilled] },
        { id: '6:4', name: 'Clip', type: 'RECTANGLE', fills: [{ type: 'VIDEO', videoHash: 'v1', scaleMode: 'FILL' }] },
        { id: '6:5', name: 'Terms', type: 'TEXT', characters: 'Read the terms', linkSegments: [
          { start: 0, end: 9, characters: 'Read the ', hyperlink: null },
          { start: 9, end: 14, characters: 'terms', hyperlink: { type: 'URL', value: 'https://example.com/terms' } }] },
        { id: '6:6', name: 'Spinner', type: 'FRAME', animationStyles: [{ type: 'FIGMA', name: 'Spin', styleId: 's', id: 'a', duration: 1.2 }],
          animations: { ROTATION: { baseValue: { type: 'FLOAT', value: 0 }, timelineDuration: 1.2, tracks: [{ id: 't', keyframeOperation: 'SET',
            keyframes: [{ id: 'k1', timelinePosition: 0, value: { type: 'FLOAT', value: 0 }, easing: { type: 'LINEAR' } },
              { id: 'k2', timelinePosition: 1.2, value: { type: 'FLOAT', value: 360 }, easing: { type: 'EASE_IN_AND_OUT' } }] }] } } },
        { id: '6:7', name: 'Menu bar', type: 'FRAME' },
      ] },
      { id: '6:9', name: 'Target', type: 'FRAME' },
    ] }],
  });
  const byId = new Map((await getMotion(a, { nodeId: '6:1' })).map((m) => [m.id, m]));
  expect([...byId.keys()]).toEqual(['6:2', '6:3', '6:4', '6:5', '6:6', '6:7']);
  expect(byId.get('6:2')).toEqual({ id: '6:2', overflow: 'HORIZONTAL', interactions: [{ trigger: 'AFTER_TIMEOUT', delayMs: 800, action: 'SCROLL_TO',
    destinationId: '6:9', destinationName: 'Target',
    transition: { type: 'MOVE_IN', direction: 'LEFT', durationMs: 600, easing: { type: 'CUSTOM_CUBIC_BEZIER', bezier: [0.2, 0, 0, 1] } } }] });
  expect(byId.get('6:3')!.states).toEqual({ setId: '5:0', setName: 'Heart', current: { State: 'Default' }, variants: [
    { id: '5:1', name: 'State=Default', properties: { State: 'Default' }, interactions: [{ trigger: 'ON_HOVER', action: 'CHANGE_TO',
      destinationId: '5:2', destinationName: 'State=Filled', transition: { type: 'SMART_ANIMATE', durationMs: 300, easing: { type: 'EASE_OUT' } } }] },
    { id: '5:2', name: 'State=Filled', properties: { State: 'Filled' }, interactions: [] },
  ] });
  expect(byId.get('6:4')!.media).toEqual([{ kind: 'video', hash: 'v1' }]);
  expect(byId.get('6:5')!.links).toEqual([{ start: 9, end: 14, text: 'terms', url: 'https://example.com/terms' }]);
  expect(byId.get('6:6')!.animations).toEqual({
    styles: [{ name: 'Spin', type: 'FIGMA', durationMs: 1200 }],
    tracks: [{ property: 'ROTATION', durationMs: 1200, keyframes: [
      { atMs: 0, value: 0, easing: { type: 'LINEAR' } }, { atMs: 1200, value: 360, easing: { type: 'EASE_IN_AND_OUT' } }] }],
  });
  // The last child of a frame with one fixed child stays put while the page scrolls.
  expect(byId.get('6:7')).toEqual({ id: '6:7', fixed: true });
});

test('selection lists the selected layers of the current page, with the frames above each', async () => {
  const { getSelection } = await import('../src/read/selection');
  const { api: a } = makeFakeFigma({ ...tree, currentPage: '0:1', selections: { '0:1': ['1:3', '1:1'] } });
  expect(await getSelection(a)).toEqual({
    pageId: '0:1', pageName: 'Home', total: 2,
    layers: [
      { id: '1:3', name: 'Hero', type: 'FRAME', x: 0, y: 0, width: 1440, height: 400, visible: true, childCount: 1, path: ['Landing'] },
      { id: '1:1', name: 'Landing', type: 'FRAME', x: 0, y: 0, width: 1440, height: 900, visible: true, childCount: 3, path: [] },
    ],
  });
});
test('selection is empty when nothing is selected, and reads the page the owner is on', async () => {
  const { getSelection } = await import('../src/read/selection');
  const { api: a } = makeFakeFigma({ ...tree, currentPage: '0:3' });
  expect(await getSelection(a)).toEqual({ pageId: '0:3', pageName: 'Sections', total: 0, layers: [] });
});
test('selection lists at most MAX_SELECTED layers and gives the full count', async () => {
  const { getSelection, MAX_SELECTED } = await import('../src/read/selection');
  const many = Array.from({ length: MAX_SELECTED + 5 }, (_, i) => ({ id: `9:${i}`, name: `R${i}`, type: 'RECTANGLE' }));
  const { api: a } = makeFakeFigma({
    loadedPages: ['0:9'],
    pages: [{ id: '0:9', name: 'Big', type: 'PAGE', children: many }],
    selections: { '0:9': many.map((m) => m.id) },
  });
  const out = await getSelection(a);
  expect(out.total).toBe(MAX_SELECTED + 5);
  expect(out.layers).toHaveLength(MAX_SELECTED);
});
test('router: getSelection reads the selection', async () => {
  const { api: a } = makeFakeFigma({ ...tree, selections: { '0:1': ['1:2'] } });
  expect(await handleRequest(a, 'getSelection', {})).toEqual(expect.objectContaining({ total: 1, layers: [expect.objectContaining({ id: '1:2', path: ['Landing'] })] }));
});
