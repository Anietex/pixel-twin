import type { ResolvedVariable, TextDetail } from '@pixel-twin/shared';
import type { Effect as RestEffect, Paint, RGBA, SubcanvasNode, TypeStyle, Vector } from '@figma/rest-api-spec';
import type { Color, Effect, Fill, ImagePlacement, Layer, Motion, SectionData, TextRun } from './types.js';
import { WARNING } from './warnings.js';

type Warn = (reason: string) => void;

export type RestNode = SubcanvasNode;

/** The REST fields this file reads. Every node type has some of them, so all are optional. */
interface Rn {
  id: string; name: string; type: string; visible?: boolean;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  layoutMode?: string; primaryAxisAlignItems?: string; counterAxisAlignItems?: string;
  paddingTop?: number; paddingRight?: number; paddingBottom?: number; paddingLeft?: number;
  itemSpacing?: number; layoutWrap?: string; layoutSizingHorizontal?: string; layoutSizingVertical?: string;
  layoutPositioning?: string; rotation?: number;
  scrollBehavior?: string; overflowDirection?: string;
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  strokeTopWeight?: number; strokeRightWeight?: number; strokeBottomWeight?: number; strokeLeftWeight?: number;
  fills?: Paint[]; strokes?: Paint[]; strokeWeight?: number; strokeAlign?: string;
  cornerRadius?: number; rectangleCornerRadii?: number[];
  effects?: RestEffect[]; opacity?: number; blendMode?: string; clipsContent?: boolean;
  characters?: string; characterStyleOverrides?: number[]; styleOverrideTable?: Record<string, TypeStyle>;
  style?: TypeStyle;
  children?: Rn[];
}

type Box = { x: number; y: number; width: number; height: number };
type Tuple4 = [number, number, number, number];

const round2 = (n: number) => Math.round(n * 100) / 100;
const hex2 = (c: number) => Math.round(c * 255).toString(16).padStart(2, '0').toUpperCase();

function toColor(c: RGBA, paintOpacity = 1): Color {
  return { hex: `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`, alpha: round2(c.a * paintOpacity) };
}

const visible = <T extends { visible?: boolean }>(items: T[] | undefined): T[] =>
  (items ?? []).filter((i) => i.visible !== false);

const GRADIENT_KIND = {
  GRADIENT_LINEAR: 'linear', GRADIENT_RADIAL: 'radial', GRADIENT_ANGULAR: 'angular', GRADIENT_DIAMOND: 'diamond',
} as const;

/** CSS angle (0 = up, clockwise) of handle 0 -> handle 1, measured in pixels, not in 0..1 box units. */
function gradientAngle(handles: Vector[] | undefined, box: Box): number {
  if (!handles || handles.length < 2) return 0;
  const dx = (handles[1].x - handles[0].x) * box.width;
  const dy = (handles[1].y - handles[0].y) * box.height;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

const isIdentity = (t: number[][]) =>
  t.length === 2 && [[1, 0, 0], [0, 1, 0]].every((row, i) => row.every((v, j) => t[i]?.[j] === v));

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The part of the image Figma shows, from its imageTransform [[a, b, tx], [c, d, ty]], which maps the
 * layer's 0..1 box onto the image's 0..1 box. With no rotation (b = c = 0) the shown part starts at
 * (tx, ty) and is a × d of the image, and CSS can show the same part with background-size/position.
 */
function placement(t: number[][]): Pick<ImagePlacement, 'crop' | 'css'> {
  const [[a, b, tx], [c, d, ty]] = t;
  const crop = { x: r3(tx), y: r3(ty), width: r3(a), height: r3(d) };
  if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || a <= 0 || d <= 0) return { crop };
  const pos = (offset: number, share: number) => (Math.abs(1 - share) < 1e-6 ? 0 : r3((offset / (1 - share)) * 100));
  return { crop, css: {
    backgroundSize: `${r3(100 / a)}% ${r3(100 / d)}%`,
    backgroundPosition: `${pos(tx, a)}% ${pos(ty, d)}%`,
  } };
}

function toFill(p: Paint, box: Box, warn: Warn): Fill | null {
  const opacity = p.opacity ?? 1;
  if (p.type === 'SOLID') return { type: 'solid', color: toColor(p.color, opacity) };
  if (p.type === 'IMAGE') {
    const rotated = (p.rotation ?? 0) !== 0;
    const filters = Object.fromEntries(Object.entries(p.filters ?? {}).filter(([, v]) => typeof v === 'number' && v !== 0)) as Record<string, number>;
    const filtered = Object.keys(filters).length > 0;
    if (rotated || filtered) warn(WARNING.imageTransformed.reason);
    const t = p.imageTransform as number[][] | undefined;
    const moved = t !== undefined && !isIdentity(t);
    return { type: 'image', imageRef: p.imageRef, scaleMode: p.scaleMode, transformed: rotated || moved,
      ...(moved ? placement(t) : {}), ...(rotated ? { rotation: p.rotation } : {}), ...(filtered ? { filters } : {}) };
  }
  if (p.type in GRADIENT_KIND) {
    const g = p as Extract<Paint, { gradientStops: unknown }>;
    if (g.type === 'GRADIENT_DIAMOND') warn(WARNING.diamondGradient.reason);
    return { type: 'gradient', kind: GRADIENT_KIND[g.type], angleDeg: gradientAngle(g.gradientHandlePositions, box),
      stops: g.gradientStops.map((s) => ({ position: s.position, color: toColor(s.color, opacity) })) };
  }
  if (p.type === 'PATTERN') warn(WARNING.patternFill.reason);
  return null;
}

function toEffect(e: RestEffect, warn: Warn): Effect | null {
  switch (e.type) {
    case 'DROP_SHADOW':
    case 'INNER_SHADOW':
    case undefined:   // the spec allows an inner shadow with no type
      if (!('offset' in e)) return null;
      return { type: e.type === 'DROP_SHADOW' ? 'drop-shadow' : 'inner-shadow', x: e.offset.x, y: e.offset.y,
        blur: e.radius, spread: e.spread ?? 0, color: toColor(e.color) };
    case 'LAYER_BLUR':
    case 'BACKGROUND_BLUR':
      if ('blurType' in e && e.blurType === 'PROGRESSIVE') warn(WARNING.progressiveBlur.reason);
      return { type: e.type === 'LAYER_BLUR' ? 'layer-blur' : 'background-blur', x: 0, y: 0, blur: e.radius, spread: 0, color: null };
    case 'TEXTURE':
    case 'NOISE':
      warn(WARNING.textureNoise.reason);
      return null;
    default:
      return null;
  }
}

const ALIGN: Record<string, string> = {
  MIN: 'start', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'space-between', BASELINE: 'baseline',
};
const MODE = { HORIZONTAL: 'row', VERTICAL: 'column' } as const;

function toRadius(n: Rn): Tuple4 {
  const r = n.rectangleCornerRadii;
  if (r && r.length === 4) return [r[0], r[1], r[2], r[3]];
  const c = n.cornerRadius ?? 0;
  return [c, c, c, c];
}

function topSolid(fills: Paint[] | undefined, warn: Warn): Color {
  const solid = visible(fills).find((p) => p.type === 'SOLID');
  if (solid && solid.type === 'SOLID') return toColor(solid.color, solid.opacity ?? 1);
  warn(WARNING.textColorNotSolid.reason);
  return { hex: '#000000', alpha: 1 };
}

function toRuns(n: Rn, warn: Warn): TextRun[] {
  const chars = n.characters ?? '';
  const base = n.style ?? {};
  const overrides = n.characterStyleOverrides ?? [];
  const table = n.styleOverrideTable ?? {};
  const runs: TextRun[] = [];
  let start = 0;
  const key = (i: number) => overrides[i] ?? 0;   // a short array means "no override" for the rest
  for (let i = 1; i <= chars.length; i++) {
    if (i < chars.length && key(i) === key(start)) continue;
    const o = key(start) === 0 ? {} : table[String(key(start))] ?? {};
    const s: TypeStyle = { ...base, ...o };
    runs.push({
      start, end: i,
      fontFamily: s.fontFamily ?? '', fontStyle: s.fontStyle ?? '', fontWeight: s.fontWeight ?? 400,
      fontSize: s.fontSize ?? 0, lineHeightPx: s.lineHeightPx ?? 0, letterSpacingPx: s.letterSpacing ?? 0,
      textCase: s.textCase ?? 'ORIGINAL', textDecoration: s.textDecoration ?? 'NONE',
      color: topSolid(o.fills ?? n.fills, warn),
    });
    start = i;
  }
  return runs;
}

function toText(n: Rn, height: number, missing: Set<string>, warn: Warn): Layer['text'] {
  const runs = toRuns(n, warn);
  let dominantRun = 0;
  runs.forEach((r, i) => {
    if (r.end - r.start > runs[dominantRun].end - runs[dominantRun].start) dominantRun = i;   // ties keep the earliest
  });
  const lh = runs[dominantRun]?.lineHeightPx ?? 0;
  return {
    characters: n.characters ?? '', runs, dominantRun, align: n.style?.textAlignHorizontal ?? 'LEFT',
    autoResize: n.style?.textAutoResize ?? 'NONE',
    lineCount: lh > 0 ? Math.max(1, Math.round(height / lh)) : 1,
    hasMissingFont: missing.has(n.id),
  };
}

const withMotion = (motion: Motion | undefined): { motion?: Motion } => (motion ? { motion } : {});

const OVERFLOW: Record<string, NonNullable<Motion['overflow']>> = {
  HORIZONTAL_SCROLLING: 'HORIZONTAL', VERTICAL_SCROLLING: 'VERTICAL', HORIZONTAL_AND_VERTICAL_SCROLLING: 'BOTH',
};

/** Scrolling and animated GIF fills from the export. The plugin adds interactions, states, video and links later. */
function toMotion(n: Rn): Motion | undefined {
  const m: Motion = {};
  if (n.scrollBehavior === 'FIXED') m.scroll = 'fixed';
  if (n.scrollBehavior === 'STICKY_SCROLLS') m.scroll = 'sticky';
  if (n.overflowDirection && OVERFLOW[n.overflowDirection]) m.overflow = OVERFLOW[n.overflowDirection];
  const gifs = visible(n.fills).filter((p) => p.type === 'IMAGE' && p.gifRef);
  if (gifs.length > 0) m.media = gifs.map((p) => ({ kind: 'gif' as const, ref: p.type === 'IMAGE' ? p.gifRef ?? null : null }));
  return Object.keys(m).length > 0 ? m : undefined;
}

function toLayer(n: Rn, origin: Box, missing: Set<string>, warnings: SectionData['warnings']): Layer {
  const warn: Warn = (reason) => {
    if (!warnings.some((w) => w.layerId === n.id && w.reason === reason)) warnings.push({ layerId: n.id, layerName: n.name, reason });
  };
  if (!n.absoluteBoundingBox) warn(WARNING.noBox.reason);
  if (Math.abs(n.rotation ?? 0) > 1e-6) warn(WARNING.rotated.reason);
  // Stroke weight per side: top, right, bottom, left. A side without its own weight uses strokeWeight.
  const all = n.strokeWeight ?? 0;
  const side = n.individualStrokeWeights;
  const weights: Tuple4 = side
    ? [side.top, side.right, side.bottom, side.left]
    : [n.strokeTopWeight ?? all, n.strokeRightWeight ?? all, n.strokeBottomWeight ?? all, n.strokeLeftWeight ?? all];
  const b = n.absoluteBoundingBox ?? { x: origin.x, y: origin.y, width: 0, height: 0 };
  const strokes: Layer['strokes'] = [];
  for (const p of visible(n.strokes)) {
    if (p.type === 'SOLID') {
      strokes.push({ color: toColor(p.color, p.opacity ?? 1), weight: all, weights, align: n.strokeAlign ?? 'INSIDE' });
    } else {
      warn(WARNING.paintedBorder.reason);
    }
  }
  return {
    id: n.id, name: n.name, type: n.type,
    x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height,
    layout: {
      mode: MODE[n.layoutMode as keyof typeof MODE] ?? 'none',
      gap: n.itemSpacing ?? 0,
      padding: [n.paddingTop ?? 0, n.paddingRight ?? 0, n.paddingBottom ?? 0, n.paddingLeft ?? 0],
      mainAlign: ALIGN[n.primaryAxisAlignItems ?? ''] ?? 'start',
      crossAlign: ALIGN[n.counterAxisAlignItems ?? ''] ?? 'start',
      wrap: n.layoutWrap === 'WRAP',
      sizingH: n.layoutSizingHorizontal?.toLowerCase() ?? 'fixed',
      sizingV: n.layoutSizingVertical?.toLowerCase() ?? 'fixed',
      absolute: n.layoutPositioning === 'ABSOLUTE',
    },
    fills: visible(n.fills).map((p) => toFill(p, b, warn)).filter((f): f is Fill => f !== null),
    strokes,
    radius: toRadius(n),
    effects: visible(n.effects).map((e) => toEffect(e, warn)).filter((e): e is Effect => e !== null),
    opacity: n.opacity ?? 1,
    blendMode: n.blendMode ?? 'PASS_THROUGH',
    clips: n.clipsContent ?? false,
    text: n.type === 'TEXT' ? toText(n, b.height, missing, warn) : null,
    ...withMotion(toMotion(n)),
    children: visible(n.children).map((c) => toLayer(c, origin, missing, warnings)),
  };
}

export function toSectionData(input: { document: RestNode; textDetails: TextDetail[]; variables: ResolvedVariable[] }): SectionData {
  const doc = input.document as unknown as Rn;
  const origin = doc.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const missing = new Set(input.textDetails.filter((d) => d.hasMissingFont).map((d) => d.id));

  const warnings: SectionData['warnings'] = [];
  const root = toLayer(doc, origin, missing, warnings);

  // Only fonts that visible text uses: a font on a hidden layer must not stop the build.
  const shown = new Set<string>();
  const collect = (layer: Layer): void => { if (layer.text) shown.add(layer.id); layer.children.forEach(collect); };
  collect(root);
  const fonts: SectionData['fonts'] = [];
  for (const d of input.textDetails) {
    if (!shown.has(d.id)) continue;
    for (const f of d.fonts) {
      const known = fonts.find((x) => x.family === f.family && x.style === f.style && x.weight === f.weight);
      if (known) known.missingInFigma ||= d.hasMissingFont;
      else fonts.push({ ...f, missingInFigma: d.hasMissingFont });
    }
  }
  return {
    rootId: doc.id, name: doc.name, width: origin.width, height: origin.height,
    root, fonts, variables: input.variables, warnings,
  };
}
