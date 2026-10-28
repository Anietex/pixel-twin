import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import type { Client } from '@modelcontextprotocol/client';
import type { FrameSections } from '@pixel-twin/shared';
import { PluginBridge } from '../src/bridge';
import type { ServerDeps } from '../src/createServer';
import { connectTestClient, noBrowser, startFakePlugin } from './helpers/mcp';

const frames: FrameSections[] = [
  { frameId: '1:1', frameName: 'Home', frameWidth: 1440, sections: [
    { id: '1:2', name: 'Hero', texts: ['Build faster'] },
    { id: '1:3', name: 'Pricing', texts: ['Plans'] },
  ] },
  { frameId: '2:1', frameName: 'Home – Mobile', frameWidth: 375, sections: [
    { id: '2:2', name: 'Hero', texts: ['Build faster'] },
    { id: '2:3', name: 'Pricing', texts: ['Plans'] },
  ] },
];
const LINK = 'https://www.figma.com/design/K/Landing';
const PAGES = [
  { id: '0:1', name: 'Website 2026', type: 'PAGE', x: 0, y: 0, width: 0, height: 0, visible: true, childCount: 0 },
  { id: '0:2', name: 'Website 2026 - Mobile', type: 'PAGE', x: 0, y: 0, width: 0, height: 0, visible: true, childCount: 0 },
  { id: '0:3', name: 'Archive', type: 'PAGE', x: 0, y: 0, width: 0, height: 0, visible: true, childCount: 0 },
];
let mobilePage: FrameSections[];   // what the "Website 2026 - Mobile" page holds

let bridge: PluginBridge;
let sockets: WebSocket[];
let client: Client;
let calls: { method: string; params: any }[];

beforeEach(async () => {
  sockets = [];
  calls = [];
  mobilePage = [];
  bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs: 1000, secret: 'test-secret' });
  await bridge.start();
  sockets.push(await startFakePlugin(bridge,
    { type: 'hello', fileName: 'Landing', fileKey: 'K', editorType: 'figma', pluginVersion: '0.1.0' },
    (method, params: any) => {
      calls.push({ method, params });
      if (method === 'hasNode') return { exists: params.nodeId !== '9:9', pageId: '0:1' };
      if (method === 'getOutline') return PAGES;
      if (method === 'listSections') return params.pageId === '0:2' ? mobilePage : params.pageId === '0:1' ? frames : [{ frameId: '3:1', frameName: 'Old', frameWidth: 375, sections: [] }];
      throw new Error(`unexpected ${method}`);
    }));
  const deps: ServerDeps = { bridge, bridgeError: null, workDir: await mkdtemp(path.join(tmpdir(), 'pixel-twin-mobile-')), browser: noBrowser };
  client = await connectTestClient(deps);
});
afterEach(async () => {
  await client?.close();
  sockets.forEach((s) => s.terminate());
  await bridge.stop();
});

const run = async (nodeId: string) => {
  const r: any = await client.callTool({ name: 'find_mobile_version', arguments: { link: `${LINK}?node-id=${nodeId}` } });
  return { r, body: r.isError ? null : JSON.parse(r.content[0].text) };
};

test('finds the mobile section for a desktop section', async () => {
  const { body } = await run('1-2');
  expect(body.desktop).toEqual({ id: '1:2', name: 'Hero', frameName: 'Home' });
  expect(body.candidates[0]).toMatchObject({ id: '2:2', frameWidth: 375 });
  expect(body.confident).toBe(true);
  // The same page, and the page named Mobile; not other pages.
  expect(calls.filter((c) => c.method === 'listSections').map((c) => c.params.pageId)).toEqual(['0:1', '0:2']);
});

test('finds the phone design on a page named Mobile, in the frame named like the desktop frame', async () => {
  mobilePage = [
    { frameId: '5:1', frameName: 'About', frameWidth: 402, sections: [{ id: '5:2', name: 'Hero', texts: ['About us'] }] },
    { frameId: '6:1', frameName: 'Home', frameWidth: 402, sections: [{ id: '6:2', name: 'Hero', texts: ['Build faster today'] }] },
  ];
  frames.splice(1, 1);   // no phone frame on the desktop page
  try {
    const { body } = await run('1-2');
    expect(body.candidates[0]).toMatchObject({ id: '6:2', frameName: 'Home', frameWidth: 402, pageName: 'Website 2026 - Mobile' });
    expect(body.confident).toBe(true);
    expect(body.none).toBe(false);
  } finally {
    frames.splice(1, 0, { frameId: '2:1', frameName: 'Home – Mobile', frameWidth: 375, sections: [
      { id: '2:2', name: 'Hero', texts: ['Build faster'] }, { id: '2:3', name: 'Pricing', texts: ['Plans'] }] });
  }
});

test('a whole frame is matched against other narrow frames', async () => {
  const { body } = await run('1-1');
  expect(body.desktop).toEqual({ id: '1:1', name: 'Home', frameName: 'Home' });
  expect(body.candidates.map((c: any) => [c.id, c.frameName])).toEqual([['2:1', 'Home – Mobile']]);
  expect(body.confident).toBe(true);
});

test('a nested layer asks the user to pick a section or frame', async () => {
  const { r } = await run('5-5');
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toBe('Pick a section (a direct child of a frame) or a whole frame, then try again.');
});

test('a link without a node-id is an error', async () => {
  const r: any = await client.callTool({ name: 'find_mobile_version', arguments: { link: LINK } });
  expect(r.isError).toBe(true);
});
