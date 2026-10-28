import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';

/** The project settings file, in the project folder. The agent writes it once at the start. */
export const SETTINGS_FILE = 'pixel-twin.json';

const Settings = z.object({
  devServer: z.string().optional().describe('Address of the development server, such as http://localhost:5173'),
  breakpoints: z.object({
    phoneMax: z.number().int().positive().optional(),
    tabletMax: z.number().int().positive().optional(),
  }).optional(),
  scaling: z.enum(['reflow', 'scale']).optional()
    .describe('On screens narrower than the design: reflow the layout, or shrink the whole design like Figma\'s view'),
  motion: z.enum(['none', 'subtle', 'expressive']).optional().describe('The house motion level, when the design has no motion'),
  assetsDir: z.string().optional().describe('Folder for exported images and icons, inside the project'),
});
export type Settings = z.infer<typeof Settings>;

/** Default breakpoints when neither the call nor the settings give them. */
export const DEFAULT_PHONE_MAX = 767;
export const DEFAULT_TABLET_MAX = 1023;

/**
 * Reads pixel-twin.json from the project folder. A missing file gives empty settings. A file that is
 * not valid throws a plain-language error. It is read on every call, so edits apply at once.
 */
export async function loadSettings(workDir: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(path.join(workDir, SETTINGS_FILE), 'utf8');
  } catch {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${SETTINGS_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix the file or delete it.`);
  }
  const parsed = Settings.safeParse(json);
  if (!parsed.success) throw new Error(`${SETTINGS_FILE} has a wrong value: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * The page address to open. A path such as "/about" is joined to the settings' devServer. With no
 * address at all, the devServer itself is used. The result still goes through the localhost check.
 */
export function pageUrl(url: string | undefined, settings: Settings): string {
  if (url && !url.startsWith('/')) return url;
  if (!settings.devServer) {
    throw new Error(url
      ? `"${url}" is a path. Give the full address, or set devServer in ${SETTINGS_FILE}.`
      : `Give url, or set devServer in ${SETTINGS_FILE}. (No Vite config or dev script with a port was found either.)`);
  }
  return url ? new URL(url, settings.devServer).href : settings.devServer;
}

/** The phone and tablet breakpoints: the call's values, else the settings', else 767 and 1023. */
export function breakpoints(settings: Settings, given: { phoneMax?: number; tabletMax?: number }): { phoneMax: number; tabletMax: number } {
  return {
    phoneMax: given.phoneMax ?? settings.breakpoints?.phoneMax ?? DEFAULT_PHONE_MAX,
    tabletMax: given.tabletMax ?? settings.breakpoints?.tabletMax ?? DEFAULT_TABLET_MAX,
  };
}
