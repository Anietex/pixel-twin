import WebSocket from 'ws';
import type { Hello, PluginMethod, PluginRequest, PluginResponse } from '@pixel-twin/shared';

export type FakeHandler = (method: PluginMethod, params: unknown) => unknown | Promise<unknown>;

/** Connects like the Figma plugin does: sends hello, then answers requests. Resolves once connected. */
export async function fakePlugin(
  port: number,
  hello: Hello, handler: FakeHandler,
  options: { origin?: string } = {},
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, options.origin === undefined ? {} : { origin: options.origin });
  socket.on('message', async (raw) => {
    const req = JSON.parse(raw.toString()) as PluginRequest;
    if (req.type !== 'request') return;
    let reply: PluginResponse;
    try {
      reply = { type: 'response', id: req.id, ok: true, result: await handler(req.method, req.params) };
    } catch (err) {
      reply = { type: 'response', id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify(hello));
      resolve();
    });
    socket.once('error', reject);
  });
  return socket;
}
