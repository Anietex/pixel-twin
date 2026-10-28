import type { FrameSections, PluginMethods } from '@pixel-twin/shared';
import { loadNode, requireString } from './loadNode';

const FRAME_TYPES = ['FRAME', 'COMPONENT', 'SECTION'];
const SECTION_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE', 'SECTION'];

export async function listSections(api: PluginAPI, params: PluginMethods['listSections']['params']): Promise<FrameSections[]> {
  const page = await loadNode(api, requireString(params.pageId, 'page id'));
  if (page.type !== 'PAGE') throw new Error(`Layer ${page.id} is not a page.`);
  return page.children
    .filter((f) => FRAME_TYPES.includes(f.type))
    .map((f) => {
      const frame = f as FrameNode;
      return {
        frameId: frame.id,
        frameName: frame.name,
        frameWidth: frame.width,
        sections: frame.children
          .filter((s) => SECTION_TYPES.includes(s.type))
          .map((s) => ({
            id: s.id,
            name: s.name,
            texts: (s as FrameNode).findAllWithCriteria({ types: ['TEXT'] }).map((t) => (t as TextNode).characters),
          })),
      };
    });
}
