import type { LayoutHint } from './layoutHints';
import { describeInteraction, easingCss } from './motion';
import type { MotionHint } from './motionHints';
import type { LinkedStyle } from './styles';
import type { Color, Effect, Fill, Layer, SectionData } from './types';

/** Longest text quoted on a layer's line; longer text is cut with "…". */
const MAX_TEXT_CHARS = 80;

const n = (v: number): string => String(Math.round(v * 100) / 100);
const color = (c: Color): string => (c.alpha >= 1 ? c.hex : `${c.hex}/${n(c.alpha)}`);
// Names and text come from the design file, so they are quoted (JSON.stringify writes line breaks as \n
// and escapes quotes; the Unicode line and paragraph separators are escaped too) or cleaned. A layer
// name can then never start a new line or fake a field.
const json = (text: string): string => JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const quote = (text: string): string => json(text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text);
const name = (text: string): string => json(text);
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f\u2028\u2029|]/g, ' ');

function fill(f: Fill): string {
  if (f.type === 'solid') return color(f.color);
  if (f.type === 'gradient') {
    return `${f.kind}(${n(f.angleDeg)}°: ${f.stops.map((s) => `${color(s.color)} ${n(s.position * 100)}%`).join(', ')})`;
  }
  const parts = [`image ${f.imageRef} ${f.scaleMode}`];
  if (f.crop) parts.push(`crop ${n(f.crop.x)},${n(f.crop.y)} ${n(f.crop.width)}×${n(f.crop.height)}`);
  if (f.css) parts.push(`css size ${f.css.backgroundSize} pos ${f.css.backgroundPosition}`);
  if (f.rotation) parts.push(`rot ${n(f.rotation)}°`);
  if (f.filters) parts.push(`filters ${Object.entries(f.filters).map(([k, v]) => `${k}=${n(v)}`).join(' ')}`);
  return `${parts.join('; ')}`;
}

function effect(e: Effect): string {
  if (e.type === 'layer-blur') return `blur(${n(e.blur)})`;
  if (e.type === 'background-blur') return `bgblur(${n(e.blur)})`;
  const name = e.type === 'inner-shadow' ? 'inner' : 'shadow';
  return `${name}(${n(e.x)} ${n(e.y)} ${n(e.blur)} ${n(e.spread)} ${e.color ? color(e.color) : 'none'})`;
}

const RESIZE: Record<string, string> = { WIDTH_AND_HEIGHT: 'hug', HEIGHT: 'fixed-width', NONE: 'fixed', TRUNCATE: 'truncate' };

function text(t: NonNullable<Layer['text']>): string[] {
  const run = t.runs[t.dominantRun];
  const out = [quote(t.characters)];
  if (run) {
    out.push(`${clean(run.fontFamily)} ${run.fontWeight} ${n(run.fontSize)}/${n(run.lineHeightPx)}`);
    if (run.letterSpacingPx) out.push(`ls${n(run.letterSpacingPx)}`);
    if (run.textCase && run.textCase !== 'ORIGINAL') out.push(run.textCase.toLowerCase());
    if (run.textDecoration && run.textDecoration !== 'NONE') out.push(run.textDecoration.toLowerCase());
    out.push(color(run.color));
  }
  out.push(t.align.toLowerCase(), RESIZE[t.autoResize] ?? t.autoResize.toLowerCase(), `${t.lineCount} line${t.lineCount === 1 ? '' : 's'}`);
  if (t.hasMissingFont) out.push('MISSING FONT');
  if (t.runs.length > 1) {
    const others = t.runs.filter((_, i) => i !== t.dominantRun)
      .map((r) => `${r.start}-${r.end} ${clean(r.fontFamily)} ${r.fontWeight} ${n(r.fontSize)}/${n(r.lineHeightPx)} ${color(r.color)}`);
    out.push(`other runs: ${others.join('; ')}`);
  }
  return out;
}

/** One line for a layer: everything compare checks, in a short form. */
function line(l: Layer): string {
  const out = [name(l.name), clean(l.id), clean(l.type), `${n(l.x)},${n(l.y)}`, `${n(l.width)}×${n(l.height)}`];
  if (l.rotation) out.push(`rot ${n(l.rotation)}° (${l.size ? `${n(l.size.width)}×${n(l.size.height)}` : 'size ?'})`);
  if (l.layout.mode !== 'none') {
    out.push(`${l.layout.mode} gap ${n(l.layout.gap)} pad ${l.layout.padding.map(n).join('/')} align ${l.layout.mainAlign}/${l.layout.crossAlign}`
      + `${l.layout.wrap ? ' wrap' : ''} size ${l.layout.sizingH}/${l.layout.sizingV}`);
  }
  if (l.layout.absolute) out.push('absolute');
  if (l.text) out.push(...text(l.text));
  else if (l.fills.length) out.push(`fill ${l.fills.map(fill).join(' + ')}`);
  for (const s of l.strokes) out.push(`stroke ${s.weights.map(n).join('/')} ${color(s.color)} ${clean(s.align.toLowerCase())}`);
  if (l.radius.some((r) => r > 0)) out.push(`r ${l.radius.every((r) => r === l.radius[0]) ? n(l.radius[0]) : l.radius.map(n).join('/')}`);
  if (l.effects.length) out.push(l.effects.map(effect).join(' '));
  if (l.opacity < 1) out.push(`opacity ${n(l.opacity)}`);
  if (l.blendMode !== 'PASS_THROUGH' && l.blendMode !== 'NORMAL') out.push(`blend ${l.blendMode.toLowerCase()}`);
  if (l.clips) out.push('clips');
  return out.join(' | ');
}

/** The motion facts of one layer, one line each. */
function motionLines(l: Layer): string[] {
  const m = l.motion;
  if (!m) return [];
  const who = `${name(l.name)} ${clean(l.id)}`;
  const out: string[] = [];
  for (const i of m.interactions ?? []) out.push(`${who}: ${clean(describeInteraction(i))}`);
  if (m.states) {
    const list = m.states.variants.map((v) => `${name(v.name)} (${clean(v.id)})`).join(', ');
    const now = Object.entries(m.states.current).map(([k, v]) => `${k}=${v}`).join(', ');
    out.push(`${who}: states of ${name(m.states.setName)}: ${clean(list)}; this one is ${clean(now)}`);
    for (const v of m.states.variants) {
      for (const i of v.interactions) out.push(`${who}: in state ${name(v.name)}: ${clean(describeInteraction(i))}`);
    }
  }
  if (m.scroll === 'fixed') out.push(`${who}: stays put while the page scrolls (fixed)`);
  if (m.scroll === 'sticky') out.push(`${who}: scrolls, then sticks to the top (sticky)`);
  if (m.overflow) out.push(`${who}: scrolls inside itself (${m.overflow.toLowerCase()})`);
  for (const media of m.media ?? []) out.push(`${who}: ${media.kind === 'gif' ? 'animated GIF' : 'video'} fill`);
  for (const link of m.links ?? []) out.push(`${who}: link ${quote(link.text)} → ${link.url ? quote(link.url) : `frame ${clean(link.nodeId ?? '')}`}`);
  if (m.animations) {
    for (const st of m.animations.styles) out.push(`${who}: Figma Motion style ${name(st.name)}${st.durationMs !== undefined ? ` ${st.durationMs} ms` : ''}`);
    for (const t of m.animations.tracks) {
      const keys = t.keyframes.map((k) => `${k.atMs} ms ${JSON.stringify(k.value)}${k.easing ? ` ${easingCss(k.easing) ?? k.easing.type.toLowerCase()}` : ''}`);
      out.push(`${who}: keyframes ${clean(t.property.toLowerCase())} over ${t.durationMs} ms: ${clean(keys.join(' → '))}`);
    }
  }
  return out;
}

/**
 * A short, readable form of a section: one line per visible layer (indented by depth), then the full
 * text of long texts and texts with line breaks, the layout hints, motion, motion hints, linked styles,
 * fonts, variables and warnings. It holds every value compare checks.
 */
export function formatCompact(section: SectionData, hints: LayoutHint[], styles: LinkedStyle[], guesses: MotionHint[] = []): string {
  const lines = [`Section ${name(section.name)} ${clean(section.rootId)}, ${n(section.width)}×${n(section.height)}. Positions are from the section's top-left. Fields are separated by " | ". Names and text are in quotes.`, '', 'Layers:'];
  const walk = (l: Layer, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${line(l)}`);
    l.children.forEach((c) => walk(c, depth + 1));
  };
  walk(section.root, 0);
  // Texts the layer lines cut short, and texts with line breaks, in full: the build needs every character and break.
  const full: string[] = [];
  const collectText = (l: Layer): void => {
    const t = l.text?.characters;
    if (t !== undefined && (t.length > MAX_TEXT_CHARS || /[\n\r\u2028\u2029]/.test(t))) full.push(`- ${name(l.name)} ${clean(l.id)}: ${json(t)}`);
    l.children.forEach(collectText);
  };
  collectText(section.root);
  if (full.length) lines.push('', 'Full text (texts cut short above, and texts with line breaks; \\n is a line break):', ...full);
  if (hints.length) {
    lines.push('', 'Layout hints (layers placed at fixed spots):');
    for (const h of hints) {
      const extra = [h.gap !== undefined ? `gap ${n(h.gap)}` : '', h.columns ? `${h.columns} columns` : '',
        h.columnGap !== undefined ? `column gap ${n(h.columnGap)}` : '', h.rowGap !== undefined ? `row gap ${n(h.rowGap)}` : '',
        h.groups ? `groups ${h.groups.map((g) => `[${g.join(', ')}]`).join(' ')}` : ''].filter(Boolean).join(', ');
      lines.push(`- ${h.kind} in ${h.parentId}: ${h.childIds.join(', ')}${extra ? ` (${extra})` : ''}`);
    }
  }
  const motion: string[] = [];
  const collect = (l: Layer): void => { motion.push(...motionLines(l)); l.children.forEach(collect); };
  collect(section.root);
  if (motion.length) {
    lines.push('', 'Motion (what the designer set in Figma):');
    for (const m of motion) lines.push(`- ${m}`);
  }
  if (section.motionRead === false) lines.push('', `Motion was not read: ${clean(section.motionError ?? 'unknown reason')}`);
  if (guesses.length) {
    lines.push('', 'Motion hints (guesses from the still design; ask the owner before building them):');
    for (const g of guesses) lines.push(`- ${g.kind} in ${name(g.layerName)} ${clean(g.layerId)}, ${g.confidence} confidence: ${clean(g.reason)}`);
  }
  if (styles.length) {
    lines.push('', 'Styles:');
    for (const s of styles) lines.push(`- ${clean(s.layerId)} ${clean(s.kind)}: ${name(s.name)}`);
  }
  if (section.fonts.length) {
    lines.push('', 'Fonts:');
    for (const f of section.fonts) lines.push(`- ${clean(f.family)} ${clean(f.style)} (${f.weight})${f.missingInFigma ? ' MISSING IN FIGMA' : ''}`);
  }
  if (section.variables.length) {
    lines.push('', 'Variables:');
    for (const v of section.variables) lines.push(`- ${clean(v.nodeId)} ${clean(v.property)}: ${name(`${v.collectionName}/${v.variableName}`)} = ${JSON.stringify(v.value)}`);
  }
  if (section.warnings.length) {
    lines.push('', 'Warnings (things Pixel Twin can\'t check exactly):');
    for (const w of section.warnings) lines.push(`- ${clean(w.layerId)} ${name(w.layerName)}: ${clean(w.reason)}`);
  }
  return lines.join('\n');
}

/**
 * For a section too big to read at once: its own layer, its parts (the direct children, top to bottom) to
 * read one at a time, and the styles, fonts and variables used anywhere in it, each listed once.
 */
export function formatOverview(section: SectionData, styles: LinkedStyle[], tokens: number): string {
  const parts = [...section.root.children].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [
    `Section ${quote(section.name)} ${clean(section.rootId)}, ${n(section.width)}×${n(section.height)}, is too big to read at once (about ${tokens} tokens).`,
    'Read its parts one at a time with get_section, and build each part before you read the next. Names are in quotes, cut after 80 characters.',
    '',
    'Its own layer (fields separated by " | "):',
    line(section.root),
    ...motionLines(section.root).map((m) => `- ${m}`),
    '',
    `Parts, top to bottom (${parts.length}):`,
    ...parts.map((l) => `- ${quote(l.name)} ${clean(l.id)} ${clean(l.type)} ${n(l.x)},${n(l.y)} ${n(l.width)}×${n(l.height)}`),
  ];
  const styleNames = [...new Set(styles.map((s) => `- ${clean(s.kind)}: ${name(s.name)}`))];
  if (styleNames.length) lines.push('', 'Styles used:', ...styleNames);
  if (section.fonts.length) {
    lines.push('', 'Fonts:');
    for (const f of section.fonts) lines.push(`- ${clean(f.family)} ${clean(f.style)} (${f.weight})${f.missingInFigma ? ' MISSING IN FIGMA' : ''}`);
  }
  const variables = [...new Set(section.variables.map((v) => `- ${name(`${v.collectionName}/${v.variableName}`)} = ${JSON.stringify(v.value)}`))];
  if (variables.length) lines.push('', 'Variables used:', ...variables);
  if (section.warnings.length) lines.push('', `${section.warnings.length} warnings: get_section lists them with each part.`);
  return lines.join('\n');
}
