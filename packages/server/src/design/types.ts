import type { LayerMotion, ResolvedVariable } from '@pixel-twin/shared';

export interface Color { hex: string; alpha: number }                      // hex '#RRGGBB' upper-case, alpha rounded to 2 dp
export type Fill =
  | { type: 'solid'; color: Color }
  | { type: 'gradient'; kind: 'linear' | 'radial' | 'angular' | 'diamond'; stops: { color: Color; position: number }[]; angleDeg: number }
  | { type: 'image'; imageRef: string; scaleMode: string; transformed: boolean } & ImagePlacement;
/**
 * Where an image sits inside its layer, when Figma moved, scaled, rotated or filtered it.
 * - crop: the part of the image shown, as shares of the image's width and height (0..1).
 * - css: background-size and background-position that show the same part, when the image is not rotated.
 * - filters: Figma's image adjustments (exposure, contrast, saturation, temperature, tint, highlights, shadows).
 */
export interface ImagePlacement {
  crop?: { x: number; y: number; width: number; height: number };
  css?: { backgroundSize: string; backgroundPosition: string };
  rotation?: number;
  filters?: Record<string, number>;
}
export interface Effect { type: 'drop-shadow' | 'inner-shadow' | 'layer-blur' | 'background-blur'; x: number; y: number; blur: number; spread: number; color: Color | null }
export interface TextRun { start: number; end: number; fontFamily: string; fontStyle: string; fontWeight: number; fontSize: number; lineHeightPx: number; letterSpacingPx: number; textCase: string; textDecoration: string; color: Color }
/**
 * The motion the designer set on a layer (see LayerMotion). `scroll` is fixed (stays put while the page
 * scrolls) or sticky (scrolls, then sticks at the top). `media` lists video and animated GIF fills.
 */
export type Motion = Omit<LayerMotion, 'id' | 'fixed' | 'media'> & {
  scroll?: 'fixed' | 'sticky';
  media?: { kind: 'video' | 'gif'; ref: string | null }[];
};
/** A stroke's `weights` are per side: top, right, bottom, left. */
export interface Layer {
  id: string; name: string; type: string;
  x: number; y: number; width: number; height: number;                     // relative to section top-left
  layout: { mode: 'row' | 'column' | 'none'; gap: number; padding: [number, number, number, number]; mainAlign: string; crossAlign: string; wrap: boolean; sizingH: string; sizingV: string; absolute: boolean };
  fills: Fill[]; strokes: { color: Color; weight: number; weights: [number, number, number, number]; align: string }[]; radius: [number, number, number, number];
  effects: Effect[]; opacity: number; blendMode: string; clips: boolean;
  // autoResize: WIDTH_AND_HEIGHT (box hugs the text), HEIGHT (fixed width), NONE (fixed box) or TRUNCATE.
  text: { characters: string; runs: TextRun[]; dominantRun: number; align: string; autoResize: string; lineCount: number; hasMissingFont: boolean } | null;
  // Set when the layer is rotated: its angle in degrees and its size before rotating. The box above is the rotated outline.
  rotation?: number; size?: { width: number; height: number };
  motion?: Motion;
  children: Layer[];
}
export interface SectionData { rootId: string; name: string; width: number; height: number; root: Layer;
  fonts: { family: string; style: string; weight: number; missingInFigma: boolean }[]; variables: ResolvedVariable[];
  warnings: { layerId: string; layerName: string; reason: string }[];
  // False when the plugin could not read motion; motionError says why. Interactions and states are then missing.
  motionRead?: boolean; motionError?: string }
