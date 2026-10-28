import type { FigmaLink } from '@pixel-twin/shared';
import type { Bridge, ConnectedFile } from './bridge';
import { AmbiguousFileError, NodeNotFoundError, NoPluginError } from './errors';

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Finds the open Figma file that a link points to. */
export async function pickFile(bridge: Bridge, link: FigmaLink): Promise<ConnectedFile> {
  const files = bridge.files();

  const byKey = files.find((f) => f.fileKey !== null && f.fileKey === link.fileKey);
  if (byKey) return byKey;

  // Only files that report no fileKey can match by name. A different key means a different file.
  const slug = normalize(link.fileSlug);
  const named = files.filter((f) => f.fileKey === null && normalize(f.fileName) === slug);
  let candidates = named;

  if (link.nodeId !== null) {
    const nodeId = link.nodeId;
    // A plugin that fails or times out counts as "node not found".
    const checks = await Promise.allSettled(
      named.map((f) => bridge.call(f.connectionId, 'hasNode', { nodeId })),
    );
    candidates = named.filter((_, i) => {
      const c = checks[i];
      return c.status === 'fulfilled' && c.value.exists;
    });
    if (candidates.length === 0 && named.length === 1) throw new NodeNotFoundError(named[0].fileName, nodeId);
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new NoPluginError(link.fileSlug);
  throw new AmbiguousFileError(candidates.map((f) => f.fileName));
}
