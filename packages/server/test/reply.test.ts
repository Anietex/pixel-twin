import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fitReply } from '../src/reply';

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-reply-'));
});

const text = (r: any): string => r.content[0].text;

test('small replies come back inline', async () => {
  const r = await fitReply({ a: 1 }, { workDir, label: 'x', summary: 's' });
  expect(text(r)).toBe('{"a":1}');
});

test('replies over the limit go to a file', async () => {
  const data = { big: 'x'.repeat(200_000) };
  const r = await fitReply(data, { workDir, label: 'section-1-1', summary: 'Hero: 7 layers' });
  expect(text(r)).toMatch(/Full result saved to .*\.pixel-twin\/section-1-1-\d+\.json/);
  expect(text(r)).toContain('Hero: 7 layers');
  expect(text(r)).toContain(`about ${Math.ceil(JSON.stringify(data).length / 3)} tokens`);
  const file = /saved to (\S+\.json)/.exec(text(r))![1];
  expect(path.isAbsolute(file)).toBe(true);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(data);
});

test('a custom limit is respected', async () => {
  const r = await fitReply({ a: 'x'.repeat(100) }, { workDir, label: 'x', summary: 's', limitTokens: 10 });
  expect(text(r)).toContain('Full result saved to');
});

test('a hostile label cannot write outside .pixel-twin', async () => {
  const r = await fitReply({ big: 'x'.repeat(200_000) }, { workDir, label: '../../evil/x', summary: 's' });
  const file = /saved to (\S+\.json)/.exec(text(r))![1];
  expect(path.dirname(file)).toBe(path.join(workDir, '.pixel-twin'));
  expect(path.basename(file)).toMatch(/^------evil-x-\d+\.json$/);
});

test('text replies are sent as they are, and saved as .txt when too big', async () => {
  const small = await fitReply('Layers:\nA | 1:2', { workDir, label: 'section-1-1', summary: 's' });
  expect(small.content[0]).toMatchObject({ text: 'Layers:\nA | 1:2' });
  const big = await fitReply('x'.repeat(200_000), { workDir, label: 'section-1-1', summary: 'Hero' });
  expect((big.content[0] as { text: string }).text).toMatch(/section-1-1-\d+\.txt/);
});
