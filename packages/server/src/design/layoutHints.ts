import type { Layer } from './types';
import { type Box, bottom, contains, horizontalShare, intersects, median, right, roundHalf, verticalShare } from './geometry';

export interface LayoutHint {
  parentId: string; kind: 'row' | 'column' | 'grid' | 'overlay' | 'background'; childIds: string[];
  gap?: number; columns?: number; rowGap?: number; columnGap?: number; groups?: string[][];
}

const SLACK = 1;       // px of sideways (or downward) overlap we still call "not overlapping"
const ALIGN = 2;       // px within which edges count as lined up
const MIN_SHARE = 0.5; // share of the smaller side two boxes must have in common

export function layoutHints(root: Layer): LayoutHint[] {
  const hints: LayoutHint[] = [];
  const visit = (layer: Layer): void => {
    if (layer.layout.mode === 'none' && layer.children.length >= 2) hints.push(...hintsFor(layer));
    layer.children.forEach(visit);
  };
  visit(root);
  return hints;
}

/**
 * Pairs of layers that overlap in the design, at any depth. A layer and its own children are not a pair.
 * check_responsive allows these overlaps in the build, including between the elements inside them.
 */
export function overlappingPairs(root: Layer): [string, string][] {
  const all: { layer: Layer; path: Set<string> }[] = [];
  const collect = (layer: Layer, ancestors: string[]): void => {
    all.push({ layer, path: new Set(ancestors) });
    layer.children.forEach((c) => collect(c, [...ancestors, layer.id]));
  };
  root.children.forEach((c) => collect(c, []));
  const pairs: [string, string][] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (b.path.has(a.layer.id) || a.path.has(b.layer.id)) continue;
      if (intersects(a.layer, b.layer)) pairs.push([a.layer.id, b.layer.id]);
    }
  }
  return pairs;
}

function hintsFor(parent: Layer): LayoutHint[] {
  const hints: LayoutHint[] = [];
  const parentId = parent.id;

  // 1a. Backgrounds: a child that fully contains 2 or more siblings. Only the background leaves the set.
  const backgrounds = parent.children.filter(
    (c) => parent.children.filter((s) => s !== c && contains(c, s)).length >= 2);
  for (const bg of backgrounds) hints.push({ parentId, kind: 'background', childIds: [bg.id] });
  let rest = parent.children.filter((c) => !backgrounds.includes(c));

  // 1b. Overlays: a child fully inside a sibling leaves the set. The smallest containing sibling is the host.
  for (const child of [...rest]) {
    const hosts = rest.filter((s) => s !== child && contains(s, child));
    if (hosts.length === 0) continue;
    const host = hosts.reduce((m, h) => (h.width * h.height < m.width * m.height ? h : m));
    hints.push({ parentId, kind: 'overlay', childIds: [host.id, child.id] });
    rest = rest.filter((s) => s !== child);
  }
  if (rest.length < 2) return hints;

  const ids = (layers: Layer[]) => layers.map((l) => l.id);
  const byX = [...rest].sort((a, b) => a.x - b.x);
  const byY = [...rest].sort((a, b) => a.y - b.y);

  // 2. Row
  if (isLine(byX, 'x')) return [...hints, { parentId, kind: 'row', childIds: ids(byX), gap: roundHalf(median(gapsAlong(byX, 'x'))) }];
  // 3. Column
  if (isLine(byY, 'y')) return [...hints, { parentId, kind: 'column', childIds: ids(byY), gap: roundHalf(median(gapsAlong(byY, 'y'))) }];
  // 4. Grid
  const grid = gridOf(rest);
  if (grid) {
    return [...hints, {
      parentId, kind: 'grid', childIds: ids(grid.flat()), columns: grid[0].length,
      columnGap: roundHalf(median(grid.flatMap((row) => gapsAlong(row, 'x')))),
      rowGap: roundHalf(median(gapsBetweenRows(grid))),
    }];
  }
  // 5. Bands of children whose vertical ranges overlap.
  const bands = bandsOf(byY);
  if (bands.length < 2) return hints;
  hints.push({
    parentId, kind: 'column', childIds: ids(bands.flat()), groups: bands.map(ids),
    gap: roundHalf(median(gapsBetweenRows(bands))),
  });
  for (const band of bands)
    if (band.length >= 2 && isLine(band, 'x')) hints.push({ parentId, kind: 'row', childIds: ids(band), gap: roundHalf(median(gapsAlong(band, 'x'))) });
  return hints;
}

/** Boxes sorted along an axis do not overlap on it (1 px slack) and every pair shares the other axis. */
function isLine(sorted: Layer[], axis: 'x' | 'y'): boolean {
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const start = axis === 'x' ? b.x : b.y;
      const end = axis === 'x' ? right(a) : bottom(a);
      if (start < end - SLACK) return false;
      const share = axis === 'x' ? verticalShare(a, b) : horizontalShare(a, b);
      if (share < MIN_SHARE) return false;
    }
  }
  return true;
}

/** Gaps between neighbours along an axis, never below 0. Input must be sorted along that axis. */
function gapsAlong(sorted: Box[], axis: 'x' | 'y'): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    gaps.push(Math.max(0, axis === 'x' ? b.x - right(a) : b.y - bottom(a)));
  }
  return gaps;
}

function gapsBetweenRows(rows: Layer[][]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const above = Math.max(...rows[i - 1].map(bottom));
    const below = Math.min(...rows[i].map((l) => l.y));
    gaps.push(Math.max(0, below - above));
  }
  return gaps;
}

/** Rows of equal count (at least 2 rows, at least 2 per row) with left edges lined up. Null if not a grid. */
function gridOf(layers: Layer[]): Layer[][] | null {
  const sorted = [...layers].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Layer[][] = [];
  for (const layer of sorted) {
    const row = rows[rows.length - 1];
    if (row && layer.y - row[row.length - 1].y <= ALIGN) row.push(layer);
    else rows.push([layer]);
  }
  if (rows.length < 2 || rows[0].length < 2) return null;
  if (rows.some((r) => r.length !== rows[0].length)) return null;
  rows.forEach((r) => r.sort((a, b) => a.x - b.x));
  for (const row of rows)
    for (let c = 0; c < row.length; c++)
      if (Math.abs(row[c].x - rows[0][c].x) > ALIGN) return null;
  return rows;
}

/** Groups boxes (sorted by y) into bands whose vertical ranges overlap; each band is sorted by x. */
function bandsOf(byY: Layer[]): Layer[][] {
  const bands: Layer[][] = [];
  let bandBottom = -Infinity;
  for (const layer of byY) {
    if (bands.length > 0 && layer.y < bandBottom - SLACK) {
      bands[bands.length - 1].push(layer);
      bandBottom = Math.max(bandBottom, bottom(layer));
    } else {
      bands.push([layer]);
      bandBottom = bottom(layer);
    }
  }
  return bands.map((b) => b.sort((x, y) => x.x - y.x));
}
