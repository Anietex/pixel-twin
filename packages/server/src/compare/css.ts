import type { Color } from '../design/types';

/** Reads computed CSS values from the browser. Every parser returns null for a value it does not understand. */

export interface Rgba { r: number; g: number; b: number; a: number }
export interface Shadow { inset: boolean; color: Rgba; x: number; y: number; blur: number; spread: number }
export interface Gradient { kind: string; angleDeg: number | null; stops: { color: Rgba; position: number }[] }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Splits on `sep` (',' or whitespace) outside brackets. */
export function splitTopLevel(value: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    const splits = depth === 0 && (sep === ',' ? ch === ',' : /\s/.test(ch));
    if (splits) { out.push(part); part = ''; } else part += ch;
  }
  out.push(part);
  return out.map((p) => p.trim()).filter((p) => p !== '');
}

/** '12px' or '0' as a number of px. */
export function parsePx(value: string): number | null {
  const m = /^(-?[\d.]+(?:e-?\d+)?)(px)?$/i.exec(value.trim());
  return m && (m[2] || Number(m[1]) === 0) ? Number(m[1]) : null;
}

/** A number, or a percentage of `percentOf`. 'none' counts as 0. */
function amount(token: string, percentOf: number): number | null {
  if (token === 'none') return 0;
  const m = /^(-?[\d.]+(?:e-?\d+)?)(%)?$/.exec(token);
  if (!m) return null;
  return m[2] ? (Number(m[1]) / 100) * percentOf : Number(m[1]);
}

/** Splits 'x y z / alpha' into three channel tokens and the alpha (1 when left out). */
function channels(inner: string): { c: string[]; alpha: number } | null {
  const [main, alphaText, extra] = inner.split('/');
  const c = main.trim().split(/\s+/);
  const alpha = alphaText === undefined ? 1 : amount(alphaText.trim(), 1);
  if (extra !== undefined || c.length !== 3 || alpha === null) return null;
  return { c, alpha: Math.min(1, Math.max(0, alpha)) };
}

/** A 0..1 sRGB channel as 0..255, clamped. */
const toByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
/** Linear light to sRGB (the standard sRGB transfer curve). */
const encode = (x: number) => {
  const v = Math.min(1, Math.max(0, x));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

/** OKLab to sRGB, with Björn Ottosson's published matrices. */
function fromOklab(L: number, a: number, b: number, alpha: number): Rgba {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: toByte(encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: toByte(encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: toByte(encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    a: alpha,
  };
}

/** rgb()/rgba() in comma or space form, oklab(), oklch(), color(srgb ...), or 'transparent'. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(v);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1);
    return { r: Math.round(Number(rgb[1])), g: Math.round(Number(rgb[2])), b: Math.round(Number(rgb[3])), a };
  }
  const ok = /^(oklab|oklch)\((.*)\)$/.exec(v);
  if (ok) {
    const ch = channels(ok[2]);
    if (!ch) return null;
    const L = amount(ch.c[0], 1);
    if (ok[1] === 'oklab') {
      const a = amount(ch.c[1], 0.4);
      const b = amount(ch.c[2], 0.4);
      return L === null || a === null || b === null ? null : fromOklab(L, a, b, ch.alpha);
    }
    const C = amount(ch.c[1], 0.4);
    const h = ch.c[2] === 'none' ? 0 : parseAngle(ch.c[2]) ?? amount(ch.c[2], 1);
    if (L === null || C === null || h === null) return null;
    const rad = (h * Math.PI) / 180;
    return fromOklab(L, C * Math.cos(rad), C * Math.sin(rad), ch.alpha);
  }
  const srgb = /^color\(\s*srgb\s+(.*)\)$/.exec(v);
  if (srgb) {
    const ch = channels(srgb[1]);
    const [r, g, b] = ch ? ch.c.map((t) => amount(t, 1)) : [null, null, null];
    return ch && r !== null && g !== null && b !== null ? { r: toByte(r), g: toByte(g), b: toByte(b), a: ch.alpha } : null;
  }
  return null;
}

export function fromDesign(c: Color): Rgba {
  const n = parseInt(c.hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: c.alpha };
}

/** '#RRGGBB' when fully opaque, otherwise 'rgba(r, g, b, a)'. */
export function formatColor(c: Rgba): string {
  if (c.a >= 1) return `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${round2(c.a)})`;
}

/** The first family in a font-family list, without quotes. */
export function firstFamily(value: string): string {
  return (splitTopLevel(value, ',')[0] ?? '').replace(/^["']|["']$/g, '').trim();
}

/** box-shadow as a list in CSS order. 'none' is an empty list. */
export function parseShadows(value: string): Shadow[] | null {
  if (value.trim() === 'none' || value.trim() === '') return [];
  const shadows: Shadow[] = [];
  for (const part of splitTopLevel(value, ',')) {
    let color: Rgba | null = null;
    let inset = false;
    const lengths: number[] = [];
    for (const token of splitTopLevel(part, ' ')) {
      if (token === 'inset') { inset = true; continue; }
      const px = parsePx(token);
      if (px !== null) { lengths.push(px); continue; }
      color = parseColor(token);
      if (!color) return null;
    }
    if (!color || lengths.length < 2 || lengths.length > 4) return null;
    const [x, y, blur = 0, spread = 0] = lengths;
    shadows.push({ inset, color, x, y, blur, spread });
  }
  return shadows;
}

export function formatShadow(s: Shadow): string {
  return `${formatColor(s.color)} ${round2(s.x)}px ${round2(s.y)}px ${round2(s.blur)}px ${round2(s.spread)}px${s.inset ? ' inset' : ''}`;
}

/** The px value of a filter that is only 'blur(Npx)'. 'none' is 0. */
export function parseBlur(value: string): number | null {
  const v = value.trim();
  if (v === 'none' || v === '') return 0;
  const m = /^blur\((.+)\)$/.exec(v);
  return m ? parsePx(m[1]) : null;
}

const ANGLE_UNITS: Record<string, number> = { deg: 1, rad: 180 / Math.PI, turn: 360, grad: 0.9 };
function parseAngle(value: string): number | null {
  const m = /^(-?[\d.]+)(deg|rad|turn|grad)$/.exec(value.trim());
  return m ? Number(m[1]) * ANGLE_UNITS[m[2]] : null;
}

/** The angle of 'to top', 'to right top' and so on. Corner angles depend on the box shape. */
function keywordAngle(words: string[], box: { width: number; height: number }): number | null {
  const has = (w: string) => words.includes(w);
  const corner = (Math.atan2(box.height, box.width) * 180) / Math.PI;
  if (words.length === 1) return ({ top: 0, right: 90, bottom: 180, left: 270 } as Record<string, number>)[words[0]] ?? null;
  if (has('top') && has('right')) return corner;
  if (has('bottom') && has('right')) return 180 - corner;
  if (has('bottom') && has('left')) return 180 + corner;
  if (has('top') && has('left')) return 360 - corner;
  return null;
}

/** Fills in missing stop positions the way CSS does: first 0, last 1, the rest evenly spaced. */
function placeStops(stops: { color: Rgba; position: number | null }[]): { color: Rgba; position: number }[] {
  const pos = stops.map((s) => s.position);
  if (pos[0] === null) pos[0] = 0;
  if (pos[pos.length - 1] === null) pos[pos.length - 1] = 1;
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] !== null) { pos[i] = Math.max(pos[i]!, pos[i - 1]!); continue; }
    let j = i;
    while (pos[j] === null) j++;
    const from = pos[i - 1]!;
    for (let k = i; k < j; k++) pos[k] = from + ((pos[j]! - from) * (k - i + 1)) / (j - i + 1);
  }
  return stops.map((s, i) => ({ color: s.color, position: pos[i]! }));
}

/** One linear, radial or conic gradient. Stop positions must be in %. */
export function parseGradient(value: string, box: { width: number; height: number }): Gradient | null {
  if (splitTopLevel(value, ',').length !== 1) return null;   // more than one background layer
  const m = /^((?:repeating-)?(?:linear|radial|conic))-gradient\((.*)\)$/s.exec(value.trim());
  if (!m) return null;
  const kind = m[1];
  const args = splitTopLevel(m[2], ',');
  let angleDeg: number | null = kind.endsWith('radial') ? null : kind.endsWith('linear') ? 180 : 0;
  const first = splitTopLevel(args[0] ?? '', ' ');
  if (first.length > 0 && !parseColor(first[0])) {
    args.shift();
    if (kind.endsWith('linear')) {
      angleDeg = first[0] === 'to' ? keywordAngle(first.slice(1), box) : parseAngle(first[0]);
      if (angleDeg === null) return null;
    } else if (kind.endsWith('conic')) {
      const from = first.indexOf('from');
      if (from >= 0) angleDeg = parseAngle(first[from + 1] ?? '');
      if (angleDeg === null) return null;
    }
  }
  const stops: { color: Rgba; position: number | null }[] = [];
  for (const arg of args) {
    const [colorText, ...positions] = splitTopLevel(arg, ' ');
    const color = parseColor(colorText);
    if (!color || positions.length > 2) return null;
    if (positions.length === 0) stops.push({ color, position: null });
    for (const p of positions) {
      const pm = /^(-?[\d.]+)%$/.exec(p);
      if (!pm) return null;
      stops.push({ color, position: Number(pm[1]) / 100 });
    }
  }
  if (stops.length < 2) return null;
  return { kind, angleDeg: angleDeg === null ? null : ((angleDeg % 360) + 360) % 360, stops: placeStops(stops) };
}
