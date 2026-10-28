import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordRound, roundsWithoutProgress } from '../src/compare/history';

test('rounds without progress', () => {
  expect(roundsWithoutProgress([5, 4, 4, 4])).toBe(2);
  expect(roundsWithoutProgress([5, 6, 7, 3])).toBe(0);
  expect(roundsWithoutProgress([5, 8, 6])).toBe(2);   // 6 is lower than 8 but not lower than the best so far
  expect(roundsWithoutProgress([])).toBe(0);
});

test('shouldStop after 10 rounds without fewer differences', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-history-'));
  let r = await recordRound(workDir, '1:1@600', 5, false);
  expect(r).toEqual({ totals: [5], roundsWithoutProgress: 0, shouldStop: false });
  for (let i = 1; i <= 9; i++) r = await recordRound(workDir, '1:1@600', 5, false);
  expect(r).toMatchObject({ roundsWithoutProgress: 9, shouldStop: false });
  r = await recordRound(workDir, '1:1@600', 6, false);
  expect(r).toMatchObject({ roundsWithoutProgress: 10, shouldStop: true });
  // Other keys keep their own history; reset starts again.
  expect(await recordRound(workDir, '1:1@390', 5, false)).toEqual({ totals: [5], roundsWithoutProgress: 0, shouldStop: false });
  expect(await recordRound(workDir, '1:1@600', 7, true)).toEqual({ totals: [7], roundsWithoutProgress: 0, shouldStop: false });
  const saved = JSON.parse(await readFile(path.join(workDir, '.pixel-twin', 'history.json'), 'utf8'));
  expect(saved).toEqual({ '1:1@600': [7], '1:1@390': [5] });
});

test('a damaged history file starts again', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-history-'));
  await mkdir(path.join(workDir, '.pixel-twin'));
  await writeFile(path.join(workDir, '.pixel-twin', 'history.json'), '{not json');
  expect(await recordRound(workDir, '1:1@600', 3, false)).toEqual({ totals: [3], roundsWithoutProgress: 0, shouldStop: false });
});

test('rounds recorded at the same time are all kept, and no temp file is left', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-history-'));
  await Promise.all(Array.from({ length: 20 }, (_, i) => recordRound(workDir, '1:1@600', i, false)));
  const saved = JSON.parse(await readFile(path.join(workDir, '.pixel-twin', 'history.json'), 'utf8'));
  expect(saved['1:1@600']).toHaveLength(20);
  expect(await readdir(path.join(workDir, '.pixel-twin'))).toEqual(['history.json']);
});

test('explanations are remembered per section, updated by layer, and forgotten on reset', async () => {
  const { rememberExplained } = await import('../src/compare/history');
  const dir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-explained-'));
  expect(await rememberExplained(dir, '1:1', [{ layerId: '1:2', reason: 'in the logo picture' }], false))
    .toEqual([{ layerId: '1:2', reason: 'in the logo picture' }]);
  // A later round with nothing new still has it; a new reason for the same layer replaces it.
  expect(await rememberExplained(dir, '1:1', [], false)).toEqual([{ layerId: '1:2', reason: 'in the logo picture' }]);
  expect(await rememberExplained(dir, '1:1', [{ layerId: '1:2', reason: 'drawn by CSS' }, { layerId: '1:3', reason: 'x' }], false))
    .toEqual([{ layerId: '1:2', reason: 'drawn by CSS' }, { layerId: '1:3', reason: 'x' }]);
  expect(await rememberExplained(dir, '9:9', [], false)).toEqual([]);   // another section has its own list
  expect(await rememberExplained(dir, '1:1', [], true)).toEqual([]);
});
