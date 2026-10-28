import { writeFile } from 'node:fs/promises';

export interface GoogleFontsClient {
  find(family: string, weight: number, italic: boolean): Promise<{ url: string } | null>;
  download(url: string, dest: string): Promise<void>;
}

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const FILE_HOST = 'fonts.gstatic.com';

/** Takes the file url from the "latin" block of a Google Fonts style sheet. Falls back to the last block. */
function pickUrl(css: string): string | null {
  const blocks = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)];
  const block = blocks.find((b) => b[1] === 'latin') ?? blocks[blocks.length - 1];
  return block?.[2].match(/src:[^;]*?url\(([^)]+)\)/)?.[1].replace(/^['"]|['"]$/g, '') ?? null;
}

export function createGoogleFontsClient(fetchImpl: typeof fetch = fetch): GoogleFontsClient {
  return {
    async find(family, weight, italic) {
      const name = family.trim().replace(/\s+/g, '+');
      const ask = (query: string) =>
        fetchImpl(`https://fonts.googleapis.com/css2?family=${name}:${query}&display=swap`, {
          headers: { 'user-agent': CHROME }, signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      let res = await ask(`ital,wght@${italic ? 1 : 0},${weight}`);
      // Upright-only families have no italic axis: ask again without it.
      if (res.status !== 200 && !italic) res = await ask(`wght@${weight}`);
      if (res.status !== 200) return null;
      const file = pickUrl(await res.text());
      return file ? { url: file } : null;
    },
    async download(url, dest) {
      let host = '';
      try { host = new URL(url).hostname; } catch { /* handled below */ }
      if (host !== FILE_HOST) throw new Error(`Refused to download from ${host || url}. Only ${FILE_HOST} is allowed.`);
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.url && new URL(res.url).hostname !== FILE_HOST) throw new Error(`Refused the download: Google Fonts sent the file from ${new URL(res.url).hostname}. Only ${FILE_HOST} is allowed.`);
      if (!res.ok) throw new Error(`Google Fonts answered ${res.status} for ${url}.`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    },
  };
}
