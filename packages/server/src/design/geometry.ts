export interface Box { x: number; y: number; width: number; height: number }

export const right = (b: Box): number => b.x + b.width;
export const bottom = (b: Box): number => b.y + b.height;

/** How far two boxes overlap on each axis. Negative means a gap of that size. */
export function overlapSize(a: Box, b: Box): { w: number; h: number } {
  return {
    w: Math.min(right(a), right(b)) - Math.max(a.x, b.x),
    h: Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y),
  };
}

/** True when the boxes overlap by more than `minOverlap` px in both directions. */
export function intersects(a: Box, b: Box, minOverlap = 1): boolean {
  const o = overlapSize(a, b);
  return o.w > minOverlap && o.h > minOverlap;
}

/** True when `inner` lies completely inside `outer`. */
export function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
}

/** Share of the smaller height that the two boxes have in common (0 to 1). */
export function verticalShare(a: Box, b: Box): number {
  return share(overlapSize(a, b).h, Math.min(a.height, b.height));
}

/** Share of the smaller width that the two boxes have in common (0 to 1). */
export function horizontalShare(a: Box, b: Box): number {
  return share(overlapSize(a, b).w, Math.min(a.width, b.width));
}

function share(overlap: number, smaller: number): number {
  if (smaller <= 0) return overlap >= 0 ? 1 : 0;
  return Math.max(0, overlap) / smaller;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const roundHalf = (n: number): number => Math.round(n * 2) / 2;
