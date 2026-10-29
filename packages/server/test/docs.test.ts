import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.join(__dirname, '..', '..', '..');
const skill = readFileSync(path.join(repo, 'skill', 'pixel-twin', 'SKILL.md'), 'utf8');
const readme = readFileSync(path.join(repo, 'README.md'), 'utf8');

test('the skill names every tool and the stop rule', () => {
  for (const t of ['status', 'get_outline', 'get_selection', 'get_section', 'get_screenshot', 'export_assets', 'get_fonts', 'find_mobile_version', 'compare', 'compare_page',
    'check_responsive', 'check_motion', 'record', 'check_quality', 'clean_up']) {
    expect(skill).toContain(t);
    expect(readme).toContain(`\`${t}\``);
  }
  expect(skill).toMatch(/^---\nname: pixel-twin\ndescription: .+\n---/);
  expect(skill).toContain('shouldStop');
});

test('the skill explains every reply field the agent must act on', () => {
  for (const word of ['checkByEye', 'cannotMatch', 'regions', 'warnings', 'background', 'overlay', 'confident', 'data-figma-id',
    'unchecked', 'none: true', 'Known browser limits', 'Whole page', 'composes', 'Playwright', 'crop',
    'pixel-twin.json', 'Motion hints', 'state', 'textEdgeAreas', 'prefers-reduced-motion', 'House style', '@property', 'isolation: isolate',
    'fetchpriority', 'loading="lazy"', 'marquee-jump', 'low-contrast',
    'Production quality', 'dangerouslySetInnerHTML', 'noopener noreferrer', 'srcset', 'font-display', 'focus-visible', 'heavy-code',
    'lint, type check, tests and build', 'npm run preview', '.pixel-twin/scratch', '.playwright-mcp', 'Section builder', '.pixel-twin/plan.md', 'one at a time'])
    expect(skill).toContain(word);
});

test('the README has numbered setup steps including the plugin import and MCP registration', () => {
  expect(readme).toContain('Import plugin from manifest');
  expect(readme).toContain('claude mcp add --scope user pixel-twin');
  expect(readme).toMatch(/^1\. /m);
});

test('the skill names every tool the server registers', async () => {
  const { readdirSync } = await import('node:fs');
  const tools = readdirSync(path.join(__dirname, '..', 'src', 'tools')).flatMap((f) =>
    [...readFileSync(path.join(__dirname, '..', 'src', 'tools', f), 'utf8').matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]));
  expect(tools.length).toBeGreaterThanOrEqual(15);
  for (const t of tools) expect(skill).toContain(`\`${t}\``);
});
