import { build } from 'esbuild';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSecret } from '../../scripts/secret.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dist = join(here, 'dist');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

// Only our own shared package goes into the bundle. Every other dependency stays external.
const external = Object.keys(pkg.dependencies).filter((name) => name !== '@pixel-twin/shared');

// The bundle holds the secret, so only the owner may open the folder and file.
mkdirSync(dist, { recursive: true, mode: 0o700 });
chmodSync(dist, 0o700);

const outfile = join(dist, 'index.js');
await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external,
  banner: { js: '#!/usr/bin/env node' },
  define: { __PIXEL_TWIN_SECRET__: JSON.stringify(ensureSecret(root)) },
  logLevel: 'warning',
});
chmodSync(outfile, 0o600);
