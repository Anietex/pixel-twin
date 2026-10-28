import type { PluginMethods } from '@pixel-twin/shared';
import { loadNode, requireString } from './loadNode';

export async function exportNode(api: PluginAPI, params: PluginMethods['exportNode']['params']): Promise<PluginMethods['exportNode']['result']> {
  const node = await loadNode(api, requireString(params.nodeId, 'layer id'));
  if (!('exportAsync' in node)) throw new Error(`Layer ${node.id} cannot be exported.`);
  const scene = node as SceneNode;
  if (params.format === 'SVG') return { svg: await scene.exportAsync({ format: 'SVG_STRING' }) };
  if (params.format !== 'PNG' && params.format !== 'JPG') throw new Error('The export format must be PNG, JPG or SVG.');
  if (typeof params.scale !== 'number' || !(params.scale > 0)) throw new Error('The export scale must be a number above 0.');
  // The picture covers the layer's own box, not shadows or overflow outside it, so it lines up with the build.
  const bytes = await scene.exportAsync({ format: params.format, constraint: { type: 'SCALE', value: params.scale }, useAbsoluteBounds: true });
  return { base64: api.base64Encode(bytes) };
}
