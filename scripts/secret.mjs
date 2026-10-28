import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared secret that the plugin and the server both read. Created on first use. */
export function ensureSecret(repoRoot) {
  const file = join(repoRoot, '.pixel-twin-secret');
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}
