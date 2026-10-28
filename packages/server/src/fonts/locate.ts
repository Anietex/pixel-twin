import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { open, type Font } from 'fontkit';
import type { SectionData } from '../design/types';
import type { GoogleFontsClient } from './google';

export interface FontSource {
  family: string; style: string; weight: number; missingInFigma: boolean;
  source: 'project' | 'mac' | 'google' | 'missing';
  path?: string; url?: string; licenceWarning?: string; downloadError?: string;
}

type FontName = { family: string; style: string; weights?: [number, number]; weight?: number };
type ReadNames = (file: string) => Promise<FontName[]>;

export const MAC_FONT_DIRS: string[] = [
  path.join(homedir(), 'Library', 'Fonts'),
  '/Library/Fonts',
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
];

const MAC_WARNING = 'Found only on this Mac. Its licence may not allow use on a website. Ask the owner before copying.';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const FONT_FILE = /\.(woff2|woff|ttf|otf|ttc)$/i;

/** Reads the preferred family and style of every font in a file. A .ttc file holds several fonts. */
export async function defaultReadNames(file: string): Promise<FontName[]> {
  const opened = await open(file);
  const fonts: Font[] = 'fonts' in opened ? opened.fonts : [opened];
  return fonts.map((f) => {
    const wght = f.variationAxes?.wght;
    return {
      family: f.getName('preferredFamily') ?? f.familyName,
      style: f.getName('preferredSubfamily') ?? f.subfamilyName,
      ...(typeof f['OS/2']?.usWeightClass === 'number' ? { weight: f['OS/2'].usWeightClass as number } : {}),
      ...(wght ? { weights: [wght.min, wght.max] as [number, number] } : {}),
    };
  });
}

async function listFonts(dir: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...(await listFonts(full))); }
    else if (e.isFile() && FONT_FILE.test(e.name)) out.push(full);
  }
  return out.sort();
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
/** True for styles named italic or oblique. */
export const isItalic = (style: string) => /italic|oblique/i.test(style);

/** Same family and a static font of the same weight and slant, whatever the style is called ("Book" for "Regular"). */
function matchesByWeight(need: SectionData['fonts'][number], have: FontName): boolean {
  return norm(need.family) === norm(have.family) && !have.weights && have.weight === need.weight && isItalic(need.style) === isItalic(have.style);
}

// Parsed names stay in memory for the life of the process, per reader, until the file changes.
const nameCache = new WeakMap<ReadNames, Map<string, FontName[]>>();
async function cachedNames(readNames: ReadNames, file: string): Promise<FontName[]> {
  const st = await stat(file);
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  let perReader = nameCache.get(readNames);
  if (!perReader) nameCache.set(readNames, (perReader = new Map()));
  const hit = perReader.get(key);
  if (hit) return hit;
  const names = await readNames(file);
  perReader.set(key, names);
  return names;
}

function matches(need: SectionData['fonts'][number], have: FontName): boolean {
  if (norm(need.family) !== norm(have.family)) return false;
  if (norm(need.style) === norm(have.style)) return true;
  const [min, max] = have.weights ?? [];
  return min !== undefined && max !== undefined && need.weight >= min && need.weight <= max && isItalic(need.style) === isItalic(have.style);
}

export async function locateFonts(
  needs: SectionData['fonts'],
  opts: { projectDir: string; macFontDirs: string[]; google: GoogleFontsClient; readNames?: ReadNames },
): Promise<FontSource[]> {
  const readNames = opts.readNames ?? defaultReadNames;
  // Each folder is scanned once, and only when a font is still missing.
  const cache = new Map<string, { file: string; names: FontName[] }[]>();
  const scan = async (dirs: string[]) => {
    const key = dirs.join('\0');
    if (!cache.has(key)) {
      const found: { file: string; names: FontName[] }[] = [];
      const seen = new Set<string>(); // folders can overlap: read each real file once
      for (const dir of dirs) {
        for (const file of await listFonts(dir)) {
          try {
            const real = await realpath(file);
            if (seen.has(real)) continue;
            seen.add(real);
            found.push({ file, names: await cachedNames(readNames, file) });
          } catch { /* not a readable font: skip it */ }
        }
      }
      cache.set(key, found);
    }
    return cache.get(key)!;
  };
  const find = async (dirs: string[], need: SectionData['fonts'][number]) => {
    const files = await scan(dirs);
    return (files.find((f) => f.names.some((n) => matches(need, n))) ?? files.find((f) => f.names.some((n) => matchesByWeight(need, n))))?.file;
  };

  const out: FontSource[] = [];
  for (const need of needs) {
    const base = { family: need.family, style: need.style, weight: need.weight, missingInFigma: need.missingInFigma };
    const inProject = await find([opts.projectDir], need);
    if (inProject) { out.push({ ...base, source: 'project', path: inProject }); continue; }
    const onMac = await find(opts.macFontDirs, need);
    if (onMac) { out.push({ ...base, source: 'mac', path: onMac, licenceWarning: MAC_WARNING }); continue; }
    let google: { url: string } | null = null;
    try { google = await opts.google.find(need.family, need.weight, isItalic(need.style)); } catch { google = null; }
    out.push(google ? { ...base, source: 'google', url: google.url } : { ...base, source: 'missing' });
  }
  return out;
}
