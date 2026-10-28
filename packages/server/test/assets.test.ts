import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import type WebSocket from 'ws';
import type { Client } from '@modelcontextprotocol/client';
import { PluginBridge } from '../src/bridge';
import { createBrowserProvider, type BrowserProvider } from '../src/browser/launch';
import type { ServerDeps } from '../src/createServer';
import { assetCoveredIds, imageInfo, planAssets, slug } from '../src/design/assets';
import { toSectionData, type RestNode } from '../src/design/normalize';
import type { Layer } from '../src/design/types';
import { connectTestClient, noBrowser, startFakePlugin } from './helpers/mcp';

const load = (name: string) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const rest = load('hero.rest.json');
const textDetails = load('hero.text.json');
const vars = load('hero.vars.json');
const hero = toSectionData({ document: rest.document as RestNode, textDetails, variables: vars });

const png = (w: number, h: number) => PNG.sync.write(new PNG({ width: w, height: h }));
const LINK = 'https://www.figma.com/design/K/Landing';
const text = (res: any): string => res.content[0].text;

let bridge: PluginBridge;
let sockets: WebSocket[];
let client: Client;
let workDir: string;
let calls: { method: string; params: any }[];
let imageBytes: () => { base64: string };
let exportHeight = 5;   // px at 1x

beforeEach(async () => {
  sockets = [];
  calls = [];
  imageBytes = () => ({ base64: png(30, 20).toString('base64') });
  exportHeight = 5;
  workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-assets-'));
  bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs: 1000, secret: 'test-secret' });
  await bridge.start();
  sockets.push(await startFakePlugin(bridge,
    { type: 'hello', fileName: 'Landing', fileKey: 'K', editorType: 'figma', pluginVersion: '0.1.0' },
    (method, params: any) => {
      calls.push({ method, params });
      switch (method) {
        case 'hasNode': return { exists: true, pageId: '0:1' };
        case 'getNodeJson': return rest;
        case 'getTextDetails': return textDetails;
        case 'resolveVariables': return vars;
        case 'getImageBytes': return imageBytes();
        case 'exportNode':
          return params.format === 'SVG'
            ? { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }
            : { base64: png(params.scale * 10, params.scale * exportHeight).toString('base64') };
        default: throw new Error(`unexpected ${method}`);
      }
    }));
  const deps: ServerDeps = { bridge, bridgeError: null, workDir, browser: noBrowser };
  client = await connectTestClient(deps);
});
afterEach(async () => {
  await client?.close();
  sockets.forEach((s) => s.terminate());
  await bridge.stop();
});

const plans = planAssets(hero.root);

test('plans the photo as original and the icon as svg', () =>
  expect(plans).toEqual([
    { layerId: '1:5', layerName: 'Photo', kind: 'image-original', imageRef: 'abc123' },
    { layerId: '1:6', layerName: 'Icon', kind: 'svg' }]));

test('a cropped or transformed image is rendered instead', () => {
  const root: Layer = JSON.parse(JSON.stringify(hero.root));
  const photo = root.children.find((c) => c.id === '1:5')!;
  photo.fills = [{ type: 'image', imageRef: 'abc123', scaleMode: 'FILL', transformed: true }];
  expect(planAssets(root)[0]).toEqual({ layerId: '1:5', layerName: 'Photo', kind: 'image-render' });
  photo.fills = [{ type: 'image', imageRef: 'abc123', scaleMode: 'CROP', transformed: false }];
  expect(planAssets(root)[0].kind).toBe('image-render');
});

test('a frame with children and a moved image keeps its children checkable', () => {
  // The call-to-action case: a frame with a cropped background photo and text on top.
  const root: Layer = JSON.parse(JSON.stringify(hero.root));
  const card = root.children.find((c) => c.id === '1:3')!;   // Button frame, has the Label child
  card.fills = [{ type: 'image', imageRef: 'bg1', scaleMode: 'FILL', transformed: true }];
  const p = planAssets(root);
  expect(p).toContainEqual({ layerId: '1:3', layerName: 'Button', kind: 'image-original', imageRef: 'bg1', adjusted: true });
  expect(assetCoveredIds(root, p).has('1:4')).toBe(false);
});

test('layers inside an svg asset are covered', () => {
  expect(assetCoveredIds(hero.root, plans).has('1:7')).toBe(true);
  expect(assetCoveredIds(hero.root, plans).has('1:6')).toBe(false);
  expect(assetCoveredIds(hero.root, plans).has('1:5')).toBe(false);
});

test('two component instances side by side are two icons; two shapes in a group are one drawing', () => {
  const vector = (id: string) => ({ ...hero.root, id, name: 'V', type: 'VECTOR', fills: [], children: [] }) as Layer;
  const icon = (id: string) => ({ ...hero.root, id, name: 'Icon', type: 'INSTANCE', fills: [], children: [vector(`${id}v`)] }) as Layer;
  const group = (children: Layer[]) => ({ ...hero.root, id: '9:0', name: 'G', type: 'GROUP', fills: [], children }) as Layer;
  expect(planAssets(group([icon('9:1'), icon('9:2')])).map((p) => p.layerId)).toEqual(['9:1', '9:2']);
  expect(planAssets(group([vector('9:3'), vector('9:4')])).map((p) => p.layerId)).toEqual(['9:0']);
});

test('an ellipse-only group is not an svg', () => {
  const dot = { ...hero.root, id: '9:1', type: 'ELLIPSE', fills: [], children: [] } as Layer;
  expect(planAssets({ ...hero.root, id: '9:0', type: 'GROUP', fills: [], children: [dot] })).toEqual([]);
});

test('slug and image info', () => {
  expect(slug('  Hero / Photo!! ')).toBe('hero-photo');
  expect(slug('***')).toBe('layer');
  expect(imageInfo(png(30, 20))).toEqual({ ext: 'png', width: 30, height: 20 });
  expect(imageInfo(Buffer.from('GIF89a\x05\x00\x07\x00', 'binary'))).toEqual({ ext: 'gif', width: 5, height: 7 });
  expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 9, 0, 4]))).toEqual({ ext: 'jpg', width: 4, height: 9 });
  expect(imageInfo(Buffer.from('nope'))).toBeNull();
});

test('export_assets writes files into assetsDir', async () => {
  const r = await client.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'public/img' } });
  expect(r.isError).toBeFalsy();
  const dir = path.join(workDir, 'public/img');
  expect((await readdir(dir)).sort()).toEqual(['icon-1-6.svg', 'photo-1-5.png', 'pixel-twin-assets.json']);
  expect(await readFile(path.join(dir, 'icon-1-6.svg'), 'utf8')).toContain('<svg');
  const body = JSON.parse(text(r));
  expect(body).toEqual([
    { layerId: '1:6', layerName: 'Icon', kind: 'svg', path: path.join(dir, 'icon-1-6.svg'), width: expect.any(Number), height: expect.any(Number), kb: 0 },
    { layerId: '1:5', layerName: 'Photo', kind: 'image-original', path: path.join(dir, 'photo-1-5.png'), width: 30, height: 20, kb: 0 },
  ]);
  // The list keeps each layer's file, size and shown size, and keeps other sections' entries.
  const list = JSON.parse(await readFile(path.join(dir, 'pixel-twin-assets.json'), 'utf8'));
  expect(list['1:5']).toEqual({ layerName: 'Photo', kind: 'image-original', file: 'photo-1-5.png', width: 30, height: 20, shown: { width: 216, height: 152 } });
  expect(list['1:6']).toMatchObject({ kind: 'svg', file: 'icon-1-6.svg' });
  await writeFile(path.join(dir, 'pixel-twin-assets.json'), JSON.stringify({ '7:7': { layerName: 'Other', file: 'other.png' } }));
  await client.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'public/img' } });
  expect(Object.keys(JSON.parse(await readFile(path.join(dir, 'pixel-twin-assets.json'), 'utf8'))).sort()).toEqual(['1:5', '1:6', '7:7']);
});

test('icons in a row are one file each, and a file with the same content is saved once', async () => {
  // Three arrow instances in an auto-layout row, the last one in a frame Figma names by its layer id.
  const arrow = (id: string): RestNode => ({ id, name: 'Arrow', type: 'INSTANCE', absoluteBoundingBox: { x: 0, y: 0, width: 16, height: 16 },
    children: [{ id: `${id}-v`, name: 'Vector', type: 'VECTOR', absoluteBoundingBox: { x: 0, y: 0, width: 16, height: 16 }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] }] } as unknown as RestNode);
  const row = { id: '1:1', name: 'Icons', type: 'FRAME', layoutMode: 'HORIZONTAL', itemSpacing: 8, absoluteBoundingBox: { x: 0, y: 0, width: 64, height: 16 },
    children: [arrow('2:1'), arrow('2:2'), arrow('2:3')] };
  const icons = { document: row };
  const svgOf = (nodeId: string) => (nodeId === '2:3'
    ? '<svg><clipPath id="clip0_2_3"/><g clip-path="url(#clip0_2_3)"/></svg>'
    : `<svg><clipPath id="clip0_${nodeId.replace(':', '_')}"/><g clip-path="url(#clip0_${nodeId.replace(':', '_')})"/></svg>`);
  sockets.push(await startFakePlugin(bridge,
    { type: 'hello', fileName: 'Icons', fileKey: 'I', editorType: 'figma', pluginVersion: '0.1.0' },
    (method, params: any) => {
      switch (method) {
        case 'hasNode': return { exists: true, pageId: '0:1' };
        case 'getNodeJson': return icons;
        case 'getTextDetails': return [];
        case 'resolveVariables': return [];
        case 'exportNode': return { svg: svgOf(params.nodeId) };
        default: throw new Error(`unexpected ${method}`);
      }
    }));
  const r = await client.callTool({ name: 'export_assets', arguments: { link: 'https://www.figma.com/design/I/Icons?node-id=1-1', assetsDir: 'icons' } });
  const body = JSON.parse(text(r));
  expect(body.map((f: any) => [f.layerId, path.basename(f.path), f.sameAs])).toEqual([
    ['2:1', 'arrow-2-1.svg', undefined], ['2:2', 'arrow-2-1.svg', '2:1'], ['2:3', 'arrow-2-1.svg', '2:1']]);
  expect((await readdir(path.join(workDir, 'icons'))).sort()).toEqual(['arrow-2-1.svg', 'pixel-twin-assets.json']);
});

test('an image hash the plugin cannot find falls back to a 2x render', async () => {
  imageBytes = () => { throw new Error('Image abc123 not found'); };
  const r = await client.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img' } });
  const body = JSON.parse(text(r));
  const photo = body.find((a: any) => a.layerId === '1:5');
  expect(photo).toMatchObject({ kind: 'image-render', width: 20, height: 10 });
  expect(calls.find((c) => c.method === 'exportNode' && c.params.nodeId === '1:5')?.params).toEqual({ nodeId: '1:5', format: 'PNG', scale: 2 });
});

test('export_assets rejects an assetsDir outside the project folder', async () => {
  for (const assetsDir of ['../outside', '/etc/pixel']) {
    const r = await client.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('assetsDir must be inside the project folder');
  }
});

test('get_screenshot saves 1x and 2x and returns the 1x image', async () => {
  const r: any = await client.callTool({ name: 'get_screenshot', arguments: { link: `${LINK}?node-id=1-1` } });
  const dir = path.join(workDir, '.pixel-twin', 'shots');
  expect((await readdir(dir)).sort()).toEqual(['1-1@1x.png', '1-1@2x.png']);
  expect(r.content[0].text).toContain(path.join(dir, '1-1@1x.png'));
  expect(r.content[0].text).toContain(path.join(dir, '1-1@2x.png'));
  const img = r.content.find((c: any) => c.type === 'image');
  expect(img.mimeType).toBe('image/png');
  expect(Buffer.from(img.data, 'base64')).toEqual(await readFile(path.join(dir, '1-1@1x.png')));
  expect(calls.filter((c) => c.method === 'exportNode').map((c) => c.params.scale)).toEqual([1, 2]);
});

test('a folder named like ..assets is allowed', async () => {
  const r = await client.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: '..assets' } });
  expect(r.isError).toBeFalsy();
  expect((await readdir(path.join(workDir, '..assets'))).length).toBe(3);   // two files and the list
});

test('a truncated PNG falls back to a 2x render', async () => {
  imageBytes = () => ({ base64: png(30, 20).subarray(0, 12).toString('base64') });
  const r = await client.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img' } });
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(text(r)).find((a: any) => a.layerId === '1:5')).toMatchObject({ kind: 'image-render' });
  expect(imageInfo(png(30, 20).subarray(0, 12))).toBeNull();
});

test('get_screenshot keeps a hostile node id inside the shots folder', async () => {
  const r: any = await client.callTool({ name: 'get_screenshot', arguments: { link: LINK, nodeId: '../../x' } });
  const dir = path.join(workDir, '.pixel-twin', 'shots');
  expect((await readdir(dir)).sort()).toEqual(['------x@1x.png', '------x@2x.png']);
  expect(r.content[0].text).toContain(dir);
});

test('get_screenshot without a node id asks for get_outline first', async () => {
  const r = await client.callTool({ name: 'get_screenshot', arguments: { link: LINK } });
  expect(r.isError).toBe(true);
});

test('a filtered image is rendered, so its colour shift is in the file', () => {
  const root: Layer = JSON.parse(JSON.stringify(hero.root));
  const photo = root.children.find((c) => c.id === '1:5')!;
  photo.fills = [{ type: 'image', imageRef: 'abc123', scaleMode: 'FILL', transformed: false, filters: { exposure: 0.2 } }];
  expect(planAssets(root)[0]).toEqual({ layerId: '1:5', layerName: 'Photo', kind: 'image-render' });
});

test('a very tall frame gets only a 1x picture and a shrunk preview', async () => {
  exportHeight = 9000;
  const r: any = await client.callTool({ name: 'get_screenshot', arguments: { link: `${LINK}?node-id=1-1` } });
  expect(r.isError).toBeFalsy();
  expect(await readdir(path.join(workDir, '.pixel-twin', 'shots'))).toEqual(['1-1@1x.png']);
  expect(calls.filter((c) => c.method === 'exportNode').map((c) => c.params.scale)).toEqual([1]);
  expect(r.content[0].text).toContain('9000 px tall');
  const img = r.content.find((c: any) => c.type === 'image');
  expect(imageInfo(Buffer.from(img.data, 'base64'))!.height).toBe(3000);   // shrunk 3 times
});

test('a photo far bigger than it is shown is shrunk to a 2x picture, unless asked not to', async () => {
  imageBytes = () => ({ base64: png(1200, 800).toString('base64') });   // the Photo layer is 216 × 152
  const r = await client.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img' } });
  expect(JSON.parse(text(r)).find((a: any) => a.layerId === '1:5')).toMatchObject({ kind: 'image-render' });
  expect(calls.some((c) => c.method === 'exportNode' && c.params.nodeId === '1:5' && c.params.format === 'PNG' && c.params.scale === 2)).toBe(true);
  const keep = await client.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img2', shrinkImages: false, srcset: false } });
  expect(JSON.parse(text(keep)).find((a: any) => a.layerId === '1:5')).toMatchObject({ kind: 'image-original', width: 1200, height: 800 });
});

/** A photo-like PNG: noise, so PNG can't shrink it. Fully opaque unless `clear` is set. */
function photoPng(size: number, clear = false): Buffer {
  const p = new PNG({ width: size, height: size });
  for (let i = 0; i < p.data.length; i++) p.data[i] = i % 4 === 3 ? (clear && i < 400 ? 0 : 255) : Math.floor(Math.random() * 256);
  return PNG.sync.write(p);
}

describe('photo format', () => {
  let browser: BrowserProvider;
  let real: Client;
  beforeAll(() => { browser = createBrowserProvider(); });
  afterAll(async () => { await browser.close(); });
  beforeEach(async () => {
    real = await connectTestClient({ bridge, bridgeError: null, workDir, browser });
  });
  afterEach(async () => { await real.close(); });

  test('an opaque PNG photo over 50 KB is saved as WebP, smaller', async () => {
    const original = photoPng(300);
    imageBytes = () => ({ base64: original.toString('base64') });
    const body = JSON.parse(text(await real.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img', shrinkImages: false } })));
    const photo = body.find((f: any) => f.layerId === '1:5');
    expect(photo).toMatchObject({ convertedFrom: 'png', path: expect.stringMatching(/\.webp$/) });
    const saved = await readFile(photo.path);
    expect(saved.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(saved.length).toBeLessThan(original.length);
  }, 30_000);

  test('a PNG with transparency stays a PNG', async () => {
    imageBytes = () => ({ base64: photoPng(300, true).toString('base64') });
    const body = JSON.parse(text(await real.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img', shrinkImages: false } })));
    expect(body.find((f: any) => f.layerId === '1:5')).toMatchObject({ path: expect.stringMatching(/\.png$/) });
    expect(body.find((f: any) => f.layerId === '1:5').convertedFrom).toBeUndefined();
  }, 30_000);

  test('a picture bigger than it is shown gets 1x and 2x copies for srcset, smallest first', async () => {
    imageBytes = () => ({ base64: photoPng(900).toString('base64') });   // the Photo layer is 216 × 152
    const body = JSON.parse(text(await real.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img', shrinkImages: false } })));
    const photo = body.find((f: any) => f.layerId === '1:5');
    expect(photo.srcset.map((s: any) => s.width)).toEqual([216, 432, 900]);
    expect(photo.srcset[0].path).toMatch(/photo-1-5-216w\.webp$/);
    const small = await readFile(photo.srcset[0].path);
    expect(small.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(small.length).toBeLessThan((await readFile(photo.path)).length);
  }, 30_000);

  test('an original picture more than twice its shown size is shrunk to twice that, whole', async () => {
    imageBytes = () => ({ base64: photoPng(1200).toString('base64') });   // the Photo layer is 216 × 152, filled
    const body = JSON.parse(text(await real.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img', srcset: false } })));
    const photo = body.find((f: any) => f.layerId === '1:5');
    // FILL covers the layer: the square picture must be 2 × 216 = 432 px across to cover it at twice the size.
    expect(photo).toMatchObject({ kind: 'image-original', width: 432, height: 432, cappedFrom: { width: 1200, height: 1200 } });
    expect(imageInfo(await readFile(photo.path))).toMatchObject({ width: 432, height: 432 });
  }, 30_000);

  test('a JPG photo over 50 KB is saved as WebP when smaller, unless photoFormat is jpg', async () => {
    const encoder = await (await import('../src/browser/encodeImage')).openEncoder(browser);
    const jpg = await encoder.encode(photoPng(300), 'image/jpeg', 0.95);
    await encoder.close();
    expect(jpg.length).toBeGreaterThan(50 * 1024);
    imageBytes = () => ({ base64: jpg.toString('base64') });
    const body = JSON.parse(text(await real.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img', shrinkImages: false, srcset: false } })));
    expect(body.find((f: any) => f.layerId === '1:5')).toMatchObject({ convertedFrom: 'jpg', path: expect.stringMatching(/\.webp$/) });
    const kept = JSON.parse(text(await real.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img2', shrinkImages: false, srcset: false, photoFormat: 'jpg' } })));
    expect(kept.find((f: any) => f.layerId === '1:5')).toMatchObject({ path: expect.stringMatching(/\.jpg$/) });
    expect(kept.find((f: any) => f.layerId === '1:5').convertedFrom).toBeUndefined();
  }, 30_000);

  test('photoFormat jpg saves a JPG, and png keeps the PNG', async () => {
    imageBytes = () => ({ base64: photoPng(300).toString('base64') });
    const jpg = JSON.parse(text(await real.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img', shrinkImages: false, photoFormat: 'jpg' } })));
    expect(jpg.find((f: any) => f.layerId === '1:5').path).toMatch(/\.jpg$/);
    const png = JSON.parse(text(await real.callTool({ name: 'export_assets', arguments: { link: `${LINK}?node-id=1-1`, assetsDir: 'img', shrinkImages: false, photoFormat: 'png' } })));
    expect(png.find((f: any) => f.layerId === '1:5').path).toMatch(/\.png$/);
  }, 30_000);
});
