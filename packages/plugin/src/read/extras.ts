import type { LayerExtra, PluginMethods } from '@pixel-twin/shared';
import { loadNode, requireString } from './loadNode';

const STYLE_FIELDS = [
  ['fillStyleId', 'fill'], ['strokeStyleId', 'stroke'], ['effectStyleId', 'effect'], ['gridStyleId', 'grid'], ['textStyleId', 'text'],
] as const;

/**
 * For each rotated or styled layer in the subtree: its rotation in degrees, its size before rotating,
 * and the names of the styles linked to it. Text with several text styles lists each one.
 */
export async function getLayerExtras(api: PluginAPI, params: PluginMethods['getLayerExtras']['params']): Promise<LayerExtra[]> {
  const node = await loadNode(api, requireString(params.nodeId, 'layer id'));
  const names = new Map<string, string | null>();
  const nameOf = async (id: string): Promise<string | null> => {
    if (!names.has(id)) {
      const style = await api.getStyleByIdAsync(id);
      names.set(id, style ? style.name : null);
    }
    return names.get(id) ?? null;
  };
  const out: LayerExtra[] = [];
  const visit = async (n: SceneNode): Promise<void> => {
    const styles: LayerExtra['styles'] = [];
    for (const [field, kind] of STYLE_FIELDS) {
      if (!(field in n)) continue;
      const value = (n as unknown as Record<string, unknown>)[field];
      let ids: string[] = [];
      if (typeof value === 'string' && value) ids = [value];
      else if (value === api.mixed && field === 'textStyleId' && n.type === 'TEXT') {
        ids = [...new Set(n.getStyledTextSegments(['textStyleId']).map((s) => s.textStyleId).filter((id) => id !== ''))];
      }
      for (const id of ids) {
        const name = await nameOf(id);
        if (name) styles.push({ kind, id, name });
      }
    }
    const rotation = 'rotation' in n ? n.rotation : 0;
    if (Math.abs(rotation) > 1e-6 || styles.length > 0) out.push({ id: n.id, rotation, width: n.width, height: n.height, styles });
    if ('children' in n) for (const child of n.children) await visit(child);
  };
  if (node.type === 'PAGE') for (const child of node.children) await visit(child);
  else if (node.type !== 'DOCUMENT') await visit(node as SceneNode);
  return out;
}
