import { build } from 'esbuild';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from '../shared/src/config.ts';
import { ensureSecret } from '../../scripts/secret.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dist = join(here, 'dist');
const url = `ws://localhost:${PORT}`;
// code.js holds the secret, so only the owner may open the folder and that file.
mkdirSync(dist, { recursive: true, mode: 0o700 });
chmodSync(dist, 0o700);

// Main code (Figma sandbox). The secret goes only here, never into the window.
await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(dist, 'code.js'),
  bundle: true,
  format: 'iife',
  target: 'es2017',
  define: { __PIXEL_TWIN_SECRET__: JSON.stringify(ensureSecret(root)) },
  logLevel: 'warning',
});

chmodSync(join(dist, 'code.js'), 0o600);

// Window: bundle the script inside ui.html and inline it.
const html = readFileSync(join(here, 'src/ui/ui.html'), 'utf8');
const match = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!match) throw new Error('ui.html has no inline <script>');
const bundled = await build({
  stdin: { contents: match[1], resolveDir: join(here, 'src/ui'), loader: 'js' },
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2017',
  define: { __PIXEL_TWIN_URL__: JSON.stringify(url) },
  logLevel: 'warning',
});
const script = bundled.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
writeFileSync(
  join(dist, 'ui.html'),
  html.replace(match[0], () => `<script>${script}</script>`),
);

writeFileSync(join(dist, 'manifest.json'), JSON.stringify({
  name: 'Pixel Twin',
  id: 'pixel-twin-local',
  api: '1.0.0',
  main: 'code.js',
  ui: 'ui.html',
  editorType: ['figma'],
  documentAccess: 'dynamic-page',
  enablePrivatePluginApi: true,
  networkAccess: {
    allowedDomains: ['none'],
    reasoning: 'Talks only to the Pixel Twin server on this computer.',
    devAllowedDomains: [url],
  },
}, null, 2) + '\n');
