import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { downscalePng } from '../compare/overlay';
import type { ServerDeps } from '../createServer';
import { imageInfo } from '../design/assets';
import { exportPicture } from '../design/exportPicture';
import { safeName } from '../safeName';
import { resolveTarget, toolError } from './common';

/** Frames taller than this (px) get only a 1x picture. */
const TALL_FRAME_PX = 4000;
/** The picture sent back is shrunk until its longest side is at most this (px). */
const MAX_PREVIEW_PX = 4000;

export function registerScreenshot(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_screenshot',
    {
      description:
        'Takes a picture of a Figma node. Saves it at 1x and 2x size in the project folder and returns the 1x picture. Needs a node id in the link or in nodeId.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to a file or node'),
        nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ link, nodeId }) => {
      try {
        const target = await resolveTarget(deps, link, nodeId);
        if (!target.nodeId) return toolError('The link has no node-id. Use get_outline to pick a section first.');
        const id = target.file.connectionId;
        const one = await exportPicture(deps.bridge, id, { nodeId: target.nodeId, format: 'PNG', scale: 1 });
        if (!one.base64) return toolError('Figma did not return a picture for this node.');
        const onePng = Buffer.from(one.base64, 'base64');
        const size = imageInfo(onePng);
        const dir = path.resolve(deps.workDir, '.pixel-twin', 'shots');
        await mkdir(dir, { recursive: true });
        const name = safeName(target.nodeId);
        const path1 = path.join(dir, `${name}@1x.png`);
        await writeFile(path1, onePng);
        const lines = [`Saved 1x picture to ${path1}`];
        // A very tall frame at 2x is slow to export and huge; 1x is enough to look at.
        if (size && size.height > TALL_FRAME_PX) {
          lines.push(`The frame is ${size.height} px tall, so no 2x picture was made. Use get_screenshot on a smaller section for 2x.`);
        } else {
          const two = await exportPicture(deps.bridge, id, { nodeId: target.nodeId, format: 'PNG', scale: 2 });
          if (!two.base64) return toolError('Figma did not return a picture for this node.');
          const path2 = path.join(dir, `${name}@2x.png`);
          await writeFile(path2, Buffer.from(two.base64, 'base64'));
          lines.push(`Saved 2x picture to ${path2}`);
        }
        // Pictures sent back must stay small enough to view, so a tall one is shrunk for the preview.
        const shrink = size ? Math.ceil(Math.max(size.height, size.width) / MAX_PREVIEW_PX) : 1;
        const preview = shrink > 1 ? downscalePng(onePng, shrink) : onePng;
        if (shrink > 1) lines.push(`The picture below is shrunk ${shrink} times to fit; open the saved file for full size.`);
        return {
          content: [
            { type: 'text', text: lines.join('\n') },
            { type: 'image', data: preview.toString('base64'), mimeType: 'image/png' },
          ],
        };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
