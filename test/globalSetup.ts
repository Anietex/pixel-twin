import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export default function setup() {
  execFileSync('node', [join(root, 'packages/plugin/build.mjs')], { stdio: 'pipe' });
  execFileSync('node', [join(root, 'packages/server/build.mjs')], { stdio: 'pipe' });
}
