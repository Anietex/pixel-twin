import type WebSocket from 'ws';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Hello } from '@pixel-twin/shared';
import type { PluginBridge } from '../../src/bridge';
import type { BrowserProvider } from '../../src/browser/launch';
import { createPixelTwinServer, type ServerDeps } from '../../src/createServer';
import { fakePlugin, type FakeHandler } from './fakePlugin';

/** A browser for tests that never open a page. */
export const noBrowser: BrowserProvider = {
  open: async () => { throw new Error('This test has no browser.'); },
  close: async () => undefined,
};

export async function connectTestClient(deps: ServerDeps): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createPixelTwinServer(deps).connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

/** Starts a fake plugin and waits until the bridge lists it. The hello gets the bridge's secret. */
export async function startFakePlugin(
  bridge: PluginBridge,
  hello: Omit<Hello, 'secret'> & { secret?: string },
  handler: FakeHandler,
  secret = 'test-secret',
): Promise<WebSocket> {
  const before = bridge.files().length;
  const socket = await fakePlugin(bridge.port, { ...hello, secret: hello.secret ?? secret }, handler);
  const end = Date.now() + 2000;
  while (bridge.files().length <= before) {
    if (Date.now() > end) throw new Error('timed out waiting for the plugin to register');
    await new Promise((r) => setTimeout(r, 10));
  }
  return socket;
}
