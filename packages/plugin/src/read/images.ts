import type { PluginMethods } from '@pixel-twin/shared';
import { requireString } from './loadNode';

export async function getImageBytes(api: PluginAPI, params: PluginMethods['getImageBytes']['params']) {
  const hash = requireString(params.imageHash, 'image hash');
  const image = api.getImageByHash(hash);
  if (!image) throw new Error(`Image ${hash} not found`);
  return { base64: api.base64Encode(await image.getBytesAsync()) };
}
