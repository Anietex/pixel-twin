import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { HOSTS, PORT, REQUEST_TIMEOUT_MS } from '@pixel-twin/shared';
import { createBrowserProvider } from './browser/launch';
import { createPixelTwinServer, type ServerDeps } from './createServer';
import { SharedBridge } from './sharedBridge';
import { cleanWorkFiles, STALE_AFTER_MS } from './workFiles';

// PIXEL_TWIN_PORT is for tests only: the plugin is built to use PORT, so a different port can't reach it.
const port = Number(process.env.PIXEL_TWIN_PORT) || PORT;
// The first session owns the plugin port; later sessions share it, and take it over when the owner closes.
const bridge = new SharedBridge({ port, hosts: HOSTS, timeoutMs: REQUEST_TIMEOUT_MS, secret: __PIXEL_TWIN_SECRET__ });
await bridge.start();

const browser = createBrowserProvider(); // starts Chromium only when compare first needs it
const deps: ServerDeps = {
  bridge,
  get bridgeError() { return bridge.problem(); },   // tools report this instead of crashing
  workDir: process.cwd(),
  browser,
};
serveStdio(() => createPixelTwinServer(deps));

// Working files left by earlier sessions are no longer needed. Videos, compare's memory and an unfinished plan stay.
void cleanWorkFiles(deps.workDir, { keepVideos: true, keepPlan: true, olderThan: Date.now() - STALE_AFTER_MS }).catch(() => undefined);

// Stop when the session ends, so the next session can use the port and no browser is left running.
const shutdown = () => void Promise.allSettled([bridge.stop(), browser.close()]).finally(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
