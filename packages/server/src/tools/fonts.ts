import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../createServer';
import { loadSection } from '../design/loadSection';
import { createGoogleFontsClient, type GoogleFontsClient } from '../fonts/google';
import { isItalic, locateFonts, MAC_FONT_DIRS, type FontSource } from '../fonts/locate';
import { insideProject } from '../paths';
import { fitReply } from '../reply';
import { safeName } from '../safeName';
import { resolveTarget, toolError } from './common';

/** Saves each Google font in dir. A failed download is noted on that font and the others carry on. */
export async function downloadGoogleFonts(found: FontSource[], dir: string, google: GoogleFontsClient): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const f of found) {
    if (f.source !== 'google' || !f.url) continue;
    const dest = path.join(dir, `${safeName(f.family.replace(/\s+/g, ''))}-${f.weight}${isItalic(f.style) ? 'italic' : ''}.woff2`);
    try {
      await google.download(f.url, dest);
      f.path = dest;
    } catch (err) {
      f.downloadError = `Could not download this font: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export function registerFonts(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_fonts',
    {
      description:
        'Finds where each font of a Figma section can be found: in the project, on this Mac, or on Google Fonts. If fontsDir is given, it also downloads the Google fonts there. It never copies Mac fonts: ask the owner first. Needs a node id in the link or in nodeId.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to a file or node'),
        nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
        projectDir: z.string().describe('The project folder to search for font files. A relative path starts at the project folder.'),
        fontsDir: z.string().optional().describe('Folder to save Google fonts in. A relative path starts at the project folder.'),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ link, nodeId, projectDir, fontsDir }) => {
      try {
        const project = insideProject(deps.workDir, projectDir);
        if (!project) return toolError('projectDir must be inside the project folder');
        const fonts = fontsDir === undefined ? undefined : insideProject(deps.workDir, fontsDir);
        if (fonts === null) return toolError('fontsDir must be inside the project folder');
        const target = await resolveTarget(deps, link, nodeId);
        if (!target.nodeId) return toolError('The link has no node-id. Use get_outline to pick a section first.');
        const { section } = await loadSection(deps.bridge, target.file, target.nodeId);

        const google = createGoogleFontsClient();
        const found = await locateFonts(section.fonts, { projectDir: project, macFontDirs: MAC_FONT_DIRS, google });
        if (fonts) await downloadGoogleFonts(found, fonts, google);
        return await fitReply(found, {
          workDir: deps.workDir,
          label: 'fonts',
          summary: `${found.length} fonts: ${found.filter((f) => f.source === 'missing').length} missing`,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
