export interface FigmaLink {
  fileKey: string;
  fileSlug: string;
  nodeId: string | null;
}

const NOT_A_LINK = 'Not a Figma design link';

/** Figma URLs write node ids as "1-2"; the plugin API wants "1:2". */
export function toPluginNodeId(id: string): string {
  return id.replace(/-/g, ':');
}

/** A design link to one layer of a file, which parseFigmaLink reads back. The slug only names the file for people. */
export function figmaLink(fileKey: string, fileName: string, nodeId: string): string {
  const slug = encodeURIComponent(fileName.trim().replace(/\s+/g, '-')) || 'file';
  return `https://www.figma.com/design/${encodeURIComponent(fileKey)}/${slug}?node-id=${encodeURIComponent(nodeId.replace(/:/g, '-'))}`;
}

export function parseFigmaLink(url: string): FigmaLink {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(NOT_A_LINK);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'figma.com' && !host.endsWith('.figma.com')) throw new Error(NOT_A_LINK);

  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'design' && parts[0] !== 'file') throw new Error(NOT_A_LINK);

  // /design/:fileKey/branch/:branchKey/:slug  -> the branch key is the file to talk to
  let fileKey = parts[1];
  let slugIndex = 2;
  if (parts[2] === 'branch' && parts[3]) {
    fileKey = parts[3];
    slugIndex = 4;
  }
  if (!fileKey) throw new Error(NOT_A_LINK);

  const rawNode = parsed.searchParams.get('node-id');
  return {
    fileKey,
    fileSlug: parts[slugIndex] ?? '',
    nodeId: rawNode ? toPluginNodeId(rawNode) : null,
  };
}
