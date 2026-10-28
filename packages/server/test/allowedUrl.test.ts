import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allowedTarget, isAllowedUrl, URL_NOT_ALLOWED } from '../src/browser/allowedUrl';

const workDir = path.join(__dirname, 'fixtures');

test('pages on this computer are allowed', () => {
  for (const url of ['http://localhost:5173/', 'https://localhost/', 'http://127.0.0.1:3000/a?b=c', 'http://[::1]:8080/',
    'http://app.localhost:3000/', 'http://LOCALHOST/']) expect(isAllowedUrl(url, workDir)).toBe(true);
});

test('files inside the project are allowed', () => {
  expect(isAllowedUrl(pathToFileURL(path.join(workDir, 'hero.html')).href, workDir)).toBe(true);
});

test('other addresses are refused', () => {
  for (const url of ['https://example.com', 'data:text/html,<p>hi</p>', 'file:///etc/hosts', 'http://localhost.example.com/',
    'http://127.0.0.2/', 'ftp://localhost/', 'javascript:alert(1)', 'localhost:5173', 'not a url',
    pathToFileURL(path.join(workDir, '..', 'hero.html')).href]) expect(isAllowedUrl(url, workDir)).toBe(false);
});

test('the refusal message is plain', () =>
  expect(URL_NOT_ALLOWED).toBe('Pixel Twin only opens pages on this computer\'s development server (localhost) or files inside the project.'));

test('a file reached through a symlink that leaves the project is refused, and so is a missing file', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'pixel-twin-project-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'pixel-twin-outside-'));
  writeFileSync(path.join(outside, 'secret.html'), '<p>secret</p>');
  writeFileSync(path.join(project, 'page.html'), '<p>page</p>');
  symlinkSync(path.join(outside, 'secret.html'), path.join(project, 'link.html'));
  symlinkSync(outside, path.join(project, 'linked-dir'));
  const url = (...p: string[]) => pathToFileURL(path.join(project, ...p)).href;
  expect(isAllowedUrl(url('page.html'), project)).toBe(true);
  expect(isAllowedUrl(url('link.html'), project)).toBe(false);
  expect(isAllowedUrl(url('linked-dir', 'secret.html'), project)).toBe(false);
  expect(isAllowedUrl(url('missing.html'), project)).toBe(false);
});

test('allowedTarget gives the address to open: file links resolved to the real file', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'pixel-twin-project-'));
  mkdirSync(path.join(project, 'real'));
  writeFileSync(path.join(project, 'real', 'page.html'), '<p>page</p>');
  symlinkSync(path.join(project, 'real'), path.join(project, 'alias'));
  expect(allowedTarget(pathToFileURL(path.join(project, 'alias', 'page.html')).href, project))
    .toBe(pathToFileURL(realpathSync(path.join(project, 'real', 'page.html'))).href);
  expect(allowedTarget('http://localhost:5173/a?b=1', project)).toBe('http://localhost:5173/a?b=1');
  expect(allowedTarget('https://example.com', project)).toBeNull();
});
