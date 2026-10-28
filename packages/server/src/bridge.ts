import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Hello, PluginMethod, PluginMethods, PluginRequest, PluginResponse, Welcome } from '@pixel-twin/shared';
import { PluginError, PluginGoneError, PluginTimeoutError, PortInUseError } from './errors';
import {
  newChallenge, PEER_PROTOCOL, parsePeerMessage, proofMatches, proofOf, toWire,
  type PeerChallenge, type PeerFiles, type PeerHello, type PeerProof, type PeerRefused, type PeerRequest, type PeerResponse,
} from './peer';

/** How long to wait for Figma to export a picture: a tall page can take well over the usual 30 s. */
export const EXPORT_TIMEOUT_MS = 120_000;

export interface ConnectedFile {
  connectionId: string;
  fileName: string;
  fileKey: string | null;
  editorType: string;
  connectedAt: Date;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  socket: WebSocket;
  // 'unknown' until the first valid hello: a Figma plugin (hello) or another Pixel Twin server (peer-hello).
  kind: 'unknown' | 'plugin' | 'peer';
  file: ConnectedFile | null; // set when a plugin says hello
  challenge: string | null;   // set while a peer has yet to answer the owner's challenge
  pending: Map<string, Pending>;
}

/** What the tools need from the connection to Figma, whether this session owns it or shares another's. */
export interface Bridge {
  files(): ConnectedFile[];
  /** Open plugin connections that have not said which file they are in. */
  unintroduced(): number;
  call<M extends PluginMethod>(connectionId: string, method: M, params: PluginMethods[M]['params'], options?: { timeoutMs?: number }): Promise<PluginMethods[M]['result']>;
  /** 'own': this session holds the plugin port. 'shared': it passes requests through the session that does. */
  role?(): 'own' | 'shared' | 'none';
}

interface Listener {
  http: Server;
  wss: WebSocketServer;
  address: string;
}

/**
 * Owns the plugin port. Figma plugins connect to it, and so do the servers of other Pixel Twin sessions,
 * which pass their requests through it (see peer.ts). Both must give the shared secret.
 */
export class PluginBridge implements Bridge {
  private listeners: Listener[] = [];
  private connections = new Map<string, Connection>();
  private actualPort: number;

  constructor(private opts: { port: number; hosts: string[]; timeoutMs: number; secret: string }) {
    this.actualPort = opts.port;
  }

  get port(): number {
    return this.actualPort;
  }

  async start(): Promise<void> {
    try {
      for (const [i, host] of this.opts.hosts.entries()) {
        try {
          // Later hosts reuse the port the first host got (matters when port is 0).
          this.listeners.push(await this.listen(host, i === 0 ? this.opts.port : this.actualPort));
        } catch (err) {
          // A machine without IPv6 cannot bind ::1. Skip it if another host is already bound.
          if (i > 0 && (err as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') continue;
          throw err;
        }
        if (i === 0) this.actualPort = (this.listeners[0].http.address() as AddressInfo).port;
      }
    } catch (err) {
      await this.stop();
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(this.opts.port);
      throw err;
    }
  }

  async stop(): Promise<void> {
    for (const conn of this.connections.values()) conn.socket.terminate();
    const listeners = this.listeners;
    this.listeners = [];
    await Promise.all(
      listeners.map(
        (l) =>
          new Promise<void>((resolve) => {
            l.wss.close(() => l.http.close(() => resolve()));
            l.http.closeAllConnections();
          }),
      ),
    );
  }

  addresses(): string[] {
    return this.listeners.map((l) => l.address);
  }

  files(): ConnectedFile[] {
    return [...this.connections.values()].flatMap((c) => (c.file ? [c.file] : []));
  }

  /** Open connections that have not sent a valid hello yet. */
  unintroduced(): number {
    return [...this.connections.values()].filter((c) => c.kind === 'unknown').length;
  }

  role(): 'own' {
    return 'own';
  }

  /** How many other Pixel Twin servers share this connection. */
  peers(): number {
    return [...this.connections.values()].filter((c) => c.kind === 'peer').length;
  }

  /** Sends one request to a plugin. `timeoutMs` overrides the bridge's wait for slow requests such as big exports. */
  call<M extends PluginMethod>(
    connectionId: string,
    method: M,
    params: PluginMethods[M]['params'],
    options: { timeoutMs?: number } = {},
  ): Promise<PluginMethods[M]['result']> {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.file || conn.socket.readyState !== conn.socket.OPEN) return Promise.reject(new PluginGoneError());
    const id = randomUUID();
    const wait = options.timeoutMs ?? this.opts.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new PluginTimeoutError(method, wait));
      }, wait);
      conn.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const request: PluginRequest = { type: 'request', id, method, params };
      conn.socket.send(JSON.stringify(request), (err) => {
        if (!err) return;
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new PluginGoneError());
      });
    });
  }

  private listen(host: string, port: number): Promise<Listener> {
    return new Promise((resolve, reject) => {
      const http = createServer((_req, res) => {
        res.writeHead(426).end('Pixel Twin bridge: WebSocket only');
      });
      const wss = new WebSocketServer({
        server: http,
        // Figma plugin iframes send "Origin: null". A real web page sends its own origin: refuse it.
        verifyClient: ({ origin }: { origin?: string }) => origin === undefined || origin === 'null',
      });
      wss.on('connection', (socket) => this.onConnection(socket));
      wss.on('error', () => {}); // the http error below is what start() reports
      http.once('error', (err) => {
        wss.close();
        reject(err);
      });
      http.listen(port, host, () => {
        http.removeAllListeners('error');
        http.on('error', () => {});
        resolve({ http, wss, address: (http.address() as AddressInfo).address });
      });
    });
  }

  private onMessage(connectionId: string, conn: Connection, msg: Hello | PluginResponse | PeerHello | PeerProof | PeerRequest | null): void {
    if (!msg) return;
    if (msg.type === 'peer-hello') {
      if (conn.kind !== 'unknown' || conn.challenge) return;
      if (msg.protocol !== PEER_PROTOCOL) {
        const refused: PeerRefused = { type: 'peer-refused', reason: `This session runs Pixel Twin peer protocol ${PEER_PROTOCOL}; yours runs ${msg.protocol}` };
        conn.socket.send(JSON.stringify(refused), () => conn.socket.close(1008, 'Different build'));
        return;
      }
      // Prove this server knows the secret, and challenge the peer to prove it too. One try only.
      conn.challenge = newChallenge();
      const reply: PeerChallenge = { type: 'peer-challenge', proof: proofOf(this.opts.secret, 'owner', msg.challenge!), challenge: conn.challenge };
      conn.socket.send(JSON.stringify(reply));
      return;
    }
    if (msg.type === 'peer-proof') {
      if (conn.kind !== 'unknown' || !conn.challenge) return;
      const expected = proofOf(this.opts.secret, 'peer', conn.challenge);
      conn.challenge = null;
      if (!proofMatches(msg.proof, expected)) {
        conn.socket.close(1008, 'Wrong secret');
        return;
      }
      conn.kind = 'peer';
      conn.socket.send(JSON.stringify(this.fileList()));
      this.tellPeers();   // the unintroduced count changed
      return;
    }
    if (msg.type === 'hello') {
      if (conn.kind !== 'unknown' || conn.challenge) return;
      if (!secretMatches(msg.secret, this.opts.secret)) {
        conn.socket.close(1008, 'Wrong secret');
        return;
      }
      conn.kind = 'plugin';
      conn.file = {
        connectionId,
        fileName: msg.fileName,
        fileKey: msg.fileKey,
        editorType: msg.editorType,
        connectedAt: new Date(),
      };
      const welcome: Welcome = { type: 'welcome', fileName: msg.fileName };
      conn.socket.send(JSON.stringify(welcome));
      this.tellPeers();
      return;
    }
    if (msg.type === 'peer-request') {
      if (conn.kind === 'peer') this.relay(conn, msg);
      return;
    }
    if (conn.kind !== 'plugin') return; // only a plugin's responses count
    const pending = conn.pending.get(msg.id);
    if (!pending) return;
    conn.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new PluginError(msg.error));
  }

  /** Passes a peer's request to the plugin and sends back the answer, or the error with its kind. */
  private relay(peer: Connection, req: PeerRequest): void {
    const reply = (msg: PeerResponse) => {
      if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(JSON.stringify(msg));
    };
    this.call(req.connectionId, req.method, req.params as never, { timeoutMs: req.timeoutMs }).then(
      (result) => reply({ type: 'peer-response', id: req.id, ok: true, result }),
      (err: unknown) => reply({ type: 'peer-response', id: req.id, ok: false,
        error: err instanceof Error ? err.message : String(err), errorName: err instanceof Error ? err.name : 'Error' }),
    );
  }

  private fileList(): PeerFiles {
    return { type: 'peer-files', files: this.files().map(toWire), unintroduced: this.unintroduced() };
  }

  /** Sends the current file list to every peer. */
  private tellPeers(): void {
    const text = JSON.stringify(this.fileList());
    for (const c of this.connections.values()) {
      if (c.kind === 'peer' && c.socket.readyState === c.socket.OPEN) c.socket.send(text);
    }
  }

  private onConnection(socket: WebSocket): void {
    const connectionId = randomUUID();
    const conn: Connection = { socket, kind: 'unknown', file: null, challenge: null, pending: new Map() };
    this.connections.set(connectionId, conn);
    this.tellPeers();

    socket.on('message', (raw) => {
      try {
        this.onMessage(connectionId, conn, parseMessage(raw.toString()));
      } catch {
        // A bad message must never take the server down.
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => {
      this.connections.delete(connectionId);
      for (const pending of conn.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new PluginGoneError());
      }
      conn.pending.clear();
      if (conn.kind !== 'peer') this.tellPeers();
    });
  }
}

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns a well-formed plugin Hello or response, or peer message, or null for anything else. */
function parseMessage(text: string): Hello | PluginResponse | PeerHello | PeerProof | PeerRequest | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === 'hello') {
    const ok =
      typeof m.fileName === 'string' &&
      typeof m.editorType === 'string' &&
      (typeof m.fileKey === 'string' || m.fileKey === null) &&
      typeof m.pluginVersion === 'string' &&
      typeof m.secret === 'string';
    return ok ? (m as unknown as Hello) : null;
  }
  if (m.type === 'response') {
    if (typeof m.id !== 'string' || typeof m.ok !== 'boolean') return null;
    if (!m.ok && typeof m.error !== 'string') return null;
    return m as unknown as PluginResponse;
  }
  return parsePeerMessage(m);
}
