import path from 'node:path';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { toPluginNodeId } from '@pixel-twin/shared';
import { isAllowedUrl } from '../browser/allowedUrl';
import type { ServerDeps } from '../createServer';
import { overlappingPairs } from '../design/layoutHints';
import { loadSection } from '../design/loadSection';
import { checkResponsive, widestWidth } from '../responsive/checks';
import { fitReply } from '../reply';
import { safeName } from '../safeName';
import { breakpoints } from '../settings';
import { pageTarget, resolveTarget, toolError, URL_DESCRIPTION } from './common';

/** Which screen a width belongs to, for the reply. */
function screenOf(width: number, phoneMax: number, tabletMax: number): 'phone' | 'tablet' | 'desktop' {
  if (width <= phoneMax) return 'phone';
  return width <= tabletMax ? 'tablet' : 'desktop';
}

export function registerResponsive(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'check_responsive',
    {
      description:
        'Checks that a built section works at every screen width from 320 px to 1920 px, or to 1.5 × the design width for wide designs (every 10 px). '
        + 'Reports sideways scrolling, overlaps the design does not have, text under 12 px, buttons and links under 44 × 44 px at phone and tablet widths, '
        + 'stretched images, and on screens wider than the design: content that is not centred or a section that does not fill the width. '
        + 'On a whole page, centring is checked per section, and full-width backgrounds don\'t count. Tap areas are measured by tapping around each element. '
        + 'With a separate phone design, give phoneNodeId (its overlaps are allowed at phone widths) and phoneSelector when the phone layout is another element. '
        + 'Saves screenshots at 390, 768, 1920 px and the widest width to look at. Fix every problem, then run compare again at the design width. Needs a node id in the link or in nodeId.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to a file or node'),
        nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
        url: z.string().optional().describe(URL_DESCRIPTION),
        selector: z.string().describe('CSS selector for the section root. It must match exactly one element.'),
        phoneMax: z.number().int().positive().optional().describe('Widest phone width in px (default: pixel-twin.json, else 767). Use the app\'s own breakpoints.'),
        tabletMax: z.number().int().positive().optional().describe('Widest tablet width in px (default: pixel-twin.json, else 1023). Use the app\'s own breakpoints.'),
        phoneNodeId: z.string().optional()
          .describe('Node id of the separate phone design (from find_mobile_version). At phone widths, its overlaps are allowed instead of the desktop design\'s.'),
        phoneSelector: z.string().optional()
          .describe('CSS selector for the phone layout\'s root, when the phone layout is a different element (with its own data-figma-id values). Used at phone widths.'),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ link, nodeId, url, selector, phoneNodeId, phoneSelector, ...given }) => {
      try {
        const { address, settings } = await pageTarget(deps, url);
        const { phoneMax, tabletMax } = breakpoints(settings, given);
        const target = await resolveTarget(deps, link, nodeId);
        if (!target.nodeId) return toolError('The link has no node-id. Use get_outline to pick a section first.');
        const { section } = await loadSection(deps.bridge, target.file, target.nodeId);
        const shotsDir = path.join(deps.workDir, '.pixel-twin', 'responsive', safeName(target.nodeId));
        const phoneSection = phoneNodeId ? (await loadSection(deps.bridge, target.file, toPluginNodeId(phoneNodeId))).section : null;
        const phone = phoneSection || phoneSelector
          ? { maxWidth: phoneMax, selector: phoneSelector, overlaps: phoneSection ? overlappingPairs(phoneSection.root) : undefined }
          : undefined;
        const result = await checkResponsive(deps.browser, {
          url: address, selector, designWidth: section.width, designOverlaps: overlappingPairs(section.root),
          tabletMax, phone, shotsDir, isAllowed: (u) => isAllowedUrl(u, deps.workDir),
        });
        const problems = result.problems.map((p) => ({ ...p, screen: screenOf(p.widths[0][0], phoneMax, tabletMax) }));
        const reply = { designWidth: section.width, checkedUpTo: widestWidth(section.width), breakpoints: { phoneMax, tabletMax }, problems, screenshots: result.screenshots };
        return await fitReply(reply, {
          workDir: deps.workDir,
          label: 'responsive',
          summary: `${problems.length} problems from 320 to ${widestWidth(section.width)} px. Screenshots in ${shotsDir}`,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
