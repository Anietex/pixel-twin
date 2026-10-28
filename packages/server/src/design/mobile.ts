import type { FrameSections } from '@pixel-twin/shared';

export interface MobileCandidate {
  id: string;
  name: string;
  frameName: string;
  frameWidth: number;
  pageName?: string;   // set when the frame is on another page than the desktop section
  nameScore: number;
  textScore: number;
  score: number;
}

const DROP_WORDS = new Set(['mobile', 'phone', 'desktop', 'tablet', 'sm', 'md', 'lg']);

/** Figma's default layer names, such as "Frame 427". Their number is what tells them apart. */
const FIGMA_DEFAULT_NAME = /^(frame|group|section|rectangle|container|component|instance) \d+$/;
/** Screen sizes and scale marks, such as 375, 1440w, 375px or @2x. Short numbers, as in "Card 2", stay. */
const SIZE_TOKEN = /@\d+x?|\d+(?:px|w|x)\b|\d{3,}/g;

function normaliseName(name: string): string {
  const lower = name.toLowerCase().replace(/[–—_-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (FIGMA_DEFAULT_NAME.test(lower)) return lower;
  return lower
    .replace(SIZE_TOKEN, ' ')
    .split(/\s+/)
    .filter((w) => w && !DROP_WORDS.has(w))
    .join(' ');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function nameScore(a: string, b: string): number {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x && !y) return 0;
  if (x === y) return 1;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let shared = 0;
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0);
  const total = Math.max(x.length - 1, 0) + Math.max(y.length - 1, 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

function wordSet(texts: string[]): Set<string> {
  return new Set(texts.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
}

function textScore(a: string[], b: string[]): number {
  const x = wordSet(a);
  const y = wordSet(b);
  if (x.size === 0 && y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Below this best score (and with no section of the same name) the file has no mobile version of the section. */
export const NONE_BELOW = 0.2;

/** A page whose name says it holds phone designs, such as "Website 2026 - Mobile". */
export const MOBILE_PAGE = /\b(mobile|phone|responsive|ios|android)\b/i;

/**
 * Ranks the sections of narrow frames by how likely each is the mobile version of the desktop section.
 * Frames may come from other pages (`pageName` set). When several sections have the desktop section's
 * exact name, the one in a frame named like the desktop frame wins ("Homepage" on a Mobile page).
 * `none` is true when nothing comes close: the agent then designs the phone layout itself instead of asking.
 */
export function rankMobileCandidates(
  desktop: { id: string; name: string; frameId: string; texts: string[]; frameName?: string },
  frames: (FrameSections & { pageName?: string })[],
  opts: { maxMobileWidth?: number } = {},
): { candidates: MobileCandidate[]; confident: boolean; none: boolean } {
  const maxWidth = opts.maxMobileWidth ?? 600;
  const candidates: MobileCandidate[] = [];
  const sameFrame = new Set<MobileCandidate>();
  for (const frame of frames) {
    if (frame.frameId === desktop.frameId || frame.frameWidth > maxWidth) continue;
    const frameMatches = desktop.frameName !== undefined && nameScore(desktop.frameName, frame.frameName) === 1;
    for (const s of frame.sections) {
      const n = nameScore(desktop.name, s.name);
      const t = textScore(desktop.texts, s.texts);
      const candidate: MobileCandidate = {
        id: s.id,
        name: s.name,
        frameName: frame.frameName,
        frameWidth: frame.frameWidth,
        ...(frame.pageName !== undefined ? { pageName: frame.pageName } : {}),
        nameScore: round3(n),
        textScore: round3(t),
        score: round3(0.6 * n + 0.4 * t),
      };
      candidates.push(candidate);
      if (frameMatches) sameFrame.add(candidate);
    }
  }
  const exact = candidates.filter((c) => c.nameScore === 1);
  const exactInFrame = exact.filter((c) => sameFrame.has(c));
  const uniqueExact = exact.length === 1 ? exact[0] : exactInFrame.length === 1 ? exactInFrame[0] : null;
  candidates.sort(
    (a, b) =>
      Number(b === uniqueExact) - Number(a === uniqueExact) ||
      b.score - a.score ||
      Number(sameFrame.has(b)) - Number(sameFrame.has(a)) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const [top, second] = candidates;
  const byScore = !!top && top.score >= 0.8 && (!second || second.score <= top.score - 0.2);
  const confident = byScore || !!uniqueExact;
  const none = !top || (top.score < NONE_BELOW && !uniqueExact);
  return { candidates, confident, none };
}
