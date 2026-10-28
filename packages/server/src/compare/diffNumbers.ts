import type { LineResult, LineTarget, Side } from '../browser/lines';
import type { MeasuredElement } from '../browser/measure';
import { planAssets } from '../design/assets';
import type { Color, Fill, Layer, SectionData, TextRun } from '../design/types';
import { WARNING, warningKind } from '../design/warnings';
import {
  firstFamily, formatColor, formatShadow, fromDesign, parseBlur, parseColor, parseGradient, parsePx, parseShadows,
  splitTopLevel, type Rgba, type Shadow,
} from './css';

export interface Difference { layerId: string; layerName: string; property: string; design: string | number; build: string | number }
/** Something a browser can draw but the numbers can't confirm. The agent checks it in the overlay image. */
export interface CheckByEye { layerId: string; layerName: string; property: string; reason: string }
/** Something no browser can draw exactly. The agent stops and tells the owner (req 6.3). */
export interface CannotMatch { layerId: string; layerName: string; reason: string }

/** Position and size must differ by less than this many px (req 4.3). */
export const BOX_TOLERANCE_PX = 1;
/** Opacity and colour alpha may differ by this much (req 4.4). Red, green and blue must be equal. */
export const OPACITY_TOLERANCE = 0.01;
/** Line height and letter spacing may differ by this many px (req 4.5). */
export const TEXT_SPACING_TOLERANCE_PX = 0.01;
/** Font size, border width, corner radius, shadow and blur values may differ by this many px. */
/** A line weight further than this from a whole pixel can't be drawn by a CSS border. */
export const FRACTIONAL_LINE_PX = 0.01;
export const STYLE_TOLERANCE_PX = 0.01;
/** Gradient stop positions (0 to 1) may differ by this much. */
export const GRADIENT_STOP_TOLERANCE = 0.01;
/** Gradient angles may differ by this many degrees. */
export const GRADIENT_ANGLE_TOLERANCE_DEG = 1;
/**
 * Figma's blur radius is taken as twice the value CSS blur() takes, as Figma's own CSS export writes it.
 * ASSUMPTION: not yet confirmed by comparing a blurred layer in Figma with the same blur in the browser.
 */
export const FIGMA_BLUR_TO_CSS = 0.5;

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;   // same order as Layer.radius
const CSS_GRADIENT = { linear: 'linear', radial: 'radial', angular: 'conic' } as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const within = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance + 1e-9;
const sameColor = (a: Rgba, b: Rgba) => a.r === b.r && a.g === b.g && a.b === b.b && within(a.a, b.a, OPACITY_TOLERANCE);

type Add = (property: string, design: string | number, build: string | number) => void;
type Eye = (property: string, reason: string) => void;
/** What a check needs besides the layer and element: where to report, and the warnings on this layer. */
interface Report { add: Add; eye: Eye; warned: (reason: string) => boolean }

/**
 * The width Figma gives a text box that hugs its words, for text the browser measures as `width` px:
 * Figma leaves out the letter spacing after the last letter, then rounds up to a whole pixel.
 */
export function figmaHugWidth(width: number, lastLetterSpacing: number): number {
  return Math.ceil(width - lastLetterSpacing - 0.001);
}

function checkBox(layer: Layer, el: MeasuredElement, add: Add): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (Math.abs(layer[key] - el[key]) < BOX_TOLERANCE_PX) continue;
    if (key === 'width' && layer.text?.autoResize === 'WIDTH_AND_HEIGHT') {
      const last = layer.text.runs.at(-1);
      if (last && figmaHugWidth(el.width, last.letterSpacingPx) === layer.width) continue;
    }
    add(key, round2(layer[key]), round2(el[key]));
  }
}

function checkColor(property: string, design: Color, raw: string, add: Add): void {
  const want = fromDesign(design);
  const got = parseColor(raw);
  if (!got || !sameColor(want, got)) add(property, formatColor(want), got ? formatColor(got) : raw);
}

function formatGradient(fill: Extract<Fill, { type: 'gradient' }>): string {
  const stops = fill.stops.map((s) => `${formatColor(fromDesign(s.color))} ${round2(s.position * 100)}%`).join(', ');
  const angle = round2(fill.angleDeg);
  if (fill.kind === 'linear') return `linear-gradient(${angle}deg, ${stops})`;
  if (fill.kind === 'angular') return `conic-gradient(from ${angle}deg, ${stops})`;
  if (fill.kind === 'radial') return `radial-gradient(${stops})`;
  return `diamond-gradient(${stops})`;
}

function checkGradient(fill: Extract<Fill, { type: 'gradient' }>, el: MeasuredElement, add: Add): void {
  const raw = el.style['background-image'];
  if (fill.kind === 'diamond') return;   // no CSS gradient draws it: the section warning reports it
  const kind = CSS_GRADIENT[fill.kind];
  const got = parseGradient(raw, el);
  const angleOk = (a: number | null) => {
    if (kind === 'radial') return true;
    if (a === null) return false;
    const gap = Math.abs((((a - fill.angleDeg) % 360) + 540) % 360 - 180);
    return gap <= GRADIENT_ANGLE_TOLERANCE_DEG + 1e-9;
  };
  const ok = got !== null && got.kind === kind && angleOk(got.angleDeg) && got.stops.length === fill.stops.length
    && got.stops.every((s, i) => sameColor(fromDesign(fill.stops[i].color), s.color)
      && within(s.position, fill.stops[i].position, GRADIENT_STOP_TOLERANCE));
  if (!ok) add('background-image', formatGradient(fill), raw);
}

/** The top visible solid or gradient fill against the element's background. */
function checkBackground(layer: Layer, el: MeasuredElement, { add, eye, warned }: Report): void {
  if (layer.fills.some((f) => f.type === 'image')) return;   // pictures are checked in the overlay image
  if (warned(WARNING.patternFill.reason) || warned(WARNING.diamondGradient.reason)) return;
  if (layer.fills.length >= 2) {
    eye('fills', `${layer.fills.length} fills stacked; the numbers can't check stacked fills`);
    return;
  }
  const fill = layer.fills[0];
  const image = el.style['background-image'];
  if (fill?.type === 'gradient') {
    checkGradient(fill, el, add);
    return;
  }
  if (fill?.type === 'solid') {
    checkColor('background-color', fill.color, el.style['background-color'], add);
  } else {
    const got = parseColor(el.style['background-color']);
    if (!got || got.a > OPACITY_TOLERANCE) add('background-color', 'none', got ? formatColor(got) : el.style['background-color']);
  }
  if (image !== 'none') add('background-image', 'none', image);
}

/** "0.5 px inside + 0.5 px outside", "1 px inside" or "none". */
function lineWords(inside: number, outside: number): string {
  const parts = [inside > 0 ? `${round2(inside)} px inside` : '', outside > 0 ? `${round2(outside)} px outside` : ''].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'none';
}

/**
 * Checks the stroke side by side. A side's line may be drawn by the CSS border (inside the box) and by
 * sharp shadows in the stroke's colour (`lines`): inset ones inside the box, outer ones outside it. When
 * shadows draw a side, the line inside and outside the edge must match the design's: all inside for an
 * INSIDE stroke, half and half for CENTER, all outside for OUTSIDE. Otherwise the border must match, except
 * where no border can draw the line (thinner than a whole pixel, or not inside the box): that is checked by eye.
 */
function checkBorder(layer: Layer, el: MeasuredElement, lines: ShadowLine[], { add, eye, warned }: Report): void {
  if (warned(WARNING.paintedBorder.reason)) return;   // a gradient or image border: reported from the warning
  if (layer.strokes.length >= 2) {
    eye('border', `${layer.strokes.length} strokes stacked; the numbers can't check stacked strokes`);
    return;
  }
  const stroke = layer.strokes[0];
  const want = stroke?.weights ?? [0, 0, 0, 0];
  const align = stroke?.align ?? 'INSIDE';
  const drawn = (i: number, inside: boolean) => lines.filter((l) => l.sides[i] && l.inside === inside).reduce((n, l) => n + l.width, 0);
  // Chromium draws a CSS border only in whole pixels (at least 1 px), so a 0.5 px or 1.5 px line can
  // never match through border-width. A stroke outside or across the edge does not change the box in
  // Figma, so a CSS border can't copy it either.
  const fractional = want.map((w) => w > 0 && Math.abs(w - Math.round(w)) > FRACTIONAL_LINE_PX);
  const byEye: number[] = [];
  const bordered: number[] = [];
  SIDES.forEach((side, i) => {
    const raw = el.style[`border-${side}-width`];
    const border = parsePx(raw);
    if (border === null) { add(`border-${side}-width`, want[i], raw); return; }
    const shadowIn = drawn(i, true);
    const shadowOut = drawn(i, false);
    if (shadowIn > 0 || shadowOut > 0) {
      const wantIn = align === 'INSIDE' ? want[i] : align === 'CENTER' ? want[i] / 2 : 0;
      const wantOut = want[i] - wantIn;
      if (!within(border + shadowIn, wantIn, STYLE_TOLERANCE_PX) || !within(shadowOut, wantOut, STYLE_TOLERANCE_PX)) {
        add(`${side}-line`, lineWords(wantIn, wantOut), lineWords(border + shadowIn, shadowOut));
      }
      if (border > 0) bordered.push(i);
      return;
    }
    if (want[i] > 0 && (fractional[i] || align !== 'INSIDE')) { byEye.push(i); return; }
    if (!within(border, want[i], STYLE_TOLERANCE_PX)) add(`border-${side}-width`, want[i], border);
    if (border > 0) bordered.push(i);
  });
  if (stroke && byEye.some((i) => align !== 'INSIDE')) {
    eye('border', `${stroke.weights.join('/')} px ${align.toLowerCase()} stroke ${formatColor(fromDesign(stroke.color))}; a CSS border sits inside the box. `
      + 'Draw it with sharp box-shadows in its colour: an outer one for a line outside, an inset and an outer one of half the weight each for a centred line.');
  } else if (stroke && byEye.length) {
    const sides = byEye.map((i) => SIDES[i]).join(', ');
    eye('border', `${sides} line is ${want[byEye[0]]} px, which a CSS border can't draw (browsers draw whole pixels). `
      + 'Draw it with an inset box-shadow and check it in the picture. Figma draws it above the children: '
      + 'when a child reaches that edge, draw the line on a ::after layer on top.');
  }
  if (!stroke) return;
  for (const i of bordered) {
    if (want[i] > 0) checkColor(`border-${SIDES[i]}-color`, stroke.color, el.style[`border-${SIDES[i]}-color`], add);
  }
}

/** Shrinks all corner radii together when they don't fit the box, as CSS (and Figma) do. */
function fitRadii(h: number[], v: number[], width: number, height: number): { h: number[]; v: number[] } {
  const ratio = (side: number, sum: number) => (sum > 0 ? side / sum : Infinity);
  const f = Math.min(1, ratio(width, h[0] + h[1]), ratio(width, h[3] + h[2]), ratio(height, v[0] + v[3]), ratio(height, v[1] + v[2]));
  return { h: h.map((r) => r * f), v: v.map((r) => r * f) };
}

function checkRadius(layer: Layer, el: MeasuredElement, add: Add): void {
  const want = fitRadii(layer.radius, layer.radius, layer.width, layer.height).h;
  const len = (text: string | undefined, size: number): number | null => {
    if (text === undefined) return null;
    const pct = /^(-?[\d.]+)%$/.exec(text);
    return pct ? (Number(pct[1]) / 100) * size : parsePx(text);
  };
  const raw = CORNERS.map((c) => el.style[`border-${c}-radius`]);
  const parts = raw.map((r) => splitTopLevel(r, ' '));
  const h = parts.map((p) => len(p[0], el.width));
  const v = parts.map((p) => len(p[1] ?? p[0], el.height));
  if (h.some((x) => x === null) || v.some((x) => x === null)) {
    CORNERS.forEach((c, i) => {
      if (h[i] === null || v[i] === null) add(`border-${c}-radius`, round2(want[i]), raw[i]);
    });
    return;
  }
  const got = fitRadii(h as number[], v as number[], el.width, el.height);
  CORNERS.forEach((c, i) => {
    const gh = got.h[i];
    const gv = got.v[i];
    if (within(gh, want[i], STYLE_TOLERANCE_PX) && within(gv, want[i], STYLE_TOLERANCE_PX)) return;
    add(`border-${c}-radius`, round2(want[i]), within(gh, gv, STYLE_TOLERANCE_PX) ? round2(gh) : `${round2(gh)}px ${round2(gv)}px`);
  });
}

const sameShadow = (a: Shadow, b: Shadow) => a.inset === b.inset && sameColor(a.color, b.color)
  && within(a.x, b.x, STYLE_TOLERANCE_PX) && within(a.y, b.y, STYLE_TOLERANCE_PX)
  && within(a.blur, b.blur, STYLE_TOLERANCE_PX) && within(a.spread, b.spread, STYLE_TOLERANCE_PX);

/** A line a sharp shadow draws: on which sides (top, right, bottom, left), how thick, and inside or outside the box. */
interface ShadowLine { sides: [boolean, boolean, boolean, boolean]; width: number; inside: boolean }

/**
 * Reads a sharp shadow in `color` as a line, or null when it is not one. A spread with no offset draws
 * all four sides. An offset with no spread draws one side: an inset shadow moved down draws the top line
 * inside the box, an outer shadow moved up draws it outside the box, and so on for the other sides.
 */
function shadowLine(g: Shadow, color: Rgba): ShadowLine | null {
  if (!within(g.blur, 0, STYLE_TOLERANCE_PX) || !sameColor(g.color, color)) return null;
  const zero = (v: number) => within(v, 0, STYLE_TOLERANCE_PX);
  if (zero(g.x) && zero(g.y)) return g.spread > STYLE_TOLERANCE_PX ? { sides: [true, true, true, true], width: g.spread, inside: g.inset } : null;
  if (!zero(g.spread) || (!zero(g.x) && !zero(g.y))) return null;
  const toward = g.inset ? 1 : -1;
  if (zero(g.x)) return { sides: [g.y * toward > 0, false, g.y * toward < 0, false], width: Math.abs(g.y), inside: g.inset };
  return { sides: [false, g.x * toward < 0, false, g.x * toward > 0], width: Math.abs(g.x), inside: g.inset };
}

/**
 * Checks the element's box-shadows against the design's shadow effects, as a set: each design shadow
 * needs its own equal build shadow. A sharp shadow left over in the stroke's colour draws the stroke, so
 * it is returned as a line for checkBorder, not reported. So are such shadows on a ::before or ::after
 * layer over the element (a line drawn above the children). Call report() to add the shadow difference, if any.
 */
function checkShadows(layer: Layer, el: MeasuredElement, add: Add): { lines: ShadowLine[]; report: () => void } {
  const want: Shadow[] = layer.effects
    .filter((e) => e.type === 'drop-shadow' || e.type === 'inner-shadow')
    .map((e) => ({ inset: e.type === 'inner-shadow', color: fromDesign(e.color ?? { hex: '#000000', alpha: 1 }),
      x: e.x, y: e.y, blur: e.blur, spread: e.spread }));
  const strokeColor = layer.strokes.length === 1 ? fromDesign(layer.strokes[0].color) : null;
  const asLine = (g: Shadow) => (strokeColor ? shadowLine(g, strokeColor) : null);
  const raw = el.style['box-shadow'];
  const got = parseShadows(raw);
  const unused = got ? [...got] : [];
  const missing = want.filter((w) => {
    const i = unused.findIndex((g) => sameShadow(w, g));
    if (i < 0) return true;
    unused.splice(i, 1);
    return false;
  });
  const lines: ShadowLine[] = [];
  const extra = unused.filter((g) => {
    const line = asLine(g);
    if (line) lines.push(line);
    return !line;
  });
  for (const overlay of el.overlayShadows ?? []) {
    for (const g of parseShadows(overlay) ?? []) {
      const line = asLine(g);
      if (line) lines.push(line);
    }
  }
  const differs = got === null || missing.length > 0 || extra.length > 0;
  return { lines, report: () => { if (differs) add('box-shadow', want.length ? want.map(formatShadow).join(', ') : 'none', raw.trim() || 'none'); } };
}

function checkBlur(property: 'filter' | 'backdrop-filter', figmaBlur: number, el: MeasuredElement, add: Add): void {
  const want = figmaBlur * FIGMA_BLUR_TO_CSS;
  const raw = el.style[property];
  const got = parseBlur(raw);
  if (got === null || !within(got, want, STYLE_TOLERANCE_PX)) add(property, want > 0 ? `blur(${round2(want)}px)` : 'none', raw);
}

function checkSurface(layer: Layer, el: MeasuredElement, report: Report): void {
  const { add, warned } = report;
  checkBackground(layer, el, report);
  const shadows = checkShadows(layer, el, add);
  checkBorder(layer, el, shadows.lines, report);
  checkRadius(layer, el, add);
  shadows.report();
  if (warned(WARNING.progressiveBlur.reason)) return;   // no browser draws it: reported from the warning
  const blur = (type: string) => layer.effects.find((e) => e.type === type)?.blur ?? 0;
  checkBlur('filter', blur('layer-blur'), el, add);
  checkBlur('backdrop-filter', blur('background-blur'), el, add);
}

/** Text is checked against its dominant run: the style that covers the most characters. */
/** Text is compared with every run of spaces and line breaks made one space. */
const plainText = (t: string) => t.replace(/\s+/g, ' ').trim();
/** At most this many characters of a text are shown in a difference. */
const TEXT_SNIPPET_CHARS = 60;

/** The part of `text` around position `at`, where two texts first differ. */
function snippet(text: string, at: number): string {
  const start = Math.max(0, at - 20);
  const end = Math.min(text.length, start + TEXT_SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Compares the words. With a text case set in Figma, CSS text-transform may change letter case, so case is ignored. */
function checkCharacters(text: NonNullable<Layer['text']>, run: TextRun, shown: string, add: Add): void {
  const want = plainText(text.characters);
  const got = plainText(shown);
  const fold = (t: string) => (run.textCase !== 'ORIGINAL' ? t.toLowerCase() : t);
  if (fold(want) === fold(got)) return;
  let at = 0;
  while (at < want.length && fold(want[at]) === fold(got[at] ?? '')) at++;
  add('text', snippet(want, at), snippet(got, at));
}

function checkText(text: NonNullable<Layer['text']>, el: MeasuredElement, { add, warned }: Report): void {
  const run = text.runs[text.dominantRun];
  if (!run) return;
  if (el.text != null) checkCharacters(text, run, el.text, add);
  const s = el.style;
  const family = firstFamily(s['font-family']);
  if (family.toLowerCase() !== run.fontFamily.toLowerCase()) add('font-family', run.fontFamily, family);
  if (!el.fontLoaded) add('font-not-loaded', run.fontFamily, 'fallback font');
  const weight = Number(s['font-weight']);
  if (weight !== run.fontWeight) add('font-weight', run.fontWeight, Number.isNaN(weight) ? s['font-weight'] : weight);
  const size = parsePx(s['font-size']);
  if (size === null || !within(size, run.fontSize, STYLE_TOLERANCE_PX)) add('font-size', run.fontSize, size ?? s['font-size']);
  if (s['line-height'] === 'normal') {
    add('line-height', run.lineHeightPx, 'line height not set');
  } else {
    const plain = /^[\d.]+$/.test(s['line-height']) ? Number(s['line-height']) * (size ?? 0) : null;   // a unitless number
    const lh = parsePx(s['line-height']) ?? plain;
    if (lh === null || !within(lh, run.lineHeightPx, TEXT_SPACING_TOLERANCE_PX)) add('line-height', run.lineHeightPx, lh === null ? s['line-height'] : round2(lh));
  }
  const spacing = s['letter-spacing'] === 'normal' ? 0 : parsePx(s['letter-spacing']);
  if (spacing === null || !within(spacing, run.letterSpacingPx, TEXT_SPACING_TOLERANCE_PX)) {
    add('letter-spacing', run.letterSpacingPx, spacing === null ? s['letter-spacing'] : round2(spacing));
  }
  if (!warned(WARNING.textColorNotSolid.reason)) checkColor('color', run.color, s.color, add);
  if (el.lineCount !== text.lineCount) add('lineCount', text.lineCount, el.lineCount ?? 'no text');
}

function checkOpacity(layer: Layer, el: MeasuredElement, add: Add): void {
  const got = Number(el.style.opacity);
  if (Number.isNaN(got) || !within(got, layer.opacity, OPACITY_TOLERANCE)) {
    add('opacity', round2(layer.opacity), Number.isNaN(got) ? el.style.opacity : round2(got));
  }
}

/**
 * The frame lines to test for being hidden (see checkLines): every stroked layer with children, except
 * layers drawn inside an exported picture. A line inside the box is tested at its middle; a line across
 * the edge (CENTER) at the middle of its inner half. Lines outside the box can't be covered by children.
 */
export function lineTargets(design: SectionData, covered: Set<string>): LineTarget[] {
  const pictured = new Set(planAssets(design.root).filter((p) => p.kind !== 'image-original').map((p) => p.layerId));
  const out: LineTarget[] = [];
  const visit = (layer: Layer): void => {
    if (covered.has(layer.id) || pictured.has(layer.id)) return;
    const stroke = layer.strokes.length === 1 ? layer.strokes[0] : null;
    if (stroke && layer.children.length > 0 && !layer.text && (stroke.align === 'INSIDE' || stroke.align === 'CENTER')) {
      const share = stroke.align === 'INSIDE' ? 0.5 : 0.25;
      const sides = SIDES.flatMap((side: Side, i) => (stroke.weights[i] > 0 ? [{ side, depth: stroke.weights[i] * share }] : []));
      if (sides.length) out.push({ figmaId: layer.id, sides });
    }
    layer.children.forEach(visit);
  };
  visit(design.root);
  return out;
}

/**
 * Compares each visible layer with the element that carries its data-figma-id.
 * - `covered`: layers drawn inside an exported SVG or rendered image. They need no element and are not checked.
 * - `explained`: layers the agent left out on purpose, with a reason. They are not listed as unmapped.
 * GROUP layers need no element. If one has an element, only its box is checked, as for SVG and rendered-image layers.
 * The section's warnings become `checkByEye` items (a browser can draw it) or `cannotMatch` items (no browser can),
 * except on layers drawn by an exported picture, which draws them exactly. The checks they make unreliable are skipped.
 * `lines` are the results of checkLines: a frame line hidden under a child is a difference, because Figma draws it on top.
 * Width and x differences that letter pairs such as "fi" explain are known limits, not differences (see splitLetterPairLimits).
 */
export function diffSection(
  design: SectionData,
  measured: MeasuredElement[],
  covered: Set<string>,
  explained: { layerId: string; reason: string }[],
  lines: LineResult[] = [],
): {
  differences: Difference[]; unmapped: { layerId: string; layerName: string }[]; paired: number;
  checkByEye: CheckByEye[]; cannotMatch: CannotMatch[]; unchecked: Unchecked[]; knownLimits: KnownLimit[];
} {
  // With two elements for one layer, use the first one that is visible and has a real box, else the first.
  const byId = new Map<string, MeasuredElement[]>();
  for (const m of measured) byId.set(m.figmaId, [...(byId.get(m.figmaId) ?? []), m]);
  const usable = (m: MeasuredElement) => m.visible && m.width > 0 && m.height > 0;
  const elementFor = (id: string) => {
    const list = byId.get(id);
    return list && (list.find(usable) ?? list[0]);
  };

  const warningsOf = new Map<string, string[]>();
  for (const w of design.warnings) warningsOf.set(w.layerId, [...(warningsOf.get(w.layerId) ?? []), w.reason]);
  const excused = new Set(explained.map((e) => e.layerId));
  const boxOnly = new Set(planAssets(design.root).filter((p) => p.kind !== 'image-original').map((p) => p.layerId));
  const differences: Difference[] = [];
  const unmapped: { layerId: string; layerName: string }[] = [];
  const checkByEye: CheckByEye[] = [];
  const cannotMatch: CannotMatch[] = [];
  let paired = 0;
  const textWidths = new Map<string, number>();

  const visit = (layer: Layer): void => {
    if (covered.has(layer.id)) return;   // drawn inside an exported picture, and so are its children
    const who = { layerId: layer.id, layerName: layer.name };
    const reasons = boxOnly.has(layer.id) ? [] : warningsOf.get(layer.id) ?? [];
    for (const reason of reasons) {
      const kind = warningKind(reason);
      if (kind.browserCanDraw) checkByEye.push({ ...who, property: kind.property, reason });
      else cannotMatch.push({ ...who, reason });
    }
    const el = elementFor(layer.id);
    if (!el) {
      if (layer.type !== 'GROUP' && !excused.has(layer.id)) unmapped.push(who);
    } else {
      paired += 1;
      if (layer.text) textWidths.set(layer.id, el.width);
      const report: Report = {
        add: (property, want, got) => differences.push({ ...who, property, design: want, build: got }),
        eye: (property, reason) => checkByEye.push({ ...who, property, reason }),
        warned: (reason) => reasons.includes(reason),
      };
      if (!report.warned(WARNING.noBox.reason)) checkBox(layer, el, report.add);
      if (layer.type !== 'GROUP' && !boxOnly.has(layer.id)) {
        if (layer.text) checkText(layer.text, el, report);
        else checkSurface(layer, el, report);
        for (const line of lines) {
          if (line.figmaId !== layer.id || line.hidden === 0) continue;
          report.add(`${line.side}-line-hidden`, 'drawn above the children, as Figma draws it',
            `hidden under ${line.under.join(', ')} at ${line.hidden} of ${line.points} points`);
        }
        checkOpacity(layer, el, report.add);
      }
    }
    layer.children.forEach(visit);
  };
  visit(design.root);
  const { kept, known } = splitLetterPairLimits(design.root, differences, textWidths);
  return { differences: kept, unmapped, paired, checkByEye, cannotMatch, unchecked: uncheckedLayers(design.root, explained), knownLimits: known };
}

/** A difference that comes from a known browser limit. It is listed, but does not stop a pass. */
export interface KnownLimit extends Difference { reason: string }

/**
 * Each letter pair such as "fi" or "fl" may make a text this many px wider or narrower than in Figma:
 * Figma and browsers space the letters after these pairs a little differently, and no CSS setting matches it.
 */
export const LETTER_PAIR_SLACK_PX = 1;
const LETTER_PAIRS = /f[fijlt]/gi;
/** At most this many characters of a text are quoted in a known-limit reason. */
const LIMIT_QUOTE_CHARS = 30;

/**
 * Moves width and x differences that letter pairs explain from `differences` to the known limits.
 * A text counts when it has letter pairs, its only differences are its width or x, and its width differs
 * by at most LETTER_PAIR_SLACK_PX per pair. A width or x difference on a layer is explained by such texts
 * inside the layer, or inside an earlier sibling of the layer or of a layer around it (which push it along),
 * when it is smaller than their width differences together, plus the box tolerance.
 */
function splitLetterPairLimits(root: Layer, differences: Difference[], textWidths: Map<string, number>): { kept: Difference[]; known: KnownLimit[] } {
  const parent = new Map<string, Layer>();
  const byId = new Map<string, Layer>();
  const index = (l: Layer): void => { byId.set(l.id, l); for (const c of l.children) { parent.set(c.id, l); index(c); } };
  index(root);
  const texts: { layer: Layer; slack: number }[] = [];
  for (const [id, width] of textWidths) {
    const layer = byId.get(id)!;
    const pairs = layer.text!.characters.match(LETTER_PAIRS)?.length ?? 0;
    const own = differences.filter((d) => d.layerId === id);
    const slack = Math.abs(width - layer.width);
    if (pairs > 0 && own.every((d) => d.property === 'width' || d.property === 'x') && slack <= pairs * LETTER_PAIR_SLACK_PX + BOX_TOLERANCE_PX) {
      texts.push({ layer, slack });
    }
  }
  if (texts.length === 0) return { kept: differences, known: [] };
  const inside = (l: Layer, outer: Layer): boolean => {
    for (let a: Layer | undefined = l; a; a = parent.get(a.id)) if (a === outer) return true;
    return false;
  };
  // Texts inside the layer, or inside an earlier sibling of it or of any layer around it.
  const related = (target: Layer) => texts.filter((t) => {
    if (inside(t.layer, target)) return true;
    for (let a: Layer | undefined = target; a && parent.get(a.id); a = parent.get(a.id)) {
      const siblings = parent.get(a.id)!.children;
      if (siblings.slice(0, siblings.indexOf(a)).some((s) => inside(t.layer, s))) return true;
    }
    return false;
  });
  const kept: Difference[] = [];
  const known: KnownLimit[] = [];
  for (const d of differences) {
    const target = byId.get(d.layerId);
    const near = target && (d.property === 'width' || d.property === 'x') && typeof d.design === 'number' && typeof d.build === 'number'
      ? related(target) : [];
    const allowed = near.reduce((n, t) => n + t.slack, 0) + BOX_TOLERANCE_PX;
    if (near.length === 0 || Math.abs((d.design as number) - (d.build as number)) >= allowed) {
      kept.push(d);
      continue;
    }
    const quoted = near.map((t) => {
      const c = t.layer.text!.characters.replace(/\s+/g, ' ').trim();
      return `"${c.length > LIMIT_QUOTE_CHARS ? `${c.slice(0, LIMIT_QUOTE_CHARS)}…` : c}"`;
    });
    known.push({ ...d, reason: `Figma and browsers space the letters after "fi", "fl" and similar pairs a little differently (in ${quoted.join(', ')}). `
      + 'No CSS setting matches it: accept it.' });
  }
  return { kept, known };
}

/** A layer, or a group of layers, that compare did not check number by number, and why. */
export interface Unchecked { layerId: string; layerName: string; reason: string }

/** Lists what compare skipped: layers drawn inside an exported picture, and layers the agent explained. */
function uncheckedLayers(root: Layer, explained: { layerId: string; reason: string }[]): Unchecked[] {
  const out: Unchecked[] = [];
  const count = (layer: Layer): number => layer.children.reduce((n, c) => n + 1 + count(c), 0);
  const byId = new Map<string, Layer>();
  const index = (layer: Layer): void => { byId.set(layer.id, layer); layer.children.forEach(index); };
  index(root);
  for (const plan of planAssets(root)) {
    if (plan.kind === 'image-original') continue;
    const inside = count(byId.get(plan.layerId)!);
    if (inside > 0) {
      out.push({ layerId: plan.layerId, layerName: plan.layerName,
        reason: `${inside} ${inside === 1 ? 'layer inside is' : 'layers inside are'} drawn by this exported ${plan.kind === 'svg' ? 'SVG' : 'picture'}, so only the picture's box is checked` });
    }
  }
  for (const e of explained) {
    out.push({ layerId: e.layerId, layerName: byId.get(e.layerId)?.name ?? e.layerId, reason: `Explained: ${e.reason}` });
  }
  return out;
}
