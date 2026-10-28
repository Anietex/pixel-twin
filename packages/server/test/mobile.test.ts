import type { FrameSections } from '@pixel-twin/shared';
import { rankMobileCandidates } from '../src/design/mobile';

const heroDesktop = { id: '1:2', name: 'Hero', frameId: '1:1', texts: ['Build faster', 'Start free trial'] };
const frames: FrameSections[] = [
  { frameId: '1:1', frameName: 'Home', frameWidth: 1440, sections: [
    { id: '1:2', name: 'Hero', texts: ['Build faster', 'Start free trial'] },
    { id: '1:3', name: 'Pricing', texts: ['Plans'] },
  ] },
  { frameId: '2:1', frameName: 'Home – Mobile', frameWidth: 375, sections: [
    { id: '2:2', name: 'Hero', texts: ['Build faster', 'Start free trial'] },
    { id: '2:3', name: 'Pricing', texts: ['Plans'] },
  ] },
];

test('same name in a 375 frame → confident match', () => {
  const r = rankMobileCandidates(heroDesktop, frames);
  expect(r.candidates[0]).toMatchObject({ id: '2:2', name: 'Hero', frameName: 'Home – Mobile', frameWidth: 375, nameScore: 1 });
  expect(r.confident).toBe(true);
});

test('"Hero – Mobile" counts as the same name', () => {
  const f: FrameSections[] = [frames[0], { frameId: '2:1', frameName: 'm', frameWidth: 375, sections: [{ id: '2:2', name: 'Hero – Mobile 375', texts: [] }] }];
  expect(rankMobileCandidates(heroDesktop, f).candidates[0].nameScore).toBe(1);
});

test('a renamed section with the same text ranks first', () => {
  const f: FrameSections[] = [frames[0], { frameId: '2:1', frameName: 'M', frameWidth: 375, sections: [
    { id: '2:2', name: 'Banner', texts: ['Build faster', 'Start free trial'] },
    { id: '2:3', name: 'Footer', texts: ['Legal'] },
  ] }];
  const r = rankMobileCandidates(heroDesktop, f);
  expect(r.candidates[0].id).toBe('2:2');
  expect(r.candidates[0].textScore).toBe(1);
});

test('two equally good candidates → not confident', () => {
  const f: FrameSections[] = [frames[0],
    { frameId: '2:1', frameName: 'A', frameWidth: 375, sections: [{ id: '2:2', name: 'Hero', texts: [] }] },
    { frameId: '3:1', frameName: 'B', frameWidth: 390, sections: [{ id: '3:2', name: 'Hero', texts: [] }] }];
  const r = rankMobileCandidates(heroDesktop, f);
  expect(r.candidates).toHaveLength(2);
  expect(r.confident).toBe(false);
});

test('frames wider than 600 and the desktop frame itself are skipped', () => {
  const f: FrameSections[] = [frames[0], { frameId: '4:1', frameName: 'Tablet', frameWidth: 768, sections: [{ id: '4:2', name: 'Hero', texts: [] }] }];
  expect(rankMobileCandidates(heroDesktop, f).candidates).toEqual([]);
  expect(rankMobileCandidates(heroDesktop, [...f], { maxMobileWidth: 800 }).candidates.map((c) => c.id)).toEqual(['4:2']);
});

test('no candidates → not confident; ties sort by name; scores round to 3 decimals', () => {
  expect(rankMobileCandidates(heroDesktop, [frames[0]])).toEqual({ candidates: [], confident: false, none: true });
  const f: FrameSections[] = [{ frameId: '2:1', frameName: 'M', frameWidth: 375, sections: [
    { id: 'b', name: 'Zed', texts: [] }, { id: 'a', name: 'Alpha', texts: [] }] }];
  expect(rankMobileCandidates({ ...heroDesktop, name: 'Qqq', texts: [] }, f).candidates.map((c) => c.name)).toEqual(['Alpha', 'Zed']);
  const r = rankMobileCandidates({ ...heroDesktop, name: 'Pricing table' }, [{ frameId: '2:1', frameName: 'M', frameWidth: 375, sections: [{ id: 'x', name: 'Pricing', texts: [] }] }]);
  expect(r.candidates[0].nameScore).toBe(Math.round(r.candidates[0].nameScore * 1000) / 1000);
  expect(r.candidates[0].nameScore).toBeGreaterThan(0.5);
});

const narrow = (sections: { id: string; name: string; texts: string[] }[], frameId = '2:1', frameWidth = 375): FrameSections =>
  ({ frameId, frameName: frameId, frameWidth, sections });

test('a unique exact name is confident and first even with different copy', () => {
  const r = rankMobileCandidates(heroDesktop, [frames[0], narrow([
    { id: 'o', name: 'Heron', texts: ['Build faster', 'Start free trial'] },
    { id: 'h', name: 'Hero', texts: ['Short'] },
    { id: 'z', name: 'Footer', texts: [] },
  ])]);
  expect(r.candidates[0].id).toBe('h');
  expect(r.candidates[0].score).toBeLessThan(0.8);
  expect(r.confident).toBe(true);
});

test('two candidates both named Hero are not confident', () => {
  const r = rankMobileCandidates(heroDesktop, [frames[0],
    narrow([{ id: 'a', name: 'Hero', texts: ['x1'] }], '2:1'), narrow([{ id: 'b', name: 'Hero', texts: ['y1'] }], '3:1')]);
  expect(r.confident).toBe(false);
});

test('two candidates both at 0.8 or more and close together are not confident', () => {
  const d = { id: 'd', name: 'Hero banner', frameId: '1:1', texts: ['Build faster'] };
  const r = rankMobileCandidates(d, [narrow([
    { id: 'a', name: 'Hero banners', texts: ['Build faster'] },
    { id: 'b', name: 'Hero bannerz', texts: ['Build faster'] },
  ])]);
  expect(r.candidates.every((c) => c.score >= 0.8 && c.nameScore < 1)).toBe(true);
  expect(r.confident).toBe(false);
});

test('the desktop frame is skipped by id even when it is narrow', () => {
  const d = { id: '1:2', name: 'Hero', frameId: '1:1', texts: [] };
  const f = [narrow([{ id: '1:2', name: 'Hero', texts: [] }], '1:1'), narrow([{ id: '2:2', name: 'Hero', texts: [] }], '2:1')];
  expect(rankMobileCandidates(d, f).candidates.map((c) => c.id)).toEqual(['2:2']);
});

test.each(['Hero375', 'Hero 375px', 'Hero@2x', 'Hero 1440w', 'Hero – Mobile'])('"%s" counts as the name Hero', (name) => {
  expect(rankMobileCandidates(heroDesktop, [narrow([{ id: 'a', name, texts: [] }])]).candidates[0].nameScore).toBe(1);
});

test.each([['Card 1', 'Card 2'], ['Frame 427', 'Frame 512'], ['Step2', 'Step3']])('"%s" and "%s" are different names', (a, b) => {
  const desktop = { id: '1:2', name: a, frameId: '1:1', texts: [] };
  expect(rankMobileCandidates(desktop, [narrow([{ id: 'a', name: b, texts: [] }])]).candidates[0].nameScore).toBeLessThan(1);
});

test('nothing close means none: no mobile design to ask about', () => {
  const unrelated: FrameSections[] = [frames[0], { frameId: '3:1', frameName: 'Icons', frameWidth: 320, sections: [
    { id: '3:2', name: 'Arrow', texts: [] }, { id: '3:3', name: 'Close', texts: [] }] }];
  expect(rankMobileCandidates(heroDesktop, unrelated)).toMatchObject({ confident: false, none: true });
  expect(rankMobileCandidates(heroDesktop, [frames[0]])).toMatchObject({ candidates: [], none: true });
  expect(rankMobileCandidates(heroDesktop, frames)).toMatchObject({ confident: true, none: false });
});
