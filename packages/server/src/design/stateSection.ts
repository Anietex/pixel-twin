import type { Layer, SectionData } from './types';

/**
 * The key of each layer under the root: the names on the way down, with a number for same-named
 * siblings ("Label#0"). Figma's Smart Animate pairs layers between states the same way.
 */
function pathKeys(root: Layer): Map<Layer, string> {
  const keys = new Map<Layer, string>();
  const visit = (layer: Layer, key: string): void => {
    keys.set(layer, key);
    const seen = new Map<string, number>();
    for (const child of layer.children) {
      const n = seen.get(child.name) ?? 0;
      seen.set(child.name, n + 1);
      visit(child, `${key}/${child.name}#${n}`);
    }
  };
  visit(root, '');
  return keys;
}

/**
 * The design of a state (such as the Hover variant), with each layer given the id of the matching layer
 * in the section the page shows, so the page's data-figma-id attributes pair with it. Layers pair by
 * their name path. A layer only the state has keeps its own id; the root always pairs with the root.
 */
export function asState(state: SectionData, shown: SectionData): SectionData {
  const idByKey = new Map([...pathKeys(shown.root)].map(([layer, key]) => [key, layer.id]));
  const renamed = new Map<string, string>();
  const copy = (layer: Layer, key: Map<Layer, string>): Layer => {
    const id = idByKey.get(key.get(layer)!) ?? layer.id;
    renamed.set(layer.id, id);
    return { ...layer, id, children: layer.children.map((c) => copy(c, key)) };
  };
  const root = copy(state.root, pathKeys(state.root));
  return {
    ...state, rootId: shown.rootId, root,
    warnings: state.warnings.map((w) => ({ ...w, layerId: renamed.get(w.layerId) ?? w.layerId })),
  };
}
