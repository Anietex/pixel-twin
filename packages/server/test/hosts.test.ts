import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

test('the only outside hosts are Google Fonts (this computer, localhost, is not outside)', () => {
  const hosts = walk(path.join(__dirname, '..', 'src'))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/https?:\/\/([^/\s"'`:?#)<>]+)/g)].map((m) => m[1]));
  expect(hosts.length).toBeGreaterThan(0);
  expect(hosts.filter((h) => !['fonts.googleapis.com', 'fonts.gstatic.com', 'localhost'].includes(h))).toEqual([]);
});
