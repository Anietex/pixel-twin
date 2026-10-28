import type { PluginMethods, TextDetail } from '@pixel-twin/shared';
import { loadNode, requireString } from './loadNode';

export async function getTextDetails(api: PluginAPI, params: PluginMethods['getTextDetails']['params']): Promise<TextDetail[]> {
  const node = await loadNode(api, requireString(params.nodeId, 'layer id'));
  const texts: TextNode[] = [];
  if (node.type === 'TEXT') texts.push(node);
  if ('findAllWithCriteria' in node) texts.push(...(node as FrameNode).findAllWithCriteria({ types: ['TEXT'] }));
  return texts.map((t) => {
    const seen = new Map<string, { family: string; style: string; weight: number }>();
    for (const seg of t.getStyledTextSegments(['fontName', 'fontWeight'])) {
      const key = `${seg.fontName.family}|${seg.fontName.style}|${seg.fontWeight}`;
      if (!seen.has(key)) seen.set(key, { family: seg.fontName.family, style: seg.fontName.style, weight: seg.fontWeight });
    }
    return { id: t.id, hasMissingFont: t.hasMissingFont, fonts: [...seen.values()] };
  });
}
