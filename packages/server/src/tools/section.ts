import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { REPLY_TOKEN_LIMIT } from '@pixel-twin/shared';
import type { ServerDeps } from '../createServer';
import { formatCompact, formatOverview } from '../design/compact';
import { loadSection } from '../design/loadSection';
import type { Layer } from '../design/types';
import { estimateTokens, fitReply } from '../reply';
import { resolveTarget, toolError } from './common';

const countLayers = (layer: Layer): number => 1 + layer.children.reduce((n, c) => n + countLayers(c), 0);

export function registerSection(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_section',
    {
      description:
        'Reads one Figma section: every visible layer with its position, size, fills, text, layout and effects, plus layout hints and linked style names. '
        + 'Also lists the motion the designer set (prototype interactions with timing and easing, component states such as Hover, fixed and sticky layers, '
        + 'video and GIF fills, text links, Figma Motion keyframes) and motion hints: guesses such as a marquee or tabs, to ask the owner about. '
        + 'By default it replies in a compact form, one line per layer; ask for format "json" to get every field as JSON. '
          + 'A section too big to read at once, such as a whole page, gets an overview instead: its parts to read one at a time, and the styles, fonts and variables it uses. '
          + 'Needs a node id in the link or in nodeId.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to a file or node'),
        nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
        format: z.enum(['compact', 'json']).default('compact').describe('compact: one line per layer (about a fifth of the size). json: every field.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ link, nodeId, format }) => {
      try {
        const target = await resolveTarget(deps, link, nodeId);
        if (!target.nodeId) return toolError('The link has no node-id. Use get_outline to pick a section first.');
        const { section, hints, styles, motionHints } = await loadSection(deps.bridge, target.file, target.nodeId);
        const data = format === 'json' ? { section, hints, styles, motionHints } : formatCompact(section, hints, styles, motionHints);
        // A whole page in one reply fills the agent's memory for the rest of the session: send its parts to read one by one.
        const tokens = estimateTokens(typeof data === 'string' ? data : JSON.stringify(data));
        if (tokens > REPLY_TOKEN_LIMIT && section.root.children.length > 0) {
          return { content: [{ type: 'text', text: formatOverview(section, styles, tokens) }] };
        }
        return await fitReply(data, {
          workDir: deps.workDir,
          label: `section-${target.nodeId.replace(/:/g, '-')}`,
          summary: `${section.name}: ${countLayers(section.root)} layers, ${hints.length} layout hints, ${motionHints.length} motion hints, ${section.warnings.length} warnings`,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
