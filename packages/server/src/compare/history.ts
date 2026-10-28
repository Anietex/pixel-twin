import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The agent stops after this many rounds in a row that don't lower the number of differences (req 6.2). */
export const MAX_ROUNDS_WITHOUT_PROGRESS = 10;

/** Counts the latest rounds in a row whose total is not lower than the best total before them. */
export function roundsWithoutProgress(totals: number[]): number {
  let best = Infinity;
  let count = 0;
  for (const total of totals) {
    if (total < best) {
      best = total;
      count = 0;
    } else {
      count += 1;
    }
  }
  return count;
}

type Store = Record<string, unknown>;

async function readStore(file: string): Promise<Store> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Store) : {};
  } catch {
    return {}; // no file yet, or a damaged one: start again
  }
}

/** Changes are made one at a time in this process, so two calls can't both read the old file. */
let queue: Promise<unknown> = Promise.resolve();
let tempCount = 0;

/** Reads `<workDir>/.pixel-twin/<name>`, lets `change` edit it, and writes it back whole. */
function updateStore<T>(workDir: string, name: string, change: (data: Store) => T): Promise<T> {
  const run = queue.then(async () => {
    const dir = path.join(workDir, '.pixel-twin');
    const file = path.join(dir, name);
    const data = await readStore(file);
    const result = change(data);
    await mkdir(dir, { recursive: true });
    // Write a temp file, then rename it over the old one, so a reader never sees half a file.
    const temp = `${file}.${process.pid}.${tempCount++}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2));
    await rename(temp, file);
    return result;
  });
  queue = run.catch(() => undefined);   // one failed change must not block the next
  return run;
}

/** Adds one round's total to `<workDir>/.pixel-twin/history.json` under `key` (`<nodeId>@<width>`). */
export function recordRound(
  workDir: string,
  key: string,
  total: number,
  reset: boolean,
): Promise<{ totals: number[]; roundsWithoutProgress: number; shouldStop: boolean }> {
  return updateStore(workDir, 'history.json', (history) => {
    const before = history[key];
    const old = Array.isArray(before) && before.every((n) => typeof n === 'number') ? before as number[] : [];
    const totals = [...(reset ? [] : old), total];
    history[key] = totals;
    const rounds = roundsWithoutProgress(totals);
    return { totals, roundsWithoutProgress: rounds, shouldStop: rounds >= MAX_ROUNDS_WITHOUT_PROGRESS };
  });
}

export interface Explanation { layerId: string; reason: string }

/**
 * Remembers the layers the agent explained for a section, so it doesn't have to send them every round.
 * New explanations replace older ones for the same layer. `reset` forgets the old ones first.
 * Kept in `<workDir>/.pixel-twin/explained.json` under the section's node id.
 */
export function rememberExplained(workDir: string, sectionId: string, explained: Explanation[], reset: boolean): Promise<Explanation[]> {
  return updateStore(workDir, 'explained.json', (store) => {
    const before = reset ? [] : store[sectionId];
    const old = Array.isArray(before)
      ? before.filter((e): e is Explanation => typeof e?.layerId === 'string' && typeof e?.reason === 'string')
      : [];
    const merged = new Map(old.map((e) => [e.layerId, e]));
    for (const e of explained) merged.set(e.layerId, e);
    const list = [...merged.values()];
    store[sectionId] = list;
    return list;
  });
}
