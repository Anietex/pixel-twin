import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { breakpoints, loadSettings, pageUrl } from '../src/settings';

const project = async (content?: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-settings-'));
  if (content !== undefined) await writeFile(path.join(dir, 'pixel-twin.json'), content);
  return dir;
};

test('a project with no settings file has empty settings', async () => {
  expect(await loadSettings(await project())).toEqual({});
});

test('settings are read from pixel-twin.json', async () => {
  const dir = await project(JSON.stringify({
    devServer: 'http://localhost:5173', breakpoints: { phoneMax: 639, tabletMax: 1279 },
    scaling: 'scale', motion: 'subtle', assetsDir: 'public/figma',
  }));
  expect(await loadSettings(dir)).toEqual({
    devServer: 'http://localhost:5173', breakpoints: { phoneMax: 639, tabletMax: 1279 },
    scaling: 'scale', motion: 'subtle', assetsDir: 'public/figma',
  });
});

test('a broken settings file gives a plain error that names the file', async () => {
  await expect(loadSettings(await project('{ nope'))).rejects.toThrow(/pixel-twin\.json is not valid JSON/);
  await expect(loadSettings(await project(JSON.stringify({ motion: 'wild' })))).rejects.toThrow(/pixel-twin\.json has a wrong value/);
});

test('a path is joined to the devServer, and a full address is kept', () => {
  const settings = { devServer: 'http://localhost:5173' };
  expect(pageUrl('/about?x=1', settings)).toBe('http://localhost:5173/about?x=1');
  expect(pageUrl(undefined, settings)).toBe('http://localhost:5173');
  expect(pageUrl('http://127.0.0.1:3000/', settings)).toBe('http://127.0.0.1:3000/');
  expect(() => pageUrl('/about', {})).toThrow(/set devServer in pixel-twin\.json/);
  expect(() => pageUrl(undefined, {})).toThrow(/Give url, or set devServer/);
});

test('breakpoints come from the call, then the settings, then 767 and 1023', () => {
  expect(breakpoints({}, {})).toEqual({ phoneMax: 767, tabletMax: 1023 });
  expect(breakpoints({ breakpoints: { tabletMax: 1279 } }, {})).toEqual({ phoneMax: 767, tabletMax: 1279 });
  expect(breakpoints({ breakpoints: { tabletMax: 1279 } }, { tabletMax: 900 })).toEqual({ phoneMax: 767, tabletMax: 900 });
});
