import { getImageBytes } from './read/images';
import { exportNode } from './read/export';
import { getLayerExtras } from './read/extras';
import { getMotion } from './read/motion';
import { getNodeJson } from './read/nodeJson';
import { getOutline } from './read/outline';
import { listSections } from './read/sections';
import { getSelection } from './read/selection';
import { getTextDetails } from './read/text';
import { resolveVariables } from './read/variables';
import { pageOf, requireString } from './read/loadNode';

/** Read-only requests from the server. Never create or change nodes here. */
export async function handleRequest(api: PluginAPI, method: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as any;
  switch (method) {
    case 'hasNode': {
      const node = await api.getNodeByIdAsync(requireString(p.nodeId, 'layer id'));
      if (!node) return { exists: false, pageId: null };
      const page = pageOf(node);
      return { exists: true, pageId: page ? page.id : null };
    }
    case 'getOutline': return getOutline(api, p);
    case 'getNodeJson': return getNodeJson(api, p);
    case 'getTextDetails': return getTextDetails(api, p);
    case 'listSections': return listSections(api, p);
    case 'exportNode': return exportNode(api, p);
    case 'getImageBytes': return getImageBytes(api, p);
    case 'resolveVariables': return resolveVariables(api, p);
    case 'getLayerExtras': return getLayerExtras(api, p);
    case 'getMotion': return getMotion(api, p);
    case 'getSelection': return getSelection(api);
    default:
      throw new Error(`Unknown request: ${method}`);
  }
}
