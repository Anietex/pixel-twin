import path from 'node:path';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { isAllowedUrl } from '../browser/allowedUrl';
import type { ServerDeps } from '../createServer';
import { easingCss } from '../design/motion';
import type { Layer } from '../design/types';
import { type AnimationRecord, checkMotion, type ExpectedHover } from '../motion/checkMotion';
import { recordPage } from '../motion/record';
import { fitReply } from '../reply';
import { safeName } from '../safeName';
import { DEFAULT_WIDTH, linkedSection, PAGE_CHECK_INPUTS, pageTarget, toolError } from './common';

const HOVER_TRIGGERS = new Set(['ON_HOVER', 'MOUSE_ENTER']);

/** The hover transitions the designer set: on layers, and on the variant an instance shows. */
export function expectedHovers(root: Layer): ExpectedHover[] {
  const out: ExpectedHover[] = [];
  const visit = (layer: Layer): void => {
    const m = layer.motion;
    const current = m?.states?.variants.find((v) => Object.entries(m.states!.current).every(([k, val]) => v.properties[k] === val));
    for (const i of [...(m?.interactions ?? []), ...(current?.interactions ?? [])]) {
      if (!HOVER_TRIGGERS.has(i.trigger) || !i.transition) continue;
      out.push({ layerId: layer.id, layerName: layer.name, durationMs: i.transition.durationMs, easing: easingCss(i.transition.easing) });
      break;   // one per layer
    }
    layer.children.forEach(visit);
  };
  visit(root);
  return out;
}

/** An animation as the reply shows it: fields with no value, and a layer id the element already names, are left out. */
type ShownAnimation = Partial<AnimationRecord>;

/**
 * Shortens the animation list for the reply: animations that differ only in the property they move become one,
 * with the properties joined, such as "opacity, transform".
 */
export function compactAnimations(records: AnimationRecord[]): ShownAnimation[] {
  const groups = new Map<string, { record: AnimationRecord; properties: string[] }>();
  for (const r of records) {
    const key = JSON.stringify({ ...r, property: null });
    const group = groups.get(key);
    if (group) {
      if (!group.properties.includes(r.property)) group.properties.push(r.property);
    } else {
      groups.set(key, { record: r, properties: [r.property] });
    }
  }
  return [...groups.values()].map(({ record, properties }) => {
    const shown: ShownAnimation = { ...record, property: properties.join(', ') };
    if (record.layerId === null || record.element === `[data-figma-id="${record.layerId}"]`) delete shown.layerId;
    if (record.name === null) delete shown.name;
    if (record.hovered === null) delete shown.hovered;
    return shown;
  });
}

export function registerMotion(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'check_motion',
    {
      description:
        'Checks the motion of a built page. With motion allowed, it hovers every link and button, scrolls the page for 3 seconds, and records every animation '
        + '(property, duration, delay, easing). It reports motion on width, height, top, left or margin; layout shift above 0.01 while scrolling; frames over 50 ms; '
        + 'hover timings that differ from the Figma interactions; and a marquee that jumps where its loop restarts. Then, with "reduce motion" on, it reports '
        + 'anything that still moves and any layer still hidden. Colour and opacity fades left on with reduce motion are warnings, not problems: a fade is not motion. '
        + 'Run it after compare passes and the motion is built.',
      inputSchema: z.object(PAGE_CHECK_INPUTS),
      annotations: { readOnlyHint: false },
    },
    async ({ link, nodeId, url, selector, width }) => {
      try {
        const { address } = await pageTarget(deps, url);
        const section = await linkedSection(deps, link, nodeId);
        const report = await checkMotion(deps.browser, {
          url: address, scope: selector ?? 'body', width: width ?? section?.width ?? DEFAULT_WIDTH,
          expected: section ? expectedHovers(section.root) : [], isAllowed: (u) => isAllowedUrl(u, deps.workDir),
        });
        return await fitReply({ ...report, animations: compactAnimations(report.animations) }, {
          workDir: deps.workDir, label: 'motion',
          summary: `${report.problems.length} motion problems, ${report.warnings.length} warnings, ${report.animations.length} animations recorded, ${report.hovered} elements hovered`,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'record',
    {
      description:
        'Records a short video (.webm) of the built page with motion allowed: the first screen loading, a smooth scroll to the bottom and back, '
        + 'and the mouse over the main links and buttons. Saves it in .pixel-twin/record/ for the owner to judge the feel before approving. A new video of the same section and width replaces the old one.',
      inputSchema: z.object(PAGE_CHECK_INPUTS),
      annotations: { readOnlyHint: false },
    },
    async ({ link, nodeId, url, selector, width }) => {
      try {
        const { address } = await pageTarget(deps, url);
        const section = await linkedSection(deps, link, nodeId);
        const w = width ?? section?.width ?? DEFAULT_WIDTH;
        const outFile = path.join(deps.workDir, '.pixel-twin', 'record', `${safeName(section?.name ?? 'page')}-${w}.webm`);
        const r = await recordPage(deps.browser, { url: address, width: w, scope: selector ?? 'body', outFile, isAllowed: (u) => isAllowedUrl(u, deps.workDir) });
        return { content: [{ type: 'text', text: `Saved a ${r.seconds}-second video at ${w} px (${r.hovered} hovers) to ${r.file}. Ask the owner to watch it.` }] };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
