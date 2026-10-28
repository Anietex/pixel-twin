import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseFigmaLink, toPluginNodeId } from '@pixel-twin/shared';
import type { ConnectedFile } from '../bridge';
import { allowedTarget, URL_NOT_ALLOWED } from '../browser/allowedUrl';
import type { ServerDeps } from '../createServer';
import { detectDevServer, otherProjectOnPort } from '../devServer';
import { loadSection } from '../design/loadSection';
import type { SectionData } from '../design/types';
import { pickFile } from '../files';
import { loadSettings, pageUrl, type Settings } from '../settings';

export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Turns a Figma link (and an optional node id) into the open file to talk to. Throws a plain-language error. */
export async function resolveTarget(
  deps: ServerDeps,
  link: string,
  nodeId?: string,
): Promise<{ file: ConnectedFile; nodeId: string | null }> {
  if (deps.bridgeError) throw deps.bridgeError;
  const parsed = parseFigmaLink(link);
  const node = nodeId ? toPluginNodeId(nodeId) : parsed.nodeId;
  const file = await pickFile(deps.bridge, { ...parsed, nodeId: node });
  return { file, nodeId: node };
}

/**
 * Reads the project settings and turns `url` (a full address, a path on the settings' devServer, or
 * nothing for the devServer itself) into the address to open. With no devServer in the settings, the
 * project's Vite config or dev script gives it. Throws when Pixel Twin may not open the address, or when
 * a program from another project holds its port on this computer.
 * `url` is the full address; `address` is what to open (for a file, the real file behind any symlink).
 */
export async function pageTarget(deps: ServerDeps, url?: string): Promise<{ url: string; address: string; settings: Settings }> {
  const settings = await loadSettings(deps.workDir);
  const needsServer = !settings.devServer && (!url || url.startsWith('/'));
  const detected = needsServer ? await detectDevServer(deps.workDir) : null;
  const full = pageUrl(url, detected ? { ...settings, devServer: detected.url } : settings);
  const address = allowedTarget(full, deps.workDir);
  if (!address) throw new Error(URL_NOT_ALLOWED);
  const other = await otherProjectOnPort(address, deps.workDir);
  if (other) throw new Error(other);
  return { url: full, address, settings };
}

/** The description of a tool's url input. */
export const URL_DESCRIPTION = 'Address of the built page: a full address on the local development server (localhost) with its port, '
  + 'a path such as "/" on the devServer from pixel-twin.json (or the port in the Vite config), or a file inside the project. Leave it out to use the devServer itself.';

/** Width used by the page checks when neither the call nor a linked section gives one (px). */
export const DEFAULT_WIDTH = 1440;

/** Inputs of the whole-page checks (check_motion, record, check_quality). */
export const PAGE_CHECK_INPUTS = {
  link: z.string().optional().describe('A Figma link. With a node id, that section\'s width is used (and check_motion checks its hover timings).'),
  nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
  url: z.string().optional().describe(URL_DESCRIPTION),
  selector: z.string().optional().describe('CSS selector of the part to check. Default: the whole page.'),
  width: z.number().int().positive().optional().describe(`Browser width in px. Default: the linked section's width, else ${DEFAULT_WIDTH}.`),
};

/** The linked section, when the link (or nodeId) names one. */
export async function linkedSection(deps: ServerDeps, link: string | undefined, nodeId: string | undefined): Promise<SectionData | null> {
  if (!link) return null;
  const target = await resolveTarget(deps, link, nodeId);
  return target.nodeId ? (await loadSection(deps.bridge, target.file, target.nodeId)).section : null;
}
