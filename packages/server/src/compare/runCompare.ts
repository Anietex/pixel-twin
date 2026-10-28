import path from 'node:path';
import type { Page } from 'playwright';
import type { ConnectedFile } from '../bridge';
import { URL_NOT_ALLOWED } from '../browser/allowedUrl';
import { pageBackground } from '../browser/background';
import { inBrowser, isSelectorError, measureFailure, PageError } from '../browser/errors';
import { checkLines } from '../browser/lines';
import { measureSection, type MeasuredElement } from '../browser/measure';
import { applyState, prepareCapture, settleSection, type StateKind } from '../browser/settle';
import type { ServerDeps } from '../createServer';
import { assetCoveredIds, imageInfo, planAssets } from '../design/assets';
import { exportPicture } from '../design/exportPicture';
import { loadSection } from '../design/loadSection';
import { asState } from '../design/stateSection';
import type { Layer } from '../design/types';
import { safeName } from '../safeName';
import { diffSection, lineTargets, type CannotMatch, type CheckByEye, type Difference, type KnownLimit, type Unchecked } from './diffNumbers';
import { recordRound, rememberExplained, type Explanation } from './history';
import { areaKindSummary, makeOverlay, type Rect, type Region } from './overlay';

/** Pictures are taken at twice the CSS size, the same as the Figma export. */
export const SCALE = 2;
/** How long to wait for the section root to be visible before taking its picture. */
const SCREENSHOT_TIMEOUT_MS = 5000;
/** The design picture may differ from the section size by this many device px before it is noted. */
const PICTURE_SIZE_SLACK_PX = 2;

export interface CompareReply {
  width: number; pass: boolean; total: number;
  differences: Difference[]; unmapped: { layerId: string; layerName: string }[];
  checkByEye: CheckByEye[]; cannotMatch: CannotMatch[]; knownLimits: KnownLimit[]; unchecked: Unchecked[]; explained: Explanation[];
  regions: Region[]; textEdgeAreas: number; images: { design: string; build: string; diff: string };
  roundsWithoutProgress: number; shouldStop: boolean;
}

/** The boxes of text elements whose layer has no differences: letter-edge noise inside them is not a change. */
function matchingTextBoxes(root: Layer, elements: MeasuredElement[], differences: Difference[]): Rect[] {
  const differs = new Set(differences.map((d) => d.layerId));
  const texts = new Set<string>();
  const visit = (layer: Layer): void => {
    if (layer.text && !differs.has(layer.id)) texts.add(layer.id);
    layer.children.forEach(visit);
  };
  visit(root);
  return elements.filter((e) => texts.has(e.figmaId) && e.visible)
    .map((e) => ({ x: e.x, y: e.y, width: e.width, height: e.height }));
}

/** A layer at most this many px across is a thin layer, such as a divider. */
const THIN_LAYER_PX = 2;

/**
 * Where the design draws lines (1x px): each side of a layer's stroke (inside, across or outside the edge,
 * as set), and thin layers such as dividers. Layers drawn inside an exported picture are left out.
 */
export function designLineBoxes(root: Layer, covered: Set<string>): Rect[] {
  const out: Rect[] = [];
  const visit = (l: Layer): void => {
    if (covered.has(l.id)) return;
    const weight = Math.max(0, ...l.strokes.map((s) => s.weight));
    const thinX = l.width <= THIN_LAYER_PX;
    const thinY = l.height <= THIN_LAYER_PX;
    if (!l.text && (thinX || thinY) && (l.fills.length > 0 || l.strokes.length > 0)) {
      // A line layer's stroke sits across its box, so the box grows by half the weight on its thin side.
      out.push({ x: l.x - (thinX ? weight / 2 : 0), y: l.y - (thinY ? weight / 2 : 0),
        width: l.width + (thinX ? weight : 0), height: l.height + (thinY ? weight : 0) });
    } else if (l.strokes.length > 0) {
      const { weights, align } = l.strokes[0];
      // The band each side's line covers, measured inwards from the edge.
      const band = (w: number): [number, number] => (align === 'INSIDE' ? [0, w] : align === 'CENTER' ? [-w / 2, w / 2] : [-w, 0]);
      const [top, right, bottom, left] = weights;
      if (top > 0) { const [a, b] = band(top); out.push({ x: l.x, y: l.y + a, width: l.width, height: b - a }); }
      if (bottom > 0) { const [a, b] = band(bottom); out.push({ x: l.x, y: l.y + l.height - b, width: l.width, height: b - a }); }
      if (left > 0) { const [a, b] = band(left); out.push({ x: l.x + a, y: l.y, width: b - a, height: l.height }); }
      if (right > 0) { const [a, b] = band(right); out.push({ x: l.x + l.width - b, y: l.y, width: b - a, height: l.height }); }
    }
    l.children.forEach(visit);
  };
  visit(root);
  return out;
}

/** At most this many layers are named for each changed area. */
export const MAX_AREA_LAYERS = 5;

/**
 * The layers whose elements a changed area (1x px) touches, the biggest overlap first. An element is left
 * out when the area's part inside it lies inside one of its own elements, which is named instead, and the
 * section root (`rootId`) is left out when other layers are named. For a line area, elements with an edge
 * along the line come first, smallest first, since one of them should draw it.
 */
export function layersInArea(area: Region, elements: MeasuredElement[], names: Map<string, string>, rootId: string): { layerId: string; layerName: string }[] {
  const cut = (e: MeasuredElement) => {
    const x0 = Math.max(e.x, area.x);
    const y0 = Math.max(e.y, area.y);
    return { x0, y0, x1: Math.min(e.x + e.width, area.x + area.width), y1: Math.min(e.y + e.height, area.y + area.height) };
  };
  const overlap = (e: MeasuredElement) => {
    const c = cut(e);
    return Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0);
  };
  const touching = elements.filter((e) => e.visible && e.width > 0 && e.height > 0 && overlap(e) > 0);
  const holds = (a: MeasuredElement, b: MeasuredElement) => a !== b && a.x <= b.x && a.y <= b.y
    && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height && a.width * a.height > b.width * b.height;
  const within = (a: MeasuredElement, b: MeasuredElement) => {
    const c = cut(a);
    return c.x0 >= b.x - 1 && c.y0 >= b.y - 1 && c.x1 <= b.x + b.width + 1 && c.y1 <= b.y + b.height + 1;
  };
  let named = touching.filter((a) => !touching.some((b) => holds(a, b) && within(a, b))).sort((a, b) => overlap(b) - overlap(a));
  if (named.some((e) => e.figmaId !== rootId)) named = named.filter((e) => e.figmaId !== rootId);
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const alongLine = area.kind.startsWith('line') ? touching.filter((e) => (area.height <= area.width
    ? near(e.y, area.y) || near(e.y + e.height, area.y + area.height)
    : near(e.x, area.x) || near(e.x + e.width, area.x + area.width))) : [];
  const out: { layerId: string; layerName: string }[] = [];
  for (const e of [...alongLine.sort((a, b) => a.width * a.height - b.width * b.height), ...named]) {
    if (out.length >= MAX_AREA_LAYERS) break;
    if (!out.some((o) => o.layerId === e.figmaId)) out.push({ layerId: e.figmaId, layerName: names.get(e.figmaId) ?? '' });
  }
  return out;
}

export type CompareOutcome =
  | { ok: true; name: string; reply: CompareReply; outDir: string; summary: string }
  | { ok: false; error: string };

/**
 * Compares one section on a page that is already open at `width`: measures it, checks it against the
 * design, makes the overlay pictures and records the round. Returns a plain error instead of throwing
 * for a wrong selector or a page that moved away.
 */
export async function compareOnPage(
  deps: ServerDeps,
  page: Page,
  isAllowed: (url: string) => boolean,
  file: ConnectedFile,
  nodeId: string,
  args: { url: string; selector: string; width: number; explained: Explanation[]; reset: boolean;
    state?: { kind: StateKind; nodeId: string; target?: string } },
): Promise<CompareOutcome> {
  const { url, selector, width, state } = args;
  const fail = (error: string): CompareOutcome => ({ ok: false, error });
  // The page may try to move somewhere else after it opens. Never measure or picture it there.
  const leftAllowed = () => !isAllowed(page.url());
  try {
    const root = page.locator(selector);
    let appeared: boolean;
    try {
      appeared = await settleSection(page, selector, { loadAllPictures: true });
    } catch (err) {
      if (leftAllowed()) return fail(URL_NOT_ALLOWED);
      if (isSelectorError(err)) return fail(`The selector "${selector}" is not a valid selector`);
      throw new PageError(measureFailure(err));
    }
    if (leftAllowed()) return fail(URL_NOT_ALLOWED);
    const count = appeared ? await inBrowser(() => root.count()) : 0;
    if (count === 0) return fail(`No element matches "${selector}" on ${url}`);
    if (count > 1) return fail(`The selector "${selector}" matches ${count} elements; it must match exactly one`);

    if (state) {
      const problem = await inBrowser(() => applyState(page, state.kind, state.target ?? selector));
      if (leftAllowed()) return fail(URL_NOT_ALLOWED);
      if (problem) return fail(problem);
    }
    const measured = await inBrowser(() => measureSection(page, selector));
    const shown = (await loadSection(deps.bridge, file, nodeId)).section;
    // For a state, the design is the state's variant, paired with the layers the page shows by name path.
    const section = state ? asState((await loadSection(deps.bridge, file, state.nodeId)).section, shown) : shown;
    const covered = assetCoveredIds(section.root, planAssets(section.root));
    const reasons = await rememberExplained(deps.workDir, nodeId, args.explained, args.reset);
    const lines = await inBrowser(() => checkLines(page, selector, lineTargets(section, covered)));
    if (leftAllowed()) return fail(URL_NOT_ALLOWED);
    const result = diffSection(section, measured.elements, covered, reasons, lines);

    const exported = await exportPicture(deps.bridge, file.connectionId, { nodeId: state?.nodeId ?? nodeId, format: 'PNG', scale: SCALE });
    if (!exported.base64) return fail('Figma did not return a picture for this node.');
    const designPng = Buffer.from(exported.base64, 'base64');
    const checkByEye: CheckByEye[] = [...result.checkByEye];
    const size = imageInfo(designPng);
    if (!size || Math.abs(size.width - section.width * SCALE) > PICTURE_SIZE_SLACK_PX
      || Math.abs(size.height - section.height * SCALE) > PICTURE_SIZE_SLACK_PX) {
      checkByEye.push({ layerId: section.rootId, layerName: section.name, property: 'picture',
        reason: 'Design picture is a different size from the section; overlay may be shifted' });
    }
    let buildPng: Buffer;
    // Sticky and fixed page parts would be painted over a tall section, and smooth scrolling shifts the picture.
    const restore = await inBrowser(() => prepareCapture(page, selector));
    try {
      buildPng = await root.screenshot({ animations: 'disabled', timeout: SCREENSHOT_TIMEOUT_MS });
    } catch (err) {
      if (leftAllowed()) return fail(URL_NOT_ALLOWED);
      if (err instanceof Error && err.name === 'TimeoutError') {
        return fail(`Could not take a picture of "${selector}" on ${url}. Is it visible on the page?`);
      }
      throw new PageError(measureFailure(err));
    } finally {
      await restore();
    }
    const key = `${nodeId}@${width}${state ? `-${state.kind}` : ''}`;   // each state keeps its own rounds and pictures
    const outDir = path.join(deps.workDir, '.pixel-twin', 'compare', `${safeName(nodeId)}@${width}${state ? `-${state.kind}` : ''}`);
    const background = await inBrowser(() => pageBackground(page, selector));
    const overlay = await makeOverlay(designPng, buildPng, outDir, SCALE,
      { background, textBoxes: matchingTextBoxes(section.root, measured.elements, result.differences), lineBoxes: designLineBoxes(section.root, covered) });

    const names = new Map<string, string>();
    const index = (l: Layer): void => { names.set(l.id, l.name); l.children.forEach(index); };
    index(section.root);
    for (const region of overlay.regions) region.layers = layersInArea(region, measured.elements, names, section.rootId);

    const total = result.differences.length + result.unmapped.length;
    const round = await recordRound(deps.workDir, key, total, args.reset);
    const reply: CompareReply = {
      width, pass: total === 0 && result.cannotMatch.length === 0, total,
      differences: result.differences, unmapped: result.unmapped,
      checkByEye, cannotMatch: result.cannotMatch, knownLimits: result.knownLimits, unchecked: result.unchecked, explained: reasons, regions: overlay.regions, textEdgeAreas: overlay.textEdgeAreas,
      images: { design: overlay.designPath, build: overlay.buildPath, diff: overlay.diffPath },
      roundsWithoutProgress: round.roundsWithoutProgress, shouldStop: round.shouldStop,
    };
    const summary = `${reply.pass ? 'Pass' : 'Fail'} at ${width} px${state ? ` in the ${state.kind} state` : ''}: ${result.differences.length} differences, ${result.unmapped.length} layers with no element, `
      + `${checkByEye.length} things to check by eye, ${result.cannotMatch.length} things no browser can draw, `
      + `${result.knownLimits.length} known browser limits (not counted), ${result.unchecked.length} skipped (see unchecked), `
      + `${overlay.regions.length} changed areas${overlay.regions.length ? `: ${areaKindSummary(overlay.regions)}` : ''} (${overlay.textEdgeAreas} letter-edge areas left out), ${round.roundsWithoutProgress} rounds without progress${round.shouldStop ? ' (stop and report)' : ''}. Pictures in ${outDir}`;
    return { ok: true, name: section.name, reply, outDir, summary };
  } catch (err) {
    if (leftAllowed()) return fail(URL_NOT_ALLOWED);
    throw err;
  }
}
