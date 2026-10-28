import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { PluginMethod, PluginMethods } from '@pixel-twin/shared';
import type { Bridge, ConnectedFile } from './bridge';
import { PluginError, PluginGoneError, PluginTimeoutError } from './errors';
import {
  fromWire, newChallenge, parseOwnerMessage, PEER_PROTOCOL, proofMatches, proofOf, type PeerHello, type PeerProof, type PeerRequest,
} from './peer';

/** How long the owner may take to welcome this session before sharing counts as failed (ms). */
export const WELCOME_TIMEOUT_MS = 2000;
/** Extra wait on top of the owner's own wait, in case the owner never answers (ms). */
const SAFETY_MS = 5000;

const NOT_SHAREABLE = (port: number) =>
  `Port ${port} is in use, but not by a Pixel Twin session that can share it: an older Pixel Twin build, or another program.`;
const UNPROVEN = (port: number) =>
  `The program on port ${port} could not prove it is a Pixel Twin session built with your secret: a different Pixel Twin build, or another program. `
  + 'Run npm run build in the Pixel Twin folder and restart the sessions. If that doesn\'t help, find out what uses the port.';

/** Why sharing failed, in plain words. */
export class ShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareError';
  }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string; timeoutMs: number }

/** Turns an error the owner reported back into the same kind of error, so retries and messages work alike. */
function rebuild(name: string, message: string, method: string, timeoutMs: number): Error {
  if (name === 'PluginError') return new PluginError(message);
  if (name === 'PluginGoneError') return new PluginGoneError();
  if (name === 'PluginTimeoutError') return new PluginTimeoutError(method, timeoutMs);
  return new Error(message);
}

/**
 * A session that shares another session's plugin connection: it connects to the server that owns the
 * plugin port, keeps the owner's list of open files, and sends its requests through the owner.
 * It never sends the secret: the owner must first prove it knows the secret (see peer.ts), and nothing
 * the program on the port says counts until it has.
 */
export class RelayBridge implements Bridge {
  private socket: WebSocket | null = null;
  private list: ConnectedFile[] = [];
  private silent = 0;
  private pending = new Map<string, Pending>();
  private closedHandlers: (() => void)[] = [];

  constructor(private opts: { port: number; hosts: string[]; timeoutMs: number; secret: string }) {}

  /** Connects to the owner and waits for its welcome. Throws a ShareError when it can't share. */
  async connect(): Promise<void> {
    let last: Error = new ShareError('No address to connect to');
    for (const host of this.opts.hosts) {
      try {
        await this.connectTo(host.includes(':') ? `[${host}]` : host);
        return;
      } catch (err) {
        last = err instanceof Error ? err : new Error(String(err));
        if (last instanceof ShareError) throw last;   // reached a server, and it said no
      }
    }
    throw last;
  }

  private connectTo(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}:${this.opts.port}`);
      const challenge = newChallenge();
      let ownerProved = false;
      let welcomed = false;
      const fail = (err: Error) => {
        if (welcomed) return;
        clearTimeout(timer);
        socket.terminate();
        reject(err);
      };
      const timer = setTimeout(() => fail(new ShareError(NOT_SHAREABLE(this.opts.port))), WELCOME_TIMEOUT_MS);
      socket.on('open', () => {
        const hello: PeerHello = { type: 'peer-hello', protocol: PEER_PROTOCOL, challenge };
        socket.send(JSON.stringify(hello));
      });
      socket.on('message', (raw) => {
        const msg = parseOwnerMessage(raw.toString());
        if (!msg) return;
        if (msg.type === 'peer-refused') {
          fail(new ShareError(`Another Pixel Twin session holds the Figma connection, but it is a different build (${msg.reason}). Restart that session so both use the same build.`));
          return;
        }
        if (msg.type === 'peer-challenge') {
          if (ownerProved) return;
          if (!proofMatches(msg.proof, proofOf(this.opts.secret, 'owner', challenge))) {
            fail(new ShareError(UNPROVEN(this.opts.port)));
            return;
          }
          ownerProved = true;
          const proof: PeerProof = { type: 'peer-proof', proof: proofOf(this.opts.secret, 'peer', msg.challenge) };
          socket.send(JSON.stringify(proof));
          return;
        }
        if (!ownerProved) return;   // nothing counts before the owner has proved it knows the secret
        if (msg.type === 'peer-files') {
          this.list = msg.files.map(fromWire);
          this.silent = msg.unintroduced;
          if (!welcomed) {
            welcomed = true;
            clearTimeout(timer);
            this.socket = socket;
            resolve();
          }
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(rebuild(msg.errorName, msg.error, p.method, p.timeoutMs));
      });
      socket.on('error', (err) => fail(err));
      socket.on('close', () => {
        if (!welcomed) {
          fail(new ShareError(ownerProved ? UNPROVEN(this.opts.port) : NOT_SHAREABLE(this.opts.port)));
          return;
        }
        this.lost();
      });
    });
  }

  /** The owner went away: every waiting request fails, and the handlers hear about it. */
  private lost(): void {
    this.socket = null;
    this.list = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new PluginGoneError());
    }
    this.pending.clear();
    for (const handler of this.closedHandlers) handler();
  }

  /** Runs `handler` once the connection to the owner closes. */
  onClosed(handler: () => void): void {
    this.closedHandlers.push(handler);
  }

  files(): ConnectedFile[] {
    return [...this.list];
  }

  unintroduced(): number {
    return this.silent;
  }

  role(): 'shared' {
    return 'shared';
  }

  call<M extends PluginMethod>(connectionId: string, method: M, params: PluginMethods[M]['params'], options: { timeoutMs?: number } = {}): Promise<PluginMethods[M]['result']> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new PluginGoneError());
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginTimeoutError(method, timeoutMs));
      }, timeoutMs + SAFETY_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method, timeoutMs });
      const request: PeerRequest = { type: 'peer-request', id, connectionId, method, params, timeoutMs };
      socket.send(JSON.stringify(request), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PluginGoneError());
      });
    });
  }

  /** Closes the connection to the owner without telling the handlers. */
  close(): void {
    this.closedHandlers = [];
    this.socket?.terminate();
    this.socket = null;
  }
}
