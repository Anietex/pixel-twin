import type { PluginMethods } from '@pixel-twin/shared';
import { loadNode, requireString } from './loadNode';

export async function getNodeJson(api: PluginAPI, params: PluginMethods['getNodeJson']['params']) {
  const node = await loadNode(api, requireString(params.nodeId, 'layer id'));
  if (!('exportAsync' in node)) throw new Error(`Layer ${node.id} cannot be read as JSON.`);
  const json = await (node as SceneNode).exportAsync({ format: 'JSON_REST_V1' });
  return { document: (json as { document: unknown }).document ?? json } as PluginMethods['getNodeJson']['result'];
}
