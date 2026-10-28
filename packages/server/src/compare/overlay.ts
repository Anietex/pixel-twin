import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface Rect { x: number; y: number; width: number; height: number }
/**
 * What a changed area most likely is, read from the two pictures:
 * - shifted: the same content, moved (by `shift`, in 1x px; right and down are positive);
 * - line-missing / line-extra / line-differs: a thin line only the design has, only the build has, or the build draws a little differently;
 * - blank-picture: a picture in the design, plain in the build (often a picture that had not loaded);
 * - missing / extra: content only the design has, or only the build has;
 * - colour: both plain, in different colours;
 * - edge-smoothing: only the edges of shapes or letters are drawn a little differently, or less than 1 px apart;
 * - different: none of these.
 */
export type AreaKind = 'shifted' | 'line-missing' | 'line-extra' | 'line-differs' | 'blank-picture' | 'missing' | 'extra'
  | 'colour' | 'edge-smoothing' | 'different';
/** The words used for each kind when areas are counted. */
export const AREA_KIND_NAMES: Record<AreaKind, string> = {
  shifted: 'same content shifted', 'line-missing': 'line in design, missing in build', 'line-extra': 'line in build, not in design',
  'line-differs': 'line drawn a little differently', 'blank-picture': 'picture blank in build', missing: 'content in design, missing in build',
  extra: 'content in build, not in design', colour: 'colour differs', 'edge-smoothing': 'edge smoothing only', different: 'content differs',
};
/**
 * A changed area in 1x CSS px, with its number of changed device pixels, what it most likely is (kind and
 * label), the share of its box that matches (similarity, 0 to 1), the layers whose elements it touches
 * (filled in by compare), and a side-by-side crop picture.
 */
export interface Region extends Rect {
  pixels: number; kind: AreaKind; label: string; similarity: number; shift?: { x: number; y: number };
  layers?: { layerId: string; layerName: string }[]; crop?: string;
}
/** Background used under transparent parts of the design picture when the page has none. */
export interface Rgb { r: number; g: number; b: number }

/** Marked pixels closer than about twice this distance (in 1x px) join into one region. */
export const MERGE_DISTANCE_PX = 8;
/** pixelmatch colour difference (0 to 1) above which a pixel counts as changed. */
export const PIXEL_THRESHOLD = 0.1;
const MAGENTA = [255, 0, 255, 255];
/** At most this many changed areas get a crop picture, biggest first. */
export const MAX_CROPS = 20;
/** Space around each crop, in 1x px. */
const CROP_PAD_PX = 8;
/** A crop shows at least this many 1x px across and down (before the space around it), so thin areas stay readable. */
export const MIN_CROP_PX = 40;
/** Small crops are enlarged by a whole number, up to MAX_CROP_ZOOM, until each panel's short side reaches this many px. */
const CROP_PANEL_MIN_PX = 240;
const MAX_CROP_ZOOM = 4;
/** A crop picture is at most this many px on its long side. */
const MAX_CROP_SIDE_PX = 2400;
const DIFF_COLOR: [number, number, number] = [255, 0, 0];
/**
 * Inside text whose numbers already match, Figma and the browser draw letter edges a little differently.
 * There a changed pixel is dropped when a build pixel up to TEXT_SHIFT_PX device px away matches it within
 * TEXT_PIXEL_THRESHOLD, and an area of at most TEXT_NOISE_MAX_PIXELS changed pixels is letter-edge noise.
 */
export const TEXT_SHIFT_PX = 2;
export const TEXT_PIXEL_THRESHOLD = 0.2;
export const TEXT_NOISE_MAX_PIXELS = 24;

/** Grows every marked pixel into a square of side 2r + 1. Works row by row, then column by column. */
function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    let last = -Infinity;
    for (let x = 0; x < width; x++) {
      if (mask[o + x]) last = x;
      if (x - last <= r) rows[o + x] = 1;
    }
    let next = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[o + x]) next = x;
      if (next - x <= r) rows[o + x] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    for (let y = 0; y < height; y++) {
      if (rows[y * width + x]) last = y;
      if (y - last <= r) out[y * width + x] = 1;
    }
    let next = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (rows[y * width + x]) next = y;
      if (next - y <= r) out[y * width + x] = 1;
    }
  }
  return out;
}

/**
 * Groups the marked pixels of `mask` into boxes. The mask is grown by `mergeDistance` first, so nearby
 * pixels share a box. Pixels belong together when they touch on a side. Each box fits the original marked pixels.
 */
export function findRegions(mask: Uint8Array, width: number, height: number, mergeDistance: number): Rect[] {
  const grown = dilate(mask, width, height, Math.max(0, Math.floor(mergeDistance)));
  // Label runs of grown pixels row by row and join runs that touch the row above (union-find).
  const parent: number[] = [];
  const box: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  let above: { start: number; end: number; id: number }[] = [];
  for (let y = 0; y < height; y++) {
    const row: typeof above = [];
    const o = y * width;
    for (let x = 0; x < width;) {
      if (!grown[o + x]) { x++; continue; }
      const start = x;
      while (x < width && grown[o + x]) x++;
      const id = parent.length;
      parent.push(id);
      const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let i = start; i < x; i++) {
        if (!mask[o + i]) continue;
        b.x0 = Math.min(b.x0, i); b.x1 = Math.max(b.x1, i); b.y0 = y; b.y1 = y;
      }
      box.push(b);
      for (const run of above) {
        if (run.start < x && start < run.end) parent[find(run.id)] = find(id);
      }
      row.push({ start, end: x, id });
    }
    above = row;
  }
  const merged = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  box.forEach((b, i) => {
    if (b.x1 < 0) return; // a run made only of grown pixels
    const root = find(i);
    const m = merged.get(root);
    if (!m) merged.set(root, { ...b });
    else { m.x0 = Math.min(m.x0, b.x0); m.y0 = Math.min(m.y0, b.y0); m.x1 = Math.max(m.x1, b.x1); m.y1 = Math.max(m.y1, b.y1); }
  });
  return [...merged.values()]
    .map((b) => ({ x: b.x0, y: b.y0, width: b.x1 - b.x0 + 1, height: b.y1 - b.y0 + 1 }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Returns the picture's pixels at width × height, filling any extra area with magenta. */
function padTo(png: PNG, width: number, height: number): Uint8Array {
  if (png.width === width && png.height === height) return png.data;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) out.set(MAGENTA, i * 4);
  for (let y = 0; y < png.height; y++) {
    out.set(png.data.subarray(y * png.width * 4, (y + 1) * png.width * 4), y * width * 4);
  }
  return out;
}

/** Turns a box in device pixels into 1x CSS px, rounding outwards. */
function toCss(r: Rect, scale: number): Rect {
  const x = Math.floor(r.x / scale);
  const y = Math.floor(r.y / scale);
  return { x, y, width: Math.ceil((r.x + r.width) / scale) - x, height: Math.ceil((r.y + r.height) / scale) - y };
}

/** Paints a picture over a solid background, so transparent parts of the Figma export show the page colour. */
function onBackground(data: Uint8Array, bg: Rgb): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = Math.round(data[i] * a + bg.r * (1 - a));
    out[i + 1] = Math.round(data[i + 1] * a + bg.g * (1 - a));
    out[i + 2] = Math.round(data[i + 2] * a + bg.b * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/** The colour distance pixelmatch uses (YIQ), for opaque pixels. */
function colorDelta(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  const dr = a[i] - b[j];
  const dg = a[i + 1] - b[j + 1];
  const db = a[i + 2] - b[j + 2];
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const iq = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

/**
 * Drops changed pixels that a one-device-pixel shift explains. A section at a fractional position,
 * or a letter edge drawn a hair differently, then no longer shows up as a change.
 */
function ignoreOnePixelShifts(mask: Uint8Array, design: Uint8Array, build: Uint8Array, width: number, height: number): void {
  ignoreShifts(mask, design, build, width, height, 1, PIXEL_THRESHOLD, null);
}

/** True when a pixel of `to` up to `radius` px from (x, y) matches pixel i of `from` within maxDelta. */
function matchesNearby(from: Uint8Array, to: Uint8Array, i: number, x: number, y: number, width: number, height: number,
  radius: number, maxDelta: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      if (colorDelta(from, i * 4, to, ((y + dy) * width + x + dx) * 4) <= maxDelta) return true;
    }
  }
  return false;
}

/**
 * Drops each changed pixel (only those in `only`, when given) that a shift of up to `radius` device px
 * explains: the design's pixel is in the build nearby, and the build's pixel is in the design nearby.
 * Both ways are needed, or a thin line that only one picture has would count as a shift.
 */
function ignoreShifts(mask: Uint8Array, design: Uint8Array, build: Uint8Array, width: number, height: number,
  radius: number, threshold: number, only: Uint8Array | null): void {
  const maxDelta = 35215 * threshold * threshold;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || (only && !only[i])) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (matchesNearby(design, build, i, x, y, width, height, radius, maxDelta)
      && matchesNearby(build, design, i, x, y, width, height, radius, maxDelta)) mask[i] = 0;
  }
}

/** Shifts of up to this many 1x px are tried to explain an area as moved content. */
export const SHIFT_SEARCH_PX = 4;
/** A shift explains an area when it matches at least this share of the area's changed pixels. */
const SHIFT_SHARE = 0.9;
/** At most this many changed pixels of an area are tried for each shift. */
const SHIFT_SAMPLES = 2000;
/** An area is a thin line when it is at most this many 1x px across and at least twice as long. */
const LINE_PX = 2;
/** A part of a picture is plain when its brightness spreads less than this (standard deviation, 0 to 255). */
const PLAIN_SPREAD = 4;
/** A part of a picture with more distinct colours than this is a photo or illustration, not a flat shape. */
const PICTURE_COLOURS = 48;
/** Edge smoothing: at least this share of the changed pixels match a neighbour within this colour difference. */
const SMOOTHING_SHARE = 0.95;
const SMOOTHING_THRESHOLD = 0.3;

const maxDeltaOf = (threshold: number) => 35215 * threshold * threshold;
const round2 = (n: number) => Math.round(n * 100) / 100;
const hex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** The changed pixels of the area `r` (device px), as indices into the picture. */
function changedIn(r: Rect, mask: Uint8Array, width: number): number[] {
  const out: number[] = [];
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) if (mask[y * width + x]) out.push(y * width + x);
  }
  return out;
}

/** The shift (device px, up to `radius`) that best explains the changed pixels both ways, or null when none explains SHIFT_SHARE of them. */
function bestShift(changed: number[], d: Uint8Array, b: Uint8Array, width: number, height: number, radius: number): { dx: number; dy: number } | null {
  const step = Math.max(1, Math.floor(changed.length / SHIFT_SAMPLES));
  const sample = changed.filter((_, k) => k % step === 0);
  const maxDelta = maxDeltaOf(PIXEL_THRESHOLD);
  let best: { dx: number; dy: number; hits: number } | null = null;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;   // one-pixel shifts were already left out
      let hits = 0;
      for (const i of sample) {
        const x = i % width;
        const y = (i - x) / width;
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        if (x - dx < 0 || x - dx >= width || y - dy < 0 || y - dy >= height) continue;
        if (colorDelta(d, i * 4, b, ((y + dy) * width + x + dx) * 4) <= maxDelta
          && colorDelta(b, i * 4, d, ((y - dy) * width + x - dx) * 4) <= maxDelta) hits += 1;
      }
      const better = !best || hits > best.hits || (hits === best.hits && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy));
      if (hits >= SHIFT_SHARE * sample.length && better) best = { dx, dy, hits };
    }
  }
  return best && { dx: best.dx, dy: best.dy };
}

/** "1 px right", "0.5 px up", "1 px right and 2 px down". */
function shiftWords(x: number, y: number): string {
  const part = (v: number, plus: string, minus: string) => (v === 0 ? '' : `${Math.abs(v)} px ${v > 0 ? plus : minus}`);
  return [part(x, 'right', 'left'), part(y, 'down', 'up')].filter(Boolean).join(' and ');
}

/**
 * How picture `pic` looks across the thin area `r`, judged from its changed pixels against the same
 * picture's pixels one 1x px outside the area on each side that is in the picture:
 * - line: most differ from every side (something is drawn along the area);
 * - flat: most match every side (nothing is drawn there);
 * - edge: neither (the area is the edge between two different colours).
 */
function acrossLook(pic: Uint8Array, changed: number[], r: Rect, across: boolean, width: number, height: number, scale: number): 'line' | 'flat' | 'edge' {
  const maxDelta = maxDeltaOf(PIXEL_THRESHOLD);
  let lines = 0;
  let flats = 0;
  for (const i of changed) {
    const x = i % width;
    const y = (i - x) / width;
    const outside = across
      ? [[x, r.y - scale], [x, r.y + r.height - 1 + scale]]
      : [[r.x - scale, y], [r.x + r.width - 1 + scale, y]];
    const sides = outside.filter(([ox, oy]) => ox >= 0 && ox < width && oy >= 0 && oy < height)
      .map(([ox, oy]) => colorDelta(pic, i * 4, pic, (oy * width + ox) * 4) > maxDelta);
    if (sides.length === 0) continue;
    if (sides.every(Boolean)) lines += 1;
    else if (!sides.some(Boolean)) flats += 1;
  }
  if (lines >= 0.5 * changed.length) return 'line';
  return flats >= 0.5 * changed.length ? 'flat' : 'edge';
}

/** The brightness spread, the number of distinct colours (counted up to PICTURE_COLOURS + 1) and the mean colour of an area. */
function areaLook(pic: Uint8Array, r: Rect, width: number): { spread: number; colours: number; mean: number[] } {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  const mean = [0, 0, 0];
  const colours = new Set<number>();
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const p = (y * width + x) * 4;
      const lum = 0.299 * pic[p] + 0.587 * pic[p + 1] + 0.114 * pic[p + 2];
      n += 1;
      sum += lum;
      sumSq += lum * lum;
      for (let c = 0; c < 3; c++) mean[c] += pic[p + c];
      if (colours.size <= PICTURE_COLOURS) colours.add(((pic[p] >> 3) << 10) | ((pic[p + 1] >> 3) << 5) | (pic[p + 2] >> 3));
    }
  }
  const avg = sum / n;
  return { spread: Math.sqrt(Math.max(0, sumSq / n - avg * avg)), colours: colours.size, mean: mean.map((m) => m / n) };
}

/** True when nearly every changed pixel matches a pixel next to it in the other picture, within a looser colour difference. */
function smoothingOnly(changed: number[], d: Uint8Array, b: Uint8Array, width: number, height: number): boolean {
  const maxDelta = maxDeltaOf(SMOOTHING_THRESHOLD);
  let near = 0;
  for (const i of changed) {
    const x = i % width;
    const y = (i - x) / width;
    if (matchesNearby(d, b, i, x, y, width, height, 1, maxDelta) && matchesNearby(b, d, i, x, y, width, height, 1, maxDelta)) near += 1;
  }
  return near >= SMOOTHING_SHARE * changed.length;
}

/** Grows an area by `by` device px on each side, kept inside the picture. */
function grow(r: Rect, by: number, width: number, height: number): Rect {
  const x = Math.max(0, r.x - by);
  const y = Math.max(0, r.y - by);
  return { x, y, width: Math.min(width, r.x + r.width + by) - x, height: Math.min(height, r.y + r.height + by) - y };
}

/**
 * Names what a changed area (device px) most likely is. In order: moved content; for a thin area, a line
 * (where the design draws one, per `onLine`, or where one picture draws a line and the other nothing)
 * or a shape edge both pictures draw a little differently; for other areas, a picture or content that
 * only one side has, a plain colour change, or edge smoothing; else "content differs".
 */
function describeArea(r: Rect, mask: Uint8Array, d: Uint8Array, b: Uint8Array, width: number, height: number, scale: number,
  onLine: Uint8Array | null): Pick<Region, 'kind' | 'label' | 'similarity' | 'shift'> {
  const changed = changedIn(r, mask, width);
  const similarity = round2(1 - changed.length / (r.width * r.height));
  const named = (kind: AreaKind, label = AREA_KIND_NAMES[kind]) => ({ kind, label, similarity });
  const moved = bestShift(changed, d, b, width, height, Math.round(SHIFT_SEARCH_PX * scale));
  if (moved) {
    const shift = { x: Math.round((moved.dx / scale) * 2) / 2, y: Math.round((moved.dy / scale) * 2) / 2 };
    return { ...named('shifted', `same content shifted ${shiftWords(shift.x, shift.y)}`), shift };
  }
  const thin = LINE_PX * scale;
  const across = r.height <= thin && r.width >= 2 * r.height;
  const down = r.width <= thin && r.height >= 2 * r.width;
  if (across || down) {
    if (onLine && changed.filter((i) => onLine[i]).length >= 0.5 * changed.length) {
      // The design draws a line here. The build either draws something close to it, or not.
      const close = maxDeltaOf(2 * PIXEL_THRESHOLD);
      const similar = changed.filter((i) => colorDelta(d, i * 4, b, i * 4) <= close).length;
      return similar >= 0.5 * changed.length
        ? named('line-differs', 'line drawn a little differently (colour, weight or place)')
        : named('line-missing');
    }
    const design = acrossLook(d, changed, r, across, width, height, scale);
    const build = acrossLook(b, changed, r, across, width, height, scale);
    if (design === 'line' && build === 'flat') return named('line-missing');
    if (build === 'line' && design === 'flat') return named('line-extra');
    if (design !== 'flat' && build !== 'flat') return named('edge-smoothing', 'edge drawn a little differently (smoothing, or less than 1 px apart)');
    return named('different', `content differs (${Math.round(similarity * 100)}% of the area matches)`);
  }
  const inner = { design: areaLook(d, r, width), build: areaLook(b, r, width) };
  const plain = { design: inner.design.spread < PLAIN_SPREAD, build: inner.build.spread < PLAIN_SPREAD };
  if (plain.build && !plain.design) return named(inner.design.colours > PICTURE_COLOURS ? 'blank-picture' : 'missing');
  if (plain.design && !plain.build) return named('extra');
  if (plain.design && plain.build) {
    // A plain area in both: look at its surroundings to tell a missing or extra shape from a colour change.
    const around = grow(r, 2 * scale, width, height);
    const outer = { design: areaLook(d, around, width).spread < PLAIN_SPREAD, build: areaLook(b, around, width).spread < PLAIN_SPREAD };
    if (outer.build && !outer.design) return named('missing');
    if (outer.design && !outer.build) return named('extra');
    return named('colour', `colour differs: design ${hex(inner.design.mean)}, build ${hex(inner.build.mean)}`);
  }
  if (similarity >= 0.5 && smoothingOnly(changed, d, b, width, height)) return named('edge-smoothing');
  return named('different', `content differs (${Math.round(similarity * 100)}% of the area matches)`);
}

/** Counts the areas of each kind: "8× line in design, missing in build; 2× same content shifted". */
export function areaKindSummary(regions: Region[]): string {
  const counts = new Map<AreaKind, number>();
  for (const r of regions) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n}× ${AREA_KIND_NAMES[kind]}`).join('; ');
}

/** The device pixels inside any of `boxes` (given in 1x px), with one 1x px to spare on each side. */
function boxMask(boxes: Rect[], scale: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor((b.x - 1) * scale));
    const y0 = Math.max(0, Math.floor((b.y - 1) * scale));
    const x1 = Math.min(width, Math.ceil((b.x + b.width + 1) * scale));
    const y1 = Math.min(height, Math.ceil((b.y + b.height + 1) * scale));
    for (let y = y0; y < y1; y++) out.fill(1, y * width + x0, y * width + x1);
  }
  return out;
}

/** The difference picture: changed pixels in red over a faded copy of the design. */
function paintDiff(mask: Uint8Array, design: Uint8Array, width: number, height: number): PNG {
  const out = new PNG({ width, height });
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    if (mask[i]) { out.data.set([...DIFF_COLOR, 255], p); continue; }
    const grey = Math.round(255 + ((design[p] * 0.299 + design[p + 1] * 0.587 + design[p + 2] * 0.114) - 255) * 0.1);
    out.data.set([grey, grey, grey, 255], p);
  }
  return out;
}

/** Grows the range [a, b) to at least `min` long around its middle, kept inside [0, limit). */
function growRange(a: number, b: number, min: number, limit: number): [number, number] {
  const extra = Math.max(0, min - (b - a));
  let lo = a - Math.floor(extra / 2);
  let hi = b + Math.ceil(extra / 2);
  if (lo < 0) { hi -= lo; lo = 0; }
  if (hi > limit) { lo -= hi - limit; hi = limit; }
  return [Math.max(0, lo), Math.min(limit, hi)];
}

/**
 * Saves design, build and difference for one area (given in 1x px; the pictures are in device px).
 * The crop is at least MIN_CROP_PX across and down, with space around it. A wide area's panels are
 * stacked top to bottom; other areas' panels sit side by side. Small crops are enlarged by a whole number.
 */
function saveCrop(r: Rect, scale: number, sources: Uint8Array[], width: number, height: number): Buffer {
  const pad = CROP_PAD_PX * scale;
  const min = MIN_CROP_PX * scale;
  const [gx0, gx1] = growRange(r.x * scale, (r.x + r.width) * scale, min, width);
  const [gy0, gy1] = growRange(r.y * scale, (r.y + r.height) * scale, min, height);
  const x0 = Math.max(0, gx0 - pad);
  const y0 = Math.max(0, gy0 - pad);
  const w = Math.min(width, gx1 + pad) - x0;
  const h = Math.min(height, gy1 + pad) - y0;
  const gap = 4 * scale;
  const stacked = w > 2 * h;
  const longSide = stacked ? Math.max(w, 3 * h + 2 * gap) : Math.max(3 * w + 2 * gap, h);
  const zoom = Math.max(1, Math.min(MAX_CROP_ZOOM, Math.floor(CROP_PANEL_MIN_PX / Math.min(w, h)), Math.floor(MAX_CROP_SIDE_PX / longSide)));
  const pw = w * zoom;
  const ph = h * zoom;
  const out = new PNG({ width: stacked ? pw : 3 * pw + 2 * gap, height: stacked ? 3 * ph + 2 * gap : ph });
  out.data.fill(255);
  sources.forEach((src, k) => {
    const ox = stacked ? 0 : k * (pw + gap);
    const oy = stacked ? k * (ph + gap) : 0;
    for (let y = 0; y < ph; y++) {
      const sy = y0 + Math.floor(y / zoom);
      for (let x = 0; x < pw; x++) {
        const from = (sy * width + x0 + Math.floor(x / zoom)) * 4;
        out.data.set(src.subarray(from, from + 4), ((oy + y) * out.width + ox + x) * 4);
      }
    }
  });
  return PNG.sync.write(out);
}

export interface OverlayOptions {
  /** The page's colour, painted under transparent parts of the design picture. Default white. */
  background?: Rgb;
  /** Boxes (1x px) of text elements whose numbers match the design. Letter-edge noise inside them is dropped. */
  textBoxes?: Rect[];
  /** Boxes (1x px) where the design draws a line: frame lines and thin layers. A thin changed area there is a line. */
  lineBoxes?: Rect[];
}

/**
 * Compares the design and build pictures (taken at `scale`). The design is first painted on the page's
 * background, changes that a one-device-pixel shift explains are ignored, and letter-edge noise inside
 * matching text is dropped (counted in textEdgeAreas). Saves design.png, build.png and diff.png in
 * `outDir`, plus a design, build and difference crop for each of the biggest areas (areas/area-N.png).
 * Returns the changed areas in 1x CSS px, biggest first, each named with what it most likely is (see AreaKind).
 */
export async function makeOverlay(designPng: Buffer, buildPng: Buffer, outDir: string, scale: number, options: OverlayOptions = {}): Promise<{
  designPath: string; buildPath: string; diffPath: string; regions: Region[]; diffPixels: number; textEdgeAreas: number;
}> {
  const background = options.background ?? { r: 255, g: 255, b: 255 };
  const design = PNG.sync.read(designPng);
  const build = PNG.sync.read(buildPng);
  const width = Math.max(design.width, build.width);
  const height = Math.max(design.height, build.height);
  const d = onBackground(padTo(design, width, height), background);
  const b = onBackground(padTo(build, width, height), background);
  const marked = new PNG({ width, height });
  pixelmatch(d, b, marked.data, width, height, { threshold: PIXEL_THRESHOLD, includeAA: false, diffColor: DIFF_COLOR });
  // pixelmatch paints changed pixels pure red. Unchanged pixels are grey and edge-smoothing pixels are yellow.
  // It takes a one-pixel line next to a plain colour for edge smoothing. Where the design draws a line, it is not.
  const onLine = options.lineBoxes?.length ? boxMask(options.lineBoxes, scale, width, height) : null;
  const lineDelta = maxDeltaOf(PIXEL_THRESHOLD);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    const [r, g, bl] = [marked.data[p], marked.data[p + 1], marked.data[p + 2]];
    if (r === 255 && g === 0 && bl === 0) mask[i] = 1;
    else if (onLine?.[i] && r === 255 && g === 255 && bl === 0 && colorDelta(d, p, b, p) > lineDelta) mask[i] = 1;
  }
  ignoreOnePixelShifts(mask, d, b, width, height);
  const inText = options.textBoxes?.length ? boxMask(options.textBoxes, scale, width, height) : null;
  if (inText) ignoreShifts(mask, d, b, width, height, TEXT_SHIFT_PX, TEXT_PIXEL_THRESHOLD, inText);

  // Changed pixels per area. Small areas wholly inside matching text are letter-edge noise: drop them.
  let textEdgeAreas = 0;
  const found: (Rect & { pixels: number } & ReturnType<typeof describeArea>)[] = [];
  for (const r of findRegions(mask, width, height, MERGE_DISTANCE_PX * scale)) {
    let pixels = 0;
    let allInText = inText !== null;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        pixels += 1;
        if (inText && !inText[i]) allInText = false;
      }
    }
    if (allInText && pixels <= TEXT_NOISE_MAX_PIXELS) {
      textEdgeAreas += 1;
      for (let y = r.y; y < r.y + r.height; y++) mask.fill(0, y * width + r.x, y * width + r.x + r.width);
      continue;
    }
    found.push({ ...r, pixels, ...describeArea(r, mask, d, b, width, height, scale, onLine) });
  }
  const regions: Region[] = found.map(({ x, y, width: w, height: h, ...rest }) => ({ ...toCss({ x, y, width: w, height: h }, scale), ...rest }))
    .sort((p, q) => q.pixels - p.pixels || p.y - q.y || p.x - q.x);
  const diffPixels = mask.reduce((n, v) => n + v, 0);
  const diff = paintDiff(mask, d, width, height);

  await mkdir(outDir, { recursive: true });
  const designPath = path.join(outDir, 'design.png');
  const buildPath = path.join(outDir, 'build.png');
  const diffPath = path.join(outDir, 'diff.png');
  await writeFile(designPath, designPng);
  await writeFile(buildPath, buildPng);
  await writeFile(diffPath, PNG.sync.write(diff));
  const areasDir = path.join(outDir, 'areas');
  await rm(areasDir, { recursive: true, force: true });   // crops from an earlier round would mislead
  if (regions.length > 0) await mkdir(areasDir, { recursive: true });
  for (const [n, region] of regions.slice(0, MAX_CROPS).entries()) {
    region.crop = path.join(areasDir, `area-${n + 1}.png`);
    await writeFile(region.crop, saveCrop(region, scale, [d, b, diff.data], width, height));
  }
  return { designPath, buildPath, diffPath, regions, diffPixels, textEdgeAreas };
}

/** The share (0 to 1) of pixels that differ between two pictures of the same place, after one-pixel shifts are left out. */
export function changedShare(aPng: Buffer, bPng: Buffer): number {
  const a = PNG.sync.read(aPng);
  const b = PNG.sync.read(bPng);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const white = { r: 255, g: 255, b: 255 };
  const pa = onBackground(padTo(a, width, height), white);
  const pb = onBackground(padTo(b, width, height), white);
  const marked = new PNG({ width, height });
  pixelmatch(pa, pb, marked.data, width, height, { threshold: PIXEL_THRESHOLD, includeAA: false, diffColor: DIFF_COLOR });
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    if (marked.data[p] === 255 && marked.data[p + 1] === 0 && marked.data[p + 2] === 0) mask[i] = 1;
  }
  ignoreOnePixelShifts(mask, pa, pb, width, height);
  return mask.length === 0 ? 0 : mask.reduce((n, v) => n + v, 0) / mask.length;
}

/** Shrinks a picture by a whole-number factor (2 turns a 2x picture into 1x). Each new pixel is the average of its block. */
export function downscalePng(png: Buffer, scale: number): Buffer {
  const f = Math.round(scale);
  if (f <= 1) return png;
  const src = PNG.sync.read(png);
  const width = Math.ceil(src.width / f);
  const height = Math.ceil(src.height / f);
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let sy = y * f; sy < Math.min(src.height, (y + 1) * f); sy++) {
        for (let sx = x * f; sx < Math.min(src.width, (x + 1) * f); sx++) {
          const p = (sy * src.width + sx) * 4;
          for (let c = 0; c < 4; c++) sum[c] += src.data[p + c];
          n++;
        }
      }
      out.data.set(sum.map((s) => Math.round(s / n)), (y * width + x) * 4);
    }
  }
  return PNG.sync.write(out);
}
