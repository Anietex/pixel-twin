import { PNG } from 'pngjs';
import { inBrowser } from './errors';
import type { BrowserProvider } from './launch';

/** Quality (0 to 1) for photos saved as WebP or JPG. */
export const PHOTO_QUALITY = 0.85;

/** True when every pixel of the PNG is fully opaque, so a format without transparency can hold it. */
export function isOpaquePng(bytes: Buffer): boolean {
  const png = PNG.sync.read(bytes);
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] !== 255) return false;
  return true;
}

/** The picture types the browser can write. */
export type ImageType = 'image/webp' | 'image/jpeg' | 'image/png';

/**
 * Re-encodes and resizes pictures in the headless browser, which can write WebP, JPG and PNG.
 * Call close() when done.
 */
export async function openEncoder(browser: BrowserProvider): Promise<{
  encode(bytes: Buffer, type: ImageType, quality?: number): Promise<Buffer>;
  resize(bytes: Buffer, width: number, height: number, type: ImageType, quality?: number): Promise<Buffer>;
  close(): Promise<void>;
}> {
  // A blank page that may go nowhere else.
  const session = await inBrowser(() => browser.open('about:blank', 100, 1, (u) => u === 'about:blank'));
  const run = async (bytes: Buffer, type: ImageType, quality: number, size: { width: number; height: number } | null): Promise<Buffer> => {
    const out = await inBrowser(() => session.page.evaluate(async ({ data, mime, q, to }) => {
      const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([raw]),
        to ? { resizeWidth: to.width, resizeHeight: to.height, resizeQuality: 'high' } : {});
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: mime, quality: q });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (let i = 0; i < buf.length; i += 0x8000) text += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { type: blob.type, base64: btoa(text) };
    }, { data: bytes.toString('base64'), mime: type, q: quality, to: size }));
    if (out.type !== type) throw new Error(`The browser could not write ${type}`);
    return Buffer.from(out.base64, 'base64');
  };
  return {
    encode: (bytes, type, quality = PHOTO_QUALITY) => run(bytes, type, quality, null),
    resize: (bytes, width, height, type, quality = PHOTO_QUALITY) => run(bytes, type, quality, { width, height }),
    close: () => session.close(),
  };
}
