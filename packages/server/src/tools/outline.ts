import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../createServer';
import { fitReply } from '../reply';
import { resolveTarget, toolError } from './common';

export function registerOutline(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_outline',
    {
      description:
        'Lists the layers of a Figma node as a tree (name, type, position, size). Without a node it lists the pages of the file. Use it to pick a section for get_section.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to a file or node'),
        nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
        depth: z.number().int().min(1).max(10).default(2).describe('How many levels of children to list'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ link, nodeId, depth }) => {
      try {
        const target = await resolveTarget(deps, link, nodeId);
        const outline = await deps.bridge.call(target.file.connectionId, 'getOutline', { nodeId: target.nodeId, depth });
        return await fitReply(outline, {
          workDir: deps.workDir,
          label: 'outline',
          summary: `${outline.length} top-level items${target.nodeId ? ` under ${target.nodeId}` : ' (pages)'}`,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
