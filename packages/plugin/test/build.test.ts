import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, test } from 'vitest';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(pluginDir, 'dist');
let manifest: any;
let uiHtml: string;
let code: string;

beforeAll(() => {
  manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  uiHtml = readFileSync(join(dist, 'ui.html'), 'utf8');
  code = readFileSync(join(dist, 'code.js'), 'utf8');
});

test('manifest is generated from config', () => {
  expect(manifest).toMatchObject({
    name: 'Pixel Twin', main: 'code.js', ui: 'ui.html', editorType: ['figma'],
    documentAccess: 'dynamic-page', enablePrivatePluginApi: true,
    networkAccess: { allowedDomains: ['none'], devAllowedDomains: ['ws://localhost:3851'] },
  });
});

test('ui.html inlines its script and points at the configured port', () => {
  expect(uiHtml).toContain('ws://localhost:3851');
  expect(uiHtml).not.toMatch(/<script[^>]+src=/);
});

test('the secret is injected into code.js and never into ui.html', () => {
  const secret = readFileSync(join(pluginDir, '..', '..', '.pixel-twin-secret'), 'utf8').trim();
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(code).toContain(secret);
  expect(uiHtml).not.toContain(secret);
});

test('the window asks main for the hello once it is listening, and main answers', () => {
  expect(uiHtml).toContain('ui-ready');
  expect(code).toContain('ui-ready');
  // Figma relays main's messages through its own frames, so a sender check would drop them all.
  expect(uiHtml).not.toContain('e.source !== parent');
});
