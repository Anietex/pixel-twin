import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoogleFontsClient, type GoogleFontsClient } from '../src/fonts/google';
import { defaultReadNames, isItalic, locateFonts, type FontSource } from '../src/fonts/locate';
import { downloadGoogleFonts } from '../src/tools/fonts';

const need = (family: string, style: string, weight: number, missingInFigma = false) => ({ family, style, weight, missingInFigma });
const noGoogle: GoogleFontsClient = { find: async () => null, download: async () => {} };

let root: string;
let projectDir: string;
let macDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pixel-twin-fonts-'));
  projectDir = path.join(root, 'project');
  macDir = path.join(root, 'mac');
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await mkdir(macDir, { recursive: true });
});

// The fake reader takes the family and style from the file name: "Inter-SemiBold.ttf".
const readNames = async (file: string) => {
  const [family, style] = path.basename(file, path.extname(file)).split('-');
  return [{ family, style }];
};
const touch = (dir: string, name: string) => writeFile(path.join(dir, name), 'x');

test('a project font beats a Mac font', async () => {
  await touch(path.join(projectDir, 'src'), 'Helvetica-Bold.woff2');
  await touch(macDir, 'Helvetica-Bold.ttf');
  const r = await locateFonts([need('Helvetica', 'Bold', 700)], { projectDir, macFontDirs: [macDir], google: noGoogle, readNames });
  expect(r[0].source).toBe('project');
  expect(r[0].path).toBe(path.join(projectDir, 'src', 'Helvetica-Bold.woff2'));
});

test('a Mac-only font carries a licence warning', async () => {
  await touch(macDir, 'Helvetica-Bold.ttf');
  const r = await locateFonts([need('Helvetica', 'Bold', 700)], { projectDir, macFontDirs: [macDir], google: noGoogle, readNames });
  expect(r[0]).toMatchObject({ source: 'mac', path: path.join(macDir, 'Helvetica-Bold.ttf'),
    licenceWarning: 'Found only on this Mac. Its licence may not allow use on a website. Ask the owner before copying.' });
});

test('Google Fonts is used when nothing local matches', async () => {
  const google: GoogleFontsClient = { find: async () => ({ url: 'https://fonts.gstatic.com/x.woff2' }), download: async () => {} };
  const r = await locateFonts([need('Inter', 'Bold', 700)], { projectDir, macFontDirs: [macDir], google, readNames });
  expect(r[0]).toMatchObject({ source: 'google', url: 'https://fonts.gstatic.com/x.woff2' });
});

test('nothing anywhere gives missing', async () => {
  const r = await locateFonts([need('Nope', 'Bold', 700)], { projectDir, macFontDirs: [macDir], google: noGoogle, readNames });
  expect(r[0].source).toBe('missing');
});

test('missingInFigma is carried through', async () => {
  const r = await locateFonts([need('Nope', 'Bold', 700, true)], { projectDir, macFontDirs: [macDir], google: noGoogle, readNames });
  expect(r[0].missingInFigma).toBe(true);
});

test('matching ignores case and spaces', async () => {
  await touch(projectDir, 'OpenSans-SemiBold.ttf');
  const names = async () => [{ family: 'Open Sans', style: 'SemiBold' }];
  const r = await locateFonts([need('open sans', 'Semi Bold', 600)], { projectDir, macFontDirs: [], google: noGoogle, readNames: names });
  expect(r[0].source).toBe('project');
});

test('node_modules is not scanned', async () => {
  await mkdir(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true });
  await touch(path.join(projectDir, 'node_modules', 'pkg'), 'Inter-Bold.ttf');
  const r = await locateFonts([need('Inter', 'Bold', 700)], { projectDir, macFontDirs: [], google: noGoogle, readNames });
  expect(r[0].source).toBe('missing');
});

test('a variable font file covers weights in its range', async () => {
  await touch(projectDir, 'InterVar.woff2');
  const names = async () => [{ family: 'Inter', style: 'Regular', weights: [100, 900] as [number, number] }];
  const opts = { projectDir, macFontDirs: [], google: noGoogle, readNames: names };
  expect((await locateFonts([need('Inter', 'SemiBold', 600)], opts))[0].source).toBe('project');
  expect((await locateFonts([need('Inter', 'SemiBold Italic', 600)], opts))[0].source).toBe('missing');
});

describe('Google client', () => {
  const css = `/* cyrillic */\n@font-face {\n  src: url(https://fonts.gstatic.com/cyr.woff2) format('woff2');\n}\n/* latin */\n@font-face {\n  src: url(https://fonts.gstatic.com/lat.woff2) format('woff2');\n}\n/* vietnamese */\n@font-face {\n  src: url(https://fonts.gstatic.com/vi.woff2) format('woff2');\n}`;

  test('asks for the right family and weight with a Chrome user agent', async () => {
    let requestedUrl = '';
    let requestedHeaders: Record<string, string> = {};
    const fake = (async (url: string, init: any) => {
      requestedUrl = url;
      requestedHeaders = init.headers;
      return new Response(css, { status: 200 });
    }) as unknown as typeof fetch;
    const found = await createGoogleFontsClient(fake).find('Inter', 600, false);
    expect(requestedUrl).toBe('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,600&display=swap');
    expect(requestedHeaders['user-agent']).toMatch(/Chrome\//);
    expect(found).toEqual({ url: 'https://fonts.gstatic.com/lat.woff2' });
  });

  test('joins family words with + and asks for italic', async () => {
    let requestedUrl = '';
    const fake = (async (url: string) => { requestedUrl = url; return new Response(css); }) as unknown as typeof fetch;
    await createGoogleFontsClient(fake).find('Open Sans', 400, true);
    expect(requestedUrl).toContain('family=Open+Sans:ital,wght@1,400');
  });

  test('a failed answer means not found', async () => {
    const fake = (async () => new Response('no', { status: 400 })) as unknown as typeof fetch;
    expect(await createGoogleFontsClient(fake).find('Nope', 400, false)).toBeNull();
  });

  test('download refuses other hosts and saves the file for fonts.gstatic.com', async () => {
    const fake = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    const client = createGoogleFontsClient(fake);
    const dest = path.join(root, 'out.woff2');
    await expect(client.download('https://evil.example.com/a.woff2', dest)).rejects.toThrow(/fonts\.gstatic\.com/);
    expect(existsSync(dest)).toBe(false);
    await client.download('https://fonts.gstatic.com/a.woff2', dest);
    expect([...(await readFile(dest))]).toEqual([1, 2, 3]);
  });
});

test.skipIf(!existsSync('/System/Library/Fonts/Supplemental/Arial.ttf'))('reads real font names with fontkit', async () => {
  const names = await defaultReadNames('/System/Library/Fonts/Supplemental/Arial.ttf');
  expect(names[0]).toMatchObject({ family: 'Arial', style: 'Regular' });
});

describe('fix round 1', () => {
  test('the same file reached through two folders is read once', async () => {
    await mkdir(path.join(macDir, 'Supplemental'));
    await touch(path.join(macDir, 'Supplemental'), 'Inter-Bold.ttf');
    const reader = vi.fn(readNames);
    await locateFonts([need('Nope', 'Bold', 700)], { projectDir, macFontDirs: [macDir, path.join(macDir, 'Supplemental')], google: noGoogle, readNames: reader });
    expect(reader).toHaveBeenCalledTimes(1);
  });

  test('a second call does not read unchanged files again', async () => {
    await touch(macDir, 'Inter-Bold.ttf');
    const reader = vi.fn(readNames);
    const opts = { projectDir, macFontDirs: [macDir], google: noGoogle, readNames: reader };
    await locateFonts([need('Nope', 'Bold', 700)], opts);
    await locateFonts([need('Nope', 'Bold', 700)], opts);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  test('a static font with another style name matches by weight', async () => {
    await touch(projectDir, 'x.ttf');
    const names = async () => [{ family: 'Inter', style: 'Book', weight: 400 }];
    const opts = { projectDir, macFontDirs: [], google: noGoogle, readNames: names };
    expect((await locateFonts([need('Inter', 'Regular', 400)], opts))[0].source).toBe('project');
    expect((await locateFonts([need('Inter', 'Regular', 500)], opts))[0].source).toBe('missing');
    expect((await locateFonts([need('Inter', 'Italic', 400)], opts))[0].source).toBe('missing');
  });

  test('isItalic treats oblique as italic', () => {
    expect(isItalic('Bold Oblique')).toBe(true);
    expect(isItalic('Bold')).toBe(false);
  });

  test('an upright-only family is asked again without the italic axis', async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return url.includes('ital,') ? new Response('no', { status: 400 }) : new Response('/* latin */ @font-face { src: url(https://fonts.gstatic.com/u.woff2); }');
    }) as unknown as typeof fetch;
    expect(await createGoogleFontsClient(fake).find('Anton', 400, false)).toEqual({ url: 'https://fonts.gstatic.com/u.woff2' });
    expect(urls[1]).toBe('https://fonts.googleapis.com/css2?family=Anton:wght@400&display=swap');
  });

  test('a download that redirects to another host is refused', async () => {
    const fake = (async () => {
      const r = new Response(new Uint8Array([1]));
      Object.defineProperty(r, 'url', { value: 'https://evil.example.com/a.woff2' });
      return r;
    }) as unknown as typeof fetch;
    const dest = path.join(root, 'r.woff2');
    await expect(createGoogleFontsClient(fake).download('https://fonts.gstatic.com/a.woff2', dest)).rejects.toThrow(/evil\.example\.com/);
    expect(existsSync(dest)).toBe(false);
  });

  test('one failed download does not lose the others', async () => {
    const google: GoogleFontsClient = {
      find: async () => null,
      download: async (url, dest) => { if (url.includes('bad')) throw new Error('boom'); await writeFile(dest, 'x'); },
    };
    const mk = (weight: number, url: string): FontSource => ({ family: 'Open Sans', style: 'Bold', weight, missingInFigma: false, source: 'google', url });
    const found = [mk(400, 'https://fonts.gstatic.com/ok.woff2'), mk(700, 'https://fonts.gstatic.com/bad.woff2')];
    await downloadGoogleFonts(found, path.join(root, 'fonts'), google);
    expect(found[0].path).toBe(path.join(root, 'fonts', 'OpenSans-400.woff2'));
    expect(found[1].path).toBeUndefined();
    expect(found[1].downloadError).toMatch(/boom/);
  });
});
