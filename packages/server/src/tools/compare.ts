import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { toPluginNodeId } from '@pixel-twin/shared';
import { isAllowedUrl } from '../browser/allowedUrl';
import { inBrowser } from '../browser/errors';
import { compareOnPage, SCALE } from '../compare/runCompare';
import { downscalePng } from '../compare/overlay';
import type { ServerDeps } from '../createServer';
import { fitReply } from '../reply';
import { pageTarget, resolveTarget, toolError, URL_DESCRIPTION } from './common';

export function registerCompare(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'compare',
    {
      description:
        'Checks a built section against its Figma design. Opens url in a headless browser at width, measures every element with a data-figma-id inside the one element that selector matches, and lists every difference in position, size, colour, border, radius, shadow, blur, opacity, font and line count. '
        + 'Also saves the design, build and difference pictures, lists the changed areas (regions) in px, and counts rounds without fewer differences (stop when shouldStop is true). '
        + 'pass covers the numbers only. You must still look at every area in regions and every checkByEye item in the pictures. '
        + 'If cannotMatch is not empty, stop and tell the owner: no browser can draw those things exactly. '
        + 'With state, it first hovers, focuses or presses the element, then compares it with the Figma variant for that state. Needs a node id in the link or in nodeId.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to a file or node'),
        nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
        url: z.string().optional().describe(URL_DESCRIPTION),
        selector: z.string().describe('CSS selector for the section root. It must match exactly one element.'),
        width: z.number().int().positive().describe('Browser width in px. Use the width of the design.'),
        explained: z.array(z.object({ layerId: z.string(), reason: z.string() })).optional()
          .describe('Layers built without their own element on purpose, each with the reason. Remembered for later rounds of this section.'),
        reset: z.boolean().optional().describe('Start the round count again and forget remembered explanations, for example after the owner changed the design'),
        state: z.object({
          kind: z.enum(['hover', 'focus', 'active']).describe('hover: the mouse over the element. focus: keyboard focus on it. active: the mouse pressed on it.'),
          nodeId: z.string().describe('Node id of the Figma variant for this state, such as the State=Hover variant listed in get_section'),
          target: z.string().optional().describe('CSS selector of the element to hover, focus or press. Default: the section root (selector).'),
        }).optional().describe('Compare a state instead of the resting look. nodeId stays the layer the page shows; its elements pair with the variant\'s layers by name path.'),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ link, nodeId, url: given, selector, width, explained, reset, state }) => {
      const allowed = (u: string) => isAllowedUrl(u, deps.workDir);
      try {
        const { url, address } = await pageTarget(deps, given);
        const target = await resolveTarget(deps, link, nodeId);
        if (!target.nodeId) return toolError('The link has no node-id. Use get_outline to pick a section first.');
        const session = await inBrowser(() => deps.browser.open(address, width, SCALE, allowed));
        try {
          const reasons = (explained ?? []).map((e) => ({ layerId: toPluginNodeId(e.layerId), reason: e.reason }));
          const outcome = await compareOnPage(deps, session.page, allowed, target.file, target.nodeId,
            { url, selector, width, explained: reasons, reset: reset ?? false,
              state: state && { kind: state.kind, nodeId: toPluginNodeId(state.nodeId), target: state.target } });
          if (!outcome.ok) return toolError(outcome.error);
          const text = await fitReply(outcome.reply, { workDir: deps.workDir, label: 'compare', summary: outcome.summary });
          const diff1x = downscalePng(await readFile(outcome.reply.images.diff), SCALE);
          return { content: [...text.content, { type: 'image', data: diff1x.toString('base64'), mimeType: 'image/png' }] };
        } finally {
          await session.close().catch(() => undefined);   // a failed close must not hide the result
        }
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
