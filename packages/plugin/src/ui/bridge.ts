import type { Hello, PluginRequest, PluginResponse } from '@pixel-twin/shared';

/** waiting: no server. introducing: link open, hello not answered yet. connected: the server welcomed this file. */
export type BridgeStatus = 'waiting' | 'introducing' | 'connected';

export interface UiBridgeOptions {
  url: string;
  reconnectMs: number;
  WebSocketImpl: typeof WebSocket;
  postToMain(msg: PluginRequest): void;
  onStatus(s: BridgeStatus, fileName?: string): void;
}

/** Holds the WebSocket to the local server. Has no DOM globals, so it runs in Node tests. */
export function createUiBridge(opts: UiBridgeOptions): { fromMain(msg: Hello | PluginResponse): void; close(): void } {
  let hello: Hello | null = null;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const isOpen = () => socket !== null && socket.readyState === opts.WebSocketImpl.OPEN;

  function connect() {
    if (closed) return;
    const ws = new opts.WebSocketImpl(opts.url);
    socket = ws;
    ws.onopen = () => {
      opts.onStatus('introducing');
      if (hello) ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (event) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown; fileName?: unknown };
      if (m.type === 'request') opts.postToMain(msg as PluginRequest);
      else if (m.type === 'welcome' && typeof m.fileName === 'string') opts.onStatus('connected', m.fileName);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      opts.onStatus('waiting');
      if (!closed) timer = setTimeout(connect, opts.reconnectMs);
    };
    ws.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
  }

  connect();

  return {
    fromMain(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') {
        // Main sends the same hello each time it is asked. Keep the first one, so a later message
        // from another frame can't replace it.
        if (hello) return;
        hello = msg;
        if (isOpen()) socket!.send(JSON.stringify(msg));
      } else if (msg.type === 'response' && typeof msg.id === 'string' && isOpen()) {
        socket!.send(JSON.stringify(msg));
      }
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}
