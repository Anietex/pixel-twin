import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { isAllowedUrl } from '../browser/allowedUrl';
import type { ServerDeps } from '../createServer';
import { checkQuality } from '../quality/checkQuality';
import { fitReply } from '../reply';
import { DEFAULT_WIDTH, linkedSection, PAGE_CHECK_INPUTS, pageTarget, toolError } from './common';

export function registerQuality(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'check_quality',
    {
      description:
        'Checks a built page for things the owner should decide on, without changing the design: text contrast against WCAG AA (4.5:1, or 3:1 for large text), '
        + 'images with no alt text, links and buttons with no name, heading order, image weight and oversized images, images below the first screen '
        + 'that are not loading="lazy", and whether the main first-screen image has fetchpriority="high". Report the findings to the owner.',
      inputSchema: z.object(PAGE_CHECK_INPUTS),
      annotations: { readOnlyHint: false },
    },
    async ({ link, nodeId, url, selector, width }) => {
      try {
        const { address } = await pageTarget(deps, url);
        const section = await linkedSection(deps, link, nodeId);
        const report = await checkQuality(deps.browser, {
          url: address, scope: selector ?? 'body', width: width ?? section?.width ?? DEFAULT_WIDTH, isAllowed: (u) => isAllowedUrl(u, deps.workDir),
        });
        return await fitReply(report, {
          workDir: deps.workDir, label: 'quality',
          summary: `${report.findings.length} findings; images ${report.images.firstScreenKB} KB on the first screen, ${report.images.totalKB} KB in all`,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
