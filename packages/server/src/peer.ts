import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PluginMethod } from '@pixel-twin/shared';
import type { ConnectedFile } from './bridge';

/**
 * Messages between Pixel Twin servers. The first server to start owns the plugin port. Servers of later
 * sessions connect to it as peers and pass their requests through it, so many sessions share one plugin.
 *
 * Neither side ever sends the secret. Each proves it knows it by answering the other's random challenge:
 * 1. peer → owner: peer-hello with the peer's challenge.
 * 2. owner → peer: peer-challenge with the owner's proof and the owner's challenge. The peer checks the
 *    proof, and closes if it is wrong: whatever holds the port is not a Pixel Twin server with this secret.
 * 3. peer → owner: peer-proof. The owner checks it, then sends the file list (peer-files).
 * Raise PEER_PROTOCOL whenever these messages change: servers of different builds then refuse to share.
 */
export const PEER_PROTOCOL = 2;

/** A connected file as it travels between servers: the date becomes text. */
export type WireFile = Omit<ConnectedFile, 'connectedAt'> & { connectedAt: string };

export type PeerHello = { type: 'peer-hello'; protocol: number; challenge?: string };
export type PeerChallenge = { type: 'peer-challenge'; proof: string; challenge: string };
export type PeerProof = { type: 'peer-proof'; proof: string };
export type PeerRequest = { type: 'peer-request'; id: string; connectionId: string; method: PluginMethod; params: unknown; timeoutMs: number };
/** Sent by the owner: once the peer's proof is checked, and every time the list of connected files changes. */
export type PeerFiles = { type: 'peer-files'; files: WireFile[]; unintroduced: number };
export type PeerRefused = { type: 'peer-refused'; reason: string };
export type PeerResponse =
  | { type: 'peer-response'; id: string; ok: true; result: unknown }
  | { type: 'peer-response'; id: string; ok: false; error: string; errorName: string };

/** The longest wait a peer may ask for (ms). */
export const MAX_PEER_TIMEOUT_MS = 10 * 60_000;

export const toWire = (f: ConnectedFile): WireFile => ({ ...f, connectedAt: f.connectedAt.toISOString() });
export const fromWire = (f: WireFile): ConnectedFile => ({ ...f, connectedAt: new Date(f.connectedAt) });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A fresh random challenge: 32 bytes as hex. */
export const newChallenge = (): string => randomBytes(32).toString('hex');
const CHALLENGE = /^[0-9a-f]{64}$/;

/** The answer to `challenge` that only a holder of `secret` can give. The side's name keeps one side's answer from serving as the other's. */
export function proofOf(secret: string, side: 'owner' | 'peer', challenge: string): string {
  return createHmac('sha256', secret).update(`pixel-twin ${side} ${challenge}`).digest('hex');
}

/** Compares two proofs in constant time. */
export function proofMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checks a message a peer sent to the owner. Anything malformed is null. */
export function parsePeerMessage(m: Record<string, unknown>): PeerHello | PeerProof | PeerRequest | null {
  if (m.type === 'peer-hello') {
    // The challenge is checked only for this build's protocol, so an older build is told it differs.
    const ok = typeof m.protocol === 'number' && (m.protocol !== PEER_PROTOCOL || (typeof m.challenge === 'string' && CHALLENGE.test(m.challenge)));
    return ok ? (m as unknown as PeerHello) : null;
  }
  if (m.type === 'peer-proof') return typeof m.proof === 'string' ? (m as unknown as PeerProof) : null;
  if (m.type === 'peer-request') {
    const ok = typeof m.id === 'string' && typeof m.connectionId === 'string' && typeof m.method === 'string'
      && typeof m.timeoutMs === 'number' && Number.isFinite(m.timeoutMs) && m.timeoutMs > 0 && m.timeoutMs <= MAX_PEER_TIMEOUT_MS;
    return ok ? (m as unknown as PeerRequest) : null;
  }
  return null;
}

/** Checks a message the owner sent to a peer. Anything malformed is null. */
export function parseOwnerMessage(text: string): PeerChallenge | PeerFiles | PeerRefused | PeerResponse | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(m)) return null;
  if (m.type === 'peer-files') {
    const files = m.files;
    const ok = Array.isArray(files) && typeof m.unintroduced === 'number' && files.every((f) => isObject(f)
      && typeof f.connectionId === 'string' && typeof f.fileName === 'string' && typeof f.editorType === 'string'
      && (typeof f.fileKey === 'string' || f.fileKey === null) && typeof f.connectedAt === 'string');
    return ok ? (m as unknown as PeerFiles) : null;
  }
  if (m.type === 'peer-refused') return typeof m.reason === 'string' ? (m as unknown as PeerRefused) : null;
  if (m.type === 'peer-challenge') {
    return typeof m.proof === 'string' && typeof m.challenge === 'string' && CHALLENGE.test(m.challenge) ? (m as unknown as PeerChallenge) : null;
  }
  if (m.type === 'peer-response') {
    if (typeof m.id !== 'string' || typeof m.ok !== 'boolean') return null;
    if (!m.ok && (typeof m.error !== 'string' || typeof m.errorName !== 'string')) return null;
    return m as unknown as PeerResponse;
  }
  return null;
}
