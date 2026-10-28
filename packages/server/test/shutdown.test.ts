import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

/** A port nothing is using, so the test works while a real Pixel Twin server holds 3851. */
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

test('the server exits and frees its port when stdin closes', async () => {
  const PORT = await freePort();
  const child = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PIXEL_TWIN_PORT: String(PORT) } });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  // Wait until it holds the port (or give up with a clear message).
  const end = Date.now() + 5000;
  while (await portFree(PORT)) {
    if (Date.now() > end) throw new Error('server never took the port (is another one running?)');
    await new Promise((r) => setTimeout(r, 50));
  }
  child.stdin.end();
  const result = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000))]);
  if (result === 'timeout') child.kill();
  expect(result).not.toBe('timeout');
  expect(await portFree(PORT)).toBe(true);
}, 15000);
