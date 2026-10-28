import type { LayerExtra } from '@pixel-twin/shared';
import type { LinkedStyle } from './styles';
import type { Layer } from './types';

/**
 * Puts each rotated layer's angle and size before rotating on it, and lists the names of the styles
 * linked to visible layers. Hidden layers are not in the tree, so their extras are ignored.
 */
export function applyExtras(root: Layer, extras: LayerExtra[]): LinkedStyle[] {
  const byId = new Map(extras.map((e) => [e.id, e]));
  const styles: LinkedStyle[] = [];
  const visit = (layer: Layer): void => {
    const extra = byId.get(layer.id);
    if (extra) {
      if (Math.abs(extra.rotation) > 1e-6) {
        layer.rotation = extra.rotation;
        layer.size = { width: extra.width, height: extra.height };
      }
      for (const s of extra.styles) styles.push({ layerId: layer.id, kind: s.kind, name: s.name });
    }
    layer.children.forEach(visit);
  };
  visit(root);
  return styles;
}
