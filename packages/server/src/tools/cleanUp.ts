import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../createServer';
import { cleanWorkFiles, formatSize } from '../workFiles';
import { toolError } from './common';

export function registerCleanUp(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'clean_up',
    {
      description:
        'Deletes Pixel Twin\'s working files in the project\'s .pixel-twin folder: the compare, screenshot and responsive pictures, the large replies saved there, '
        + 'and your own working files in .pixel-twin/scratch. Keeps compare\'s memory (history.json and explained.json) and, unless keepVideos is false, '
        + 'the videos from record. It also deletes the plan in .pixel-twin/plan.md, so a section builder must never call it. '
        + 'It touches nothing outside .pixel-twin. Call it when the whole build is done, before the final report.',
      inputSchema: z.object({
        keepVideos: z.boolean().default(true).describe('Keep the videos from record for the owner to watch. Default: true.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ keepVideos }) => {
      try {
        const r = await cleanWorkFiles(deps.workDir, { keepVideos });
        const lines = [r.files === 0
          ? `Nothing to delete in ${r.folder}.`
          : `Deleted ${r.files} working files (${formatSize(r.bytes)}) from ${r.folder}.`];
        const videos = r.kept.filter((f) => f.startsWith('record/'));
        const memory = r.kept.filter((f) => !f.startsWith('record/'));
        if (memory.length) lines.push(`Kept compare's memory: ${memory.join(', ')}.`);
        if (videos.length) lines.push(`Kept the videos for the owner: ${videos.join(', ')}.`);
        if (r.failed.length) lines.push(`Could not delete: ${r.failed.join(', ')}.`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
