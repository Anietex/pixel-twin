import type { OutlineNode, PluginMethods } from '@pixel-twin/shared';
import { loadNode, requireString } from './loadNode';

type Params = PluginMethods['getOutline']['params'];

/** A layer's name, type, position (inside its parent) and size, with its children down to `depth` levels. */
export function describeNode(node: BaseNode, depth: number): OutlineNode {
  const n = node as BaseNode & Partial<SceneNode>;
  const kids = 'children' in node ? (node as ChildrenMixin).children : [];
  const out: OutlineNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: n.x ?? 0,
    y: n.y ?? 0,
    width: n.width ?? 0,
    height: n.height ?? 0,
    visible: n.visible ?? true,
    childCount: kids.length,
  };
  if (depth > 0 && kids.length > 0) out.children = kids.map((k) => describeNode(k, depth - 1));
  return out;
}

export async function getOutline(api: PluginAPI, params: Params): Promise<OutlineNode[]> {
  if (params.nodeId === null || params.nodeId === undefined) {
    // Pages are listed without loading them.
    return api.root.children.map((p) => ({
      id: p.id, name: p.name, type: 'PAGE', x: 0, y: 0, width: 0, height: 0, visible: true, childCount: 0,
    }));
  }
  const nodeId = requireString(params.nodeId, 'layer id');
  const depth = typeof params.depth === 'number' && params.depth > 0 ? Math.floor(params.depth) : 0;
  return [describeNode(await loadNode(api, nodeId), depth)];
}
