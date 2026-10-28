import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const mode = (path: string) => statSync(path).mode & 0o777;

test('the server bundle starts with a node shebang and holds the secret', () => {
  const secret = readFileSync(join(root, '.pixel-twin-secret'), 'utf8').trim();
  const code = readFileSync(join(root, 'packages/server/dist/index.js'), 'utf8');
  expect(code.startsWith('#!/usr/bin/env node')).toBe(true);
  expect(code).toContain(secret);
  expect(code).not.toContain('__PIXEL_TWIN_SECRET__');
});

test('dist folders are private (0700) and files with the secret are 0600', () => {
  for (const pkg of ['plugin', 'server']) expect(mode(join(root, 'packages', pkg, 'dist'))).toBe(0o700);
  expect(mode(join(root, 'packages/plugin/dist/code.js'))).toBe(0o600);
  expect(mode(join(root, 'packages/server/dist/index.js'))).toBe(0o600);
});
