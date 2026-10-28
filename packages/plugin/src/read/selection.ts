import type { FigmaSelection } from '@pixel-twin/shared';
import { describeNode } from './outline';

/** At most this many selected layers are described; `total` gives the full count. */
export const MAX_SELECTED = 50;

/** The names of the layers between the page and this layer, top first. */
function pathOf(node: BaseNode): string[] {
  const names: string[] = [];
  for (let up = node.parent; up && up.type !== 'PAGE' && up.type !== 'DOCUMENT'; up = up.parent) names.unshift(up.name);
  return names;
}

/** What the owner has selected on the page they are on. It only reads the selection; it never changes it. */
export function getSelection(api: PluginAPI): FigmaSelection {
  const page = api.currentPage;
  const picked = page.selection;
  return {
    pageId: page.id,
    pageName: page.name,
    total: picked.length,
    layers: picked.slice(0, MAX_SELECTED).map((node) => ({ ...describeNode(node, 0), path: pathOf(node) })),
  };
}
