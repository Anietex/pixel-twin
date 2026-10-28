import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { connectTestClient, noBrowser } from './helpers/mcp';

const call = async (args: Record<string, string>) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pixel-twin-fonttool-'));
  const client = await connectTestClient({ bridge: {} as any, bridgeError: null, workDir, browser: noBrowser });
  try {
    return (await client.callTool({ name: 'get_fonts', arguments: { link: 'https://www.figma.com/design/K/L?node-id=1-2', ...args } })) as any;
  } finally { await client.close(); }
};

test('projectDir outside the project folder is refused', async () => {
  const r = await call({ projectDir: '../elsewhere' });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toBe('projectDir must be inside the project folder');
});

test('fontsDir outside the project folder is refused', async () => {
  const r = await call({ projectDir: '.', fontsDir: '/tmp/fonts' });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toBe('fontsDir must be inside the project folder');
});
