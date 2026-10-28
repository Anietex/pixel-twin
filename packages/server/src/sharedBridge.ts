import type { PluginMethod, PluginMethods } from '@pixel-twin/shared';
import { PluginBridge, type Bridge, type ConnectedFile } from './bridge';
import { PluginGoneError, PortInUseError } from './errors';
import { RelayBridge, ShareError } from './relay';

/** How often to try again while neither owning nor sharing the plugin port works (ms). */
export const RETRY_MS = 3000;
/** After the owner leaves, each session waits a random time up to this before taking over, so one wins (ms). */
const TAKEOVER_SPREAD_MS = 400;

type Options = { port: number; hosts: string[]; timeoutMs: number; secret: string; retryMs?: number };

/**
 * The connection to Figma for one session. The first session to start owns the plugin port. Later
 * sessions share it: they pass their requests through the owner. When the owner's session ends, one of the
 * others takes the port over within a few seconds, and the plugin reconnects to it by itself.
 */
export class SharedBridge implements Bridge {
  private current: PluginBridge | RelayBridge | null = null;
  private problemNow: Error | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attaching: Promise<void> | null = null;

  constructor(private opts: Options) {}

  /** Owns or shares the port. Never fails for a busy port: it reports the problem and keeps trying. */
  async start(): Promise<void> {
    await this.attach();
  }

  private attach(): Promise<void> {
    this.attaching ??= this.tryAttach().finally(() => { this.attaching = null; });
    return this.attaching;
  }

  private async tryAttach(): Promise<void> {
    if (this.stopped || this.current) return;
    const own = new PluginBridge(this.opts);
    try {
      await own.start();
      this.use(own);
      return;
    } catch (err) {
      if (!(err instanceof PortInUseError)) throw err;
    }
    const relay = new RelayBridge(this.opts);
    try {
      await relay.connect();
      if (this.stopped) {
        relay.close();
        return;
      }
      relay.onClosed(() => this.ownerLeft());
      this.use(relay);
    } catch (err) {
      // Any other failure means the port's holder doesn't speak Pixel Twin's sharing protocol.
      this.problemNow = err instanceof ShareError ? err
        : new ShareError(`Port ${this.opts.port} is in use, but not by a Pixel Twin session that can share it: an older Pixel Twin build, or another program.`);
      this.retryIn(this.opts.retryMs ?? RETRY_MS);
    }
  }

  private use(bridge: PluginBridge | RelayBridge): void {
    this.current = bridge;
    this.problemNow = null;
  }

  private ownerLeft(): void {
    this.current = null;
    this.problemNow = new ShareError('The Pixel Twin session that held the Figma connection closed. This session is taking it over: try again in a few seconds.');
    this.retryIn(Math.random() * TAKEOVER_SPREAD_MS);
  }

  private retryIn(ms: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attach().catch((err: unknown) => {
        this.problemNow = err instanceof Error ? err : new Error(String(err));
        this.retryIn(this.opts.retryMs ?? RETRY_MS);
      });
    }, ms);
  }

  /** Why the tools can't reach Figma right now, or null when they can. */
  problem(): Error | null {
    return this.current ? null : this.problemNow;
  }

  role(): 'own' | 'shared' | 'none' {
    return this.current ? this.current.role() : 'none';
  }

  /** The port this session listens on, when it owns it. */
  get port(): number {
    return this.current instanceof PluginBridge ? this.current.port : this.opts.port;
  }

  files(): ConnectedFile[] {
    return this.current?.files() ?? [];
  }

  unintroduced(): number {
    return this.current?.unintroduced() ?? 0;
  }

  call<M extends PluginMethod>(connectionId: string, method: M, params: PluginMethods[M]['params'], options?: { timeoutMs?: number }): Promise<PluginMethods[M]['result']> {
    return this.current ? this.current.call(connectionId, method, params, options) : Promise.reject(new PluginGoneError());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const current = this.current;
    this.current = null;
    if (current instanceof PluginBridge) await current.stop();
    else current?.close();
  }
}
