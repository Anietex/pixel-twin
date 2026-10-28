export interface LinkedStyle { layerId: string; kind: string; name: string }

interface StyledNode { id: string; visible?: boolean; styles?: Record<string, string>; children?: StyledNode[] }

/** Lists the Figma styles linked to visible layers. `kind` is the property the style fills (fill, text, stroke...). */
export function collectStyles(
  document: unknown,
  stylesMap: Record<string, { name?: string }> | undefined,
): LinkedStyle[] {
  const out: LinkedStyle[] = [];
  const walk = (node: StyledNode) => {
    if (node.visible === false) return;
    for (const [kind, styleId] of Object.entries(node.styles ?? {})) {
      out.push({ layerId: node.id, kind, name: stylesMap?.[styleId]?.name ?? styleId });
    }
    node.children?.forEach(walk);
  };
  walk(document as StyledNode);
  return out;
}
