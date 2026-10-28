import { median } from './geometry';
import type { Fill, Layer } from './types';

/**
 * Motion the design probably wants but does not set: a guess from the still frame, with how sure it is
 * and why. The agent asks the owner before building any of it.
 */
export interface MotionHint {
  kind: 'marquee' | 'carousel' | 'tabs' | 'named';
  layerId: string;
  layerName: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** Words in a layer name that name a moving pattern. */
const PATTERN_NAME = /\b(marquee|ticker|carousel|slider|swiper|accordion|tabs?|dropdown|modal|dialog|drawer|lightbox|toast|tooltip)\b/i;
/** Cards count as the same size when their widths differ by at most this share. */
const SAME_SIZE_SHARE = 0.1;
/** A label must be at least this long to match a picture's name. */
const MIN_LABEL_CHARS = 3;

const right = (l: Layer) => l.x + l.width;

/** True when at least 3 children sit side by side on one line (their middles within half the median height). */
function inARow(children: Layer[]): boolean {
  if (children.length < 3) return false;
  const mid = median(children.map((c) => c.y + c.height / 2));
  const tall = median(children.map((c) => c.height));
  return children.every((c) => Math.abs(c.y + c.height / 2 - mid) <= tall / 2);
}

/** True when at least 3 children sit on top of each other (their middles within half the median width). */
function inAColumn(children: Layer[]): boolean {
  if (children.length < 3) return false;
  const mid = median(children.map((c) => c.x + c.width / 2));
  const wide = median(children.map((c) => c.width));
  return children.every((c) => Math.abs(c.x + c.width / 2 - mid) <= wide / 2);
}

/** The first text inside a layer (or its own), used as its label. */
function labelOf(layer: Layer): string {
  if (layer.text) return layer.text.characters.trim();
  for (const c of layer.children) {
    const t = labelOf(c);
    if (t) return t;
  }
  return '';
}

const fillKey = (f: Fill | undefined) => (!f ? 'none' : f.type === 'solid' ? `${f.color.hex}/${f.color.alpha}` : f.type);

/** What makes a list item look selected: its fill, border, opacity and the colour and weight of its text. */
function lookOf(layer: Layer): string {
  const text = (l: Layer): Layer | undefined => (l.text ? l : l.children.map(text).find(Boolean));
  const t = text(layer)?.text;
  const run = t?.runs[t.dominantRun];
  return [fillKey(layer.fills[0]), layer.strokes.length, layer.opacity, run ? `${run.color.hex}/${run.fontWeight}` : ''].join('|');
}

const hasImage = (l: Layer): boolean => l.fills.some((f) => f.type === 'image') || l.children.some(hasImage);

/**
 * Looks for motion the still design suggests:
 * - marquee: a row of 3 or more items cut off at both ends by the frame that clips it (a logo strip);
 * - carousel: 3 or more cards of the same size running past one edge;
 * - tabs: a list where exactly one item looks different (selected), most likely when a picture is named like it;
 * - named: a layer named like a moving pattern (Marquee, Carousel, Tabs, Accordion, Dropdown, Modal and so on).
 */
export function motionHints(root: Layer): MotionHint[] {
  const hints: MotionHint[] = [];
  const all: Layer[] = [];
  const index = (l: Layer): void => { all.push(l); l.children.forEach(index); };
  index(root);

  const visit = (layer: Layer, clip: Layer): void => {
    const who = { layerId: layer.id, layerName: layer.name };
    const named = PATTERN_NAME.exec(layer.name);
    if (named) hints.push({ kind: 'named', ...who, confidence: 'high', reason: `Named "${layer.name}": the designer marked it as a moving pattern (${named[1].toLowerCase()})` });

    const kids = layer.children;
    const box = layer.clips ? layer : clip;
    if (inARow(kids)) {
      const cutLeft = kids.some((c) => c.x < box.x - 0.5);
      const cutRight = kids.some((c) => right(c) > right(box) + 0.5);
      const widths = kids.map((c) => c.width);
      const sameSize = Math.max(...widths) - Math.min(...widths) <= SAME_SIZE_SHARE * Math.max(...widths);
      if (cutLeft && cutRight) {
        hints.push({ kind: 'marquee', ...who, confidence: box.clips ? 'high' : 'medium',
          reason: `A row of ${kids.length} items cut off at both ends by "${box.name}": it usually scrolls on its own (a marquee)` });
      } else if ((cutLeft || cutRight) && sameSize) {
        hints.push({ kind: 'carousel', ...who, confidence: 'medium',
          reason: `${kids.length} same-size items run past the ${cutRight ? 'right' : 'left'} edge of "${box.name}": it is probably a carousel` });
      }
    }
    if (inARow(kids) || inAColumn(kids)) {
      // Exactly two looks, and one of them belongs to a single item: that item looks selected.
      const looks = kids.map(lookOf);
      const counts = new Map<string, number>();
      for (const k of looks) counts.set(k, (counts.get(k) ?? 0) + 1);
      const single = [...counts].filter(([, n]) => n === 1);
      if (counts.size === 2 && single.length === 1) {
        const item = kids[looks.indexOf(single[0][0])];
        const label = labelOf(item).toLowerCase();
        const inside = new Set<string>();
        const mark = (l: Layer): void => { inside.add(l.id); l.children.forEach(mark); };
        mark(layer);
        const picture = label.length >= MIN_LABEL_CHARS
          ? all.find((l) => !inside.has(l.id) && l.name.toLowerCase().includes(label) && hasImage(l))
          : undefined;
        hints.push(picture
          ? { kind: 'tabs', ...who, confidence: 'medium',
            reason: `One item, "${labelOf(item)}", looks selected and a picture is named like it ("${picture.name}"): tabs, or a list that swaps the picture on hover` }
          : { kind: 'tabs', ...who, confidence: 'low',
            reason: `One item of ${kids.length}, "${labelOf(item) || item.name}", looks different: a selected tab or menu item` });
      }
    }
    kids.forEach((c) => visit(c, box));
  };
  visit(root, root);
  return hints;
}
