import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROPS = 'x|y|name|fills|strokes|effects|characters|visible|opacity|width|height|rotation|locked';
const FORBIDDEN = [
  /\b(figma|api)\.create\w*\(/,
  /\.remove\(/,
  /\.(appendChild|insertChild)\(/,
  /\.set(Shared)?PluginData\(/,
  /\.setRelaunchData\(/,
  /\.setBoundVariable\w*\(/,
  /\.setValueForMode\(/,
  /\.resize\w*\(/,
  /\.set\w+Async\(/,
  /\.(group|ungroup|clone|insertCharacters|swapComponent|detachInstance)\(/,
  /\bcurrentPage\s*=(?!=)/,
  /\.selection\s*=(?!=)/,
  new RegExp(`\\.(${PROPS})\\s*([-+*/%&|^]|<<|>>>?|\\*\\*|\\?\\?|\\|\\||&&)?=(?!=)`),
  /api\.figma\.com|mcp\.figma\.com/,
];

const hits = (line: string) => FORBIDDEN.some((re) => re.test(line));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('plugin code never changes the file and never calls Figma web services', () => {
  const matches: string[] = [];
  for (const f of files(join(__dirname, '../src'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (hits(line)) matches.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(matches).toEqual([]);
});

test('the scanner catches writes, including through api and compound assignment', () => {
  for (const bad of [
    'api.createFrame()', 'figma.createText()', "node.name = 'x'", 'figma.currentPage = p', 'api.currentPage = p',
    'node.remove()', 'n.opacity += 1', 'n.x -= 2', 'n.fills ??= []', 'await api.setCurrentPageAsync(p)',
    'node.clone()', 'node.group(a, b)', 'text.insertCharacters(0, "a")', 'inst.swapComponent(c)',
    'inst.detachInstance()', 'parent.appendChild(n)', "n.setPluginData('a', 'b')", 'n.resize(1, 2)',
    'fetch("https://api.figma.com/v1/files")', 'figma.currentPage.selection = [n]', 'page.selection = []',
  ]) expect(hits(bad), bad).toBe(true);
});

test('the scanner leaves harmless lines alone', () => {
  for (const ok of [
    'const name = node.name', 'if (a.x === b.x) return', 'if (a.x !== b.x) return', 'if (a.width <= 3) return',
    'if (a.height >= 3) return', 'const { x, y } = node', "return { name: node.name, x: n.x ?? 0 }",
    'await page.loadAsync()', 'const i = api.getImageByHash(h)', 'const picked = api.currentPage.selection',
  ]) expect(hits(ok), ok).toBe(false);
});
