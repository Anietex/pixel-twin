import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { FrameSections } from '@pixel-twin/shared';
import type { ServerDeps } from '../createServer';
import { MOBILE_PAGE, rankMobileCandidates } from '../design/mobile';
import { fitReply } from '../reply';
import { resolveTarget, toolError } from './common';

export function registerMobile(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'find_mobile_version',
    {
      description:
        'Finds the mobile version of a desktop section (or whole frame) by comparing names and text, on the same page and on pages named Mobile, Phone or Responsive. Returns ranked candidates (with pageName when on another page), whether the best one is a confident match, and none: true when nothing comes close. If none is true, the file has no mobile design for it: design the phone layout yourself. If it is not confident and none is false, ask the owner which one is right.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to the desktop section or frame'),
        nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ link, nodeId }) => {
      try {
        const target = await resolveTarget(deps, link, nodeId);
        if (!target.nodeId) return toolError('The link has no node-id. Use get_outline to pick a section first.');
        const id = target.file.connectionId;
        const { exists, pageId } = await deps.bridge.call(id, 'hasNode', { nodeId: target.nodeId });
        if (!exists || !pageId) return toolError('That node was not found in the open file.');
        // The phone design may be on its own page, such as "Website 2026 - Mobile".
        const pages = await deps.bridge.call(id, 'getOutline', { nodeId: null, depth: 0 });
        const mobilePages = pages.filter((p) => p.id !== pageId && MOBILE_PAGE.test(p.name.replace(/[–—_-]/g, ' ')));
        const frames: (FrameSections & { pageName?: string })[] = [...await deps.bridge.call(id, 'listSections', { pageId })];
        for (const page of mobilePages) {
          for (const f of await deps.bridge.call(id, 'listSections', { pageId: page.id })) frames.push({ ...f, pageName: page.name });
        }

        const pick = 'Pick a section (a direct child of a frame) or a whole frame, then try again.';
        let desktop: { id: string; name: string; frameId: string; texts: string[]; frameName?: string };
        let frameName: string;
        let pool = frames;
        const owner = frames.find((f) => f.sections.some((s) => s.id === target.nodeId));
        const asFrame = frames.find((f) => f.frameId === target.nodeId);
        if (owner) {
          const s = owner.sections.find((x) => x.id === target.nodeId)!;
          desktop = { id: s.id, name: s.name, frameId: owner.frameId, texts: s.texts, frameName: owner.frameName };
          frameName = owner.frameName;
        } else if (asFrame) {
          const allTexts = (f: typeof asFrame) => f.sections.flatMap((s) => s.texts);
          desktop = { id: asFrame.frameId, name: asFrame.frameName, frameId: asFrame.frameId, texts: allTexts(asFrame) };
          frameName = asFrame.frameName;
          pool = frames.map((f) => ({
            ...f,
            sections: [{ id: f.frameId, name: f.frameName, texts: allTexts(f) }],
          }));
        } else {
          return toolError(pick);
        }

        const ranked = rankMobileCandidates(desktop, pool);
        return await fitReply(
          { desktop: { id: desktop.id, name: desktop.name, frameName }, ...ranked },
          {
            workDir: deps.workDir,
            label: 'mobile',
            summary: `${ranked.candidates.length} candidates for ${desktop.name}, ${ranked.none ? 'no mobile design' : ranked.confident ? 'confident' : 'not confident'}`,
          },
        );
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
