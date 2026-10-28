import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { toPluginNodeId } from '@pixel-twin/shared';
import type { ConnectedFile } from '../bridge';
import { isAllowedUrl } from '../browser/allowedUrl';
import { inBrowser } from '../browser/errors';
import { areaKindSummary } from '../compare/overlay';
import { compareOnPage, SCALE } from '../compare/runCompare';
import type { ServerDeps } from '../createServer';
import { fitReply } from '../reply';
import { pageTarget, resolveTarget, toolError, URL_DESCRIPTION } from './common';

/** At most this many sections in one call. */
const MAX_SECTIONS = 50;

/** CSS selector for the element that carries this layer id. */
export const byLayerId = (id: string): string => `[data-figma-id="${id.replace(/["\\]/g, '\\$&')}"]`;

/**
 * Finds the sections on an open page when the agent did not list them.
 * - When the link points to a frame that has no element on the page (the page frame), the sections are
 *   the frame's visible direct children, top to bottom. A section with no element yet fails its row.
 * - Otherwise they are the elements with a data-figma-id that sit inside no other one (within `root`).
 */
async function findSections(deps: ServerDeps, page: Page, file: ConnectedFile, frameId: string | null, root: string | undefined): Promise<{
  found: 'figma-frame' | 'page'; sections: { nodeId: string; selector: string }[];
}> {
  const onPage = await inBrowser(() => page.evaluate(({ rootSelector, frame }) => {
    const scope = rootSelector ? document.querySelector(rootSelector) : document.body;
    if (!scope) return null;
    const top = [...scope.querySelectorAll('[data-figma-id]')].filter((el) => {
      const up = el.parentElement?.closest('[data-figma-id]');
      return !up || !scope.contains(up);
    });
    const frameShown = frame !== null && document.querySelector(`[data-figma-id="${CSS.escape(frame)}"]`) !== null;
    return { frameShown, ids: [...new Set(top.map((el) => el.getAttribute('data-figma-id') ?? ''))] };
  }, { rootSelector: root ?? null, frame: frameId }));
  if (onPage === null) throw new Error(`No element matches the root selector "${root}"`);
  if (frameId && !onPage.frameShown) {
    const outline = await deps.bridge.call(file.connectionId, 'getOutline', { nodeId: frameId, depth: 1 }).catch(() => null);
    const children = (outline?.[0]?.children ?? []).filter((c) => c.visible).sort((a, b) => a.y - b.y || a.x - b.x);
    if (children.length > 0) return { found: 'figma-frame', sections: children.map((c) => ({ nodeId: c.id, selector: byLayerId(c.id) })) };
  }
  return { found: 'page', sections: onPage.ids.map((id) => ({ nodeId: id, selector: byLayerId(id) })) };
}

export function registerComparePage(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'compare_page',
    {
      description:
        'Runs compare on many sections of one page in a single call and returns one table: pass or fail and the counts for each section. '
        + 'Opens the page once at width. Each section\'s full compare result is saved as result.json in its pictures folder. '
        + 'Leave out sections to find them: with a page frame in the link, the frame\'s direct children (a section not built yet fails its row); '
        + 'otherwise the elements with a data-figma-id that sit inside no other one. '
        + 'Use it for a whole page; use compare on one section to see its differences while fixing it.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to the file'),
        url: z.string().optional().describe(URL_DESCRIPTION),
        width: z.number().int().positive().describe('Browser width in px. Use the width of the design.'),
        sections: z.array(z.object({
          nodeId: z.string().describe('Node id of the section, such as 1-2 or 1:2'),
          selector: z.string().describe('CSS selector for the section root on the page. It must match exactly one element.'),
        })).min(1).max(MAX_SECTIONS).optional().describe('The sections to compare. Leave out to find them.'),
        root: z.string().optional().describe('When sections is left out and the link has no frame: CSS selector of the element that holds the sections. Default: the whole page.'),
        reset: z.boolean().optional().describe('Start every section\'s round count again and forget remembered explanations'),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ link, url: given, width, sections, root, reset }) => {
      const allowed = (u: string) => isAllowedUrl(u, deps.workDir);
      try {
        const { url, address } = await pageTarget(deps, given);
        const target = await resolveTarget(deps, link, sections ? toPluginNodeId(sections[0].nodeId) : undefined);
        const { file } = target;
        const session = await inBrowser(() => deps.browser.open(address, width, SCALE, allowed));
        try {
          const list = sections
            ? { found: 'given' as const, sections: sections.map((s) => ({ nodeId: toPluginNodeId(s.nodeId), selector: s.selector })) }
            : await findSections(deps, session.page, file, target.nodeId, root);
          if (list.sections.length === 0) {
            return toolError('Found no sections: no element on the page has a data-figma-id. Give sections, or check the url.');
          }
          if (list.sections.length > MAX_SECTIONS) {
            return toolError(`Found ${list.sections.length} sections; at most ${MAX_SECTIONS} fit in one call. Give sections in smaller lists.`);
          }
          const rows = [];
          for (const s of list.sections) {
            const nodeId = s.nodeId;
            let outcome: Awaited<ReturnType<typeof compareOnPage>>;
            try {
              outcome = await compareOnPage(deps, session.page, allowed, file, nodeId,
                { url, selector: s.selector, width, explained: [], reset: reset ?? false });
            } catch (err) {
              outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            if (!outcome.ok) {
              rows.push({ nodeId, selector: s.selector, pass: false, error: outcome.error });
              continue;
            }
            const r = outcome.reply;
            const result = path.join(outcome.outDir, 'result.json');
            await writeFile(result, JSON.stringify(r, null, 2));
            rows.push({
              nodeId, name: outcome.name, selector: s.selector, pass: r.pass,
              differences: r.differences.length, unmapped: r.unmapped.length, checkByEye: r.checkByEye.length,
              cannotMatch: r.cannotMatch.length, regions: r.regions.length,
              ...(r.regions.length ? { areas: areaKindSummary(r.regions) } : {}), shouldStop: r.shouldStop, result,
            });
          }
          const passed = rows.filter((r) => r.pass).length;
          return await fitReply({ width, found: list.found, sections: rows }, {
            workDir: deps.workDir, label: 'compare-page', summary: `${passed} of ${rows.length} sections pass at ${width} px`,
          });
        } finally {
          await session.close().catch(() => undefined);
        }
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
