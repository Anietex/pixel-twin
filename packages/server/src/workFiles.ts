import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

/** The folder in the project where Pixel Twin keeps its working files. */
export const WORK_FOLDER = '.pixel-twin';
/** compare's memory (round counts and explanations): tiny, and a later session needs it. */
const MEMORY_FILES = new Set(['history.json', 'explained.json']);
/** The folder record saves its videos in. */
const VIDEO_FOLDER = 'record';
/** The plan the main agent and its section builders share. A later session needs it to carry on. */
export const PLAN_FILE = 'plan.md';
/** When the server starts, it deletes working files last changed longer ago than this (ms). */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface CleanUp {
  folder: string;
  files: number;
  bytes: number;
  /** Files kept on purpose (memory, videos, the plan), relative to the folder. */
  kept: string[];
  /** Files that could not be deleted, relative to the folder. */
  failed: string[];
}

/**
 * Deletes the working files in `<workDir>/.pixel-twin`, except compare's memory and, with keepVideos and
 * keepPlan, the videos and the plan. With olderThan (a time in ms), only files last changed before then
 * are deleted. Folders left empty are removed. It never follows a link: a link is deleted as a file, and
 * a .pixel-twin that is itself a link is left alone.
 */
export async function cleanWorkFiles(workDir: string, opts: { keepVideos: boolean; keepPlan?: boolean; olderThan?: number }): Promise<CleanUp> {
  const folder = path.join(workDir, WORK_FOLDER);
  const result: CleanUp = { folder, files: 0, bytes: 0, kept: [], failed: [] };
  const top = await lstat(folder).catch(() => null);
  if (!top) return result;
  if (!top.isDirectory()) throw new Error(`${folder} is not a folder, so Pixel Twin left it alone.`);

  /** Sweeps one folder. Returns true when nothing is left in it. */
  const sweep = async (dir: string, rel: string): Promise<boolean> => {
    let empty = true;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (await sweep(full, name)) await rmdir(full).catch(() => { empty = false; });
        else empty = false;
        continue;
      }
      const isMemory = rel === '' && MEMORY_FILES.has(entry.name);
      const isVideo = name.startsWith(`${VIDEO_FOLDER}/`);
      const isPlan = name === PLAN_FILE;
      if (isMemory || (isVideo && opts.keepVideos) || (isPlan && opts.keepPlan)) {
        result.kept.push(name);
        empty = false;
        continue;
      }
      const stat = await lstat(full).catch(() => null);
      if (!stat) continue;   // already gone
      if (opts.olderThan !== undefined && stat.mtimeMs >= opts.olderThan) {
        empty = false;
        continue;
      }
      try {
        await rm(full, { force: true });
        result.files += 1;
        result.bytes += stat.size;
      } catch {
        result.failed.push(name);
        empty = false;
      }
    }
    return empty;
  };
  await sweep(folder, '');
  return result;
}

/** A size for people: KB below 1 MB, else MB with one decimal. */
export function formatSize(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.ceil(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}
