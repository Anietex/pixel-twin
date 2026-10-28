import type { Layer } from './types';

export type AssetPlan =
  // adjusted: the image is moved, scaled, rotated or filtered inside a frame that has children, so the
  // original file is exported and the agent places it with the crop values from get_section.
  | { layerId: string; layerName: string; kind: 'image-original'; imageRef: string; adjusted?: true }
  | { layerId: string; layerName: string; kind: 'image-render' }
  | { layerId: string; layerName: string; kind: 'svg' };

const SHAPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'REGULAR_POLYGON', 'LINE', 'ELLIPSE']);
const WRAPPERS = new Set(['GROUP', 'FRAME', 'INSTANCE', 'COMPONENT']);

type ImageFill = Extract<Layer['fills'][number], { type: 'image' }>;
const imageFill = (layer: Layer): ImageFill | undefined =>
  layer.fills.find((f): f is ImageFill => f.type === 'image');

/** Counts shapes when the whole subtree is vector art. Returns null when anything else is in it. */
function vectorShapes(layer: Layer): { shapes: number; nonEllipse: number } | null {
  if (imageFill(layer)) return null;
  if (SHAPES.has(layer.type)) return { shapes: 1, nonEllipse: layer.type === 'ELLIPSE' ? 0 : 1 };
  if (!WRAPPERS.has(layer.type) || layer.children.length === 0) return null;
  let shapes = 0;
  let nonEllipse = 0;
  for (const child of layer.children) {
    const r = vectorShapes(child);
    if (!r) return null;
    shapes += r.shapes;
    nonEllipse += r.nonEllipse;
  }
  return { shapes, nonEllipse };
}

/**
 * True for a layer that only lays out several icons: auto layout with two or more children, or two or
 * more component instances. Each icon then becomes its own SVG, not one SVG of the whole row.
 */
function holdsSeparateIcons(layer: Layer): boolean {
  if (layer.children.length < 2) return false;
  return layer.layout.mode !== 'none' || layer.children.filter((c) => c.type === 'INSTANCE').length >= 2;
}

/** Decides which layers become files: original images, rendered images and SVG icons, one icon per file. Document order. */
export function planAssets(root: Layer): AssetPlan[] {
  const plans: AssetPlan[] = [];
  const visit = (layer: Layer): void => {
    const vec = vectorShapes(layer);
    if (vec && vec.nonEllipse > 0 && !holdsSeparateIcons(layer)) {
      plans.push({ layerId: layer.id, layerName: layer.name, kind: 'svg' });
      return; // everything inside is part of the SVG
    }
    const fill = imageFill(layer);
    if (fill) {
      // A moved, rotated or filtered image no longer looks like its original file.
      const original = (fill.scaleMode === 'FILL' || fill.scaleMode === 'FIT') && !fill.transformed && !fill.filters;
      if (original) {
        plans.push({ layerId: layer.id, layerName: layer.name, kind: 'image-original', imageRef: fill.imageRef });
      } else if (layer.children.length === 0) {
        plans.push({ layerId: layer.id, layerName: layer.name, kind: 'image-render' });
      } else {
        // A render would bake the children into the picture and hide them from compare.
        plans.push({ layerId: layer.id, layerName: layer.name, kind: 'image-original', imageRef: fill.imageRef, adjusted: true });
      }
    }
    layer.children.forEach(visit);
  };
  visit(root);
  return plans;
}

/** Ids of layers drawn inside an svg or image-render asset. The asset layer itself is not included: the build must still place it. */
export function assetCoveredIds(root: Layer, plans: AssetPlan[]): Set<string> {
  const rendered = new Set(plans.filter((p) => p.kind !== 'image-original').map((p) => p.layerId));
  const covered = new Set<string>();
  const add = (layer: Layer): void => { covered.add(layer.id); layer.children.forEach(add); };
  const visit = (layer: Layer): void => {
    if (rendered.has(layer.id)) layer.children.forEach(add);
    else layer.children.forEach(visit);
  };
  visit(root);
  return covered;
}

/** File-name part for a layer: lower-case letters and digits joined by '-'. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
}

export interface ImageInfo { ext: 'png' | 'jpg' | 'gif' | 'webp'; width: number; height: number }

/** Reads the type and pixel size from the first bytes of an image. Returns null for an unknown type. */
export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    // The size sits in the IHDR block: length (4), 'IHDR' (4), width (4), height (4).
    if (b.length < 24 || b.readUInt32BE(8) !== 13 || b.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.subarray(0, 3).toString('latin1') === 'GIF') {
    return { ext: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (b.length >= 30 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return webpSize(b);
  }
  return null;
}

function jpegSize(b: Buffer): ImageInfo {
  let i = 2;
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { ext: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { ext: 'jpg', width: 0, height: 0 };
}

function webpSize(b: Buffer): ImageInfo {
  const kind = b.subarray(12, 16).toString('latin1');
  if (kind === 'VP8X') return { ext: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { ext: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return { ext: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
}
