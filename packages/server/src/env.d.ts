/** Replaced with the shared secret by the build (esbuild define). */
declare const __PIXEL_TWIN_SECRET__: string;

declare module 'fontkit' {
  export interface Font {
    familyName: string;
    subfamilyName: string;
    getName(key: string): string | null;
    'OS/2'?: { usWeightClass?: number };
    variationAxes?: Record<string, { min: number; default: number; max: number }>;
  }
  export interface FontCollection { fonts: Font[] }
  export function open(file: string): Promise<Font | FontCollection>;
}
