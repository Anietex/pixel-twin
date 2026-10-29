import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { PluginBridge } from '../src/bridge';
import { cleanWorkFiles, formatSize, STALE_AFTER_MS } from '../src/workFiles';
import { connectTestClient, noBrowser } from './helpers/mcp';

let workDir: string;
let bridge: PluginBridge;
let client: Client | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-clean-'));
  bridge = new PluginBridge({ port: 0, hosts: ['127.0.0.1'], timeoutMs: 1000, secret: 'test-secret' });
  await bridge.start();
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await bridge.stop();
  await rm(workDir, { recursive: true, force: true });
});

const put = async (rel: string, bytes = 10) => {
  const file = path.join(workDir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'x'.repeat(bytes));
  return file;
};
const has = (rel: string) => existsSync(path.join(workDir, rel));
const cleanUp = async (args: Record<string, unknown> = {}): Promise<string> => {
  client ??= await connectTestClient({ bridge, bridgeError: null, workDir, browser: noBrowser });
  const res: any = await client.callTool({ name: 'clean_up', arguments: args });
  return res.content[0].text;
};

test('clean_up deletes the working files, keeps compare\'s memory and the videos, and touches nothing else', async () => {
  await put('.pixel-twin/compare/1-2@1440/design.png', 2000);
  await put('.pixel-twin/compare/1-2@1440/areas/1.png', 500);
  await put('.pixel-twin/shots/1-2@1x.png', 1000);
  await put('.pixel-twin/section-1-2-1793192120433.txt', 300);
  await put('.pixel-twin/scratch/mobile-390.png', 200);
  await put('.pixel-twin/history.json');
  await put('.pixel-twin/explained.json');
  await put('.pixel-twin/record/Hero-1440.webm', 5000);
  await put('src/assets/figma/photo.png');
  await put('pixel-twin.json');

  const text = await cleanUp();
  expect(text).toContain(`Deleted 5 working files (4 KB) from ${path.join(workDir, '.pixel-twin')}.`);
  expect(text).toContain('Kept compare\'s memory: explained.json, history.json.');
  expect(text).toContain('Kept the videos for the owner: record/Hero-1440.webm.');
  expect((await readdir(path.join(workDir, '.pixel-twin'))).sort()).toEqual(['explained.json', 'history.json', 'record']);
  expect(has('src/assets/figma/photo.png')).toBe(true);
  expect(has('pixel-twin.json')).toBe(true);

  expect(await cleanUp({ keepVideos: false })).toContain('Deleted 1 working files (5 KB)');
  expect(has('.pixel-twin/record')).toBe(false);
});

test('clean_up says so when there is nothing to delete', async () => {
  expect(await cleanUp()).toBe(`Nothing to delete in ${path.join(workDir, '.pixel-twin')}.`);
});

test('with a time limit, only files changed before it are deleted, and the plan stays when asked', async () => {
  const old = await put('.pixel-twin/compare/1-2@1440/build.png');
  const plan = await put('.pixel-twin/plan.md');
  await put('.pixel-twin/compare/3-4@1440/build.png');
  const dayAgo = (Date.now() - STALE_AFTER_MS - 60_000) / 1000;
  await utimes(old, dayAgo, dayAgo);
  await utimes(plan, dayAgo, dayAgo);
  const r = await cleanWorkFiles(workDir, { keepVideos: true, keepPlan: true, olderThan: Date.now() - STALE_AFTER_MS });
  expect(r.files).toBe(1);
  expect(has('.pixel-twin/compare/1-2@1440')).toBe(false);   // its folder went with it
  expect(has('.pixel-twin/compare/3-4@1440/build.png')).toBe(true);
  expect(has('.pixel-twin/plan.md')).toBe(true);

  expect(await cleanUp()).toContain('Deleted 2 working files');   // the finished build's plan goes too
  expect(has('.pixel-twin/plan.md')).toBe(false);
});

test('links are never followed: a link inside is removed as a link, and a linked .pixel-twin is left alone', async () => {
  const outside = await put('outside/keep.txt');
  await mkdir(path.join(workDir, '.pixel-twin'));
  await symlink(path.join(workDir, 'outside'), path.join(workDir, '.pixel-twin', 'link'));
  await cleanWorkFiles(workDir, { keepVideos: true });
  expect(has('.pixel-twin/link')).toBe(false);
  expect(existsSync(outside)).toBe(true);

  await rm(path.join(workDir, '.pixel-twin'), { recursive: true });
  await symlink(path.join(workDir, 'outside'), path.join(workDir, '.pixel-twin'));
  await expect(cleanWorkFiles(workDir, { keepVideos: true })).rejects.toThrow('is not a folder');
  expect(existsSync(outside)).toBe(true);
});

test('sizes read as KB or MB', () => {
  expect(formatSize(1)).toBe('1 KB');
  expect(formatSize(243_100_000)).toBe('243.1 MB');
});
