import { EXPORT_TIMEOUT_MS, type Bridge, type ConnectedFile } from '../bridge';
import { applyExtras } from './extras';
import { layoutHints, type LayoutHint } from './layoutHints';
import { applyMotion } from './motion';
import { motionHints, type MotionHint } from './motionHints';
import { toSectionData, type RestNode } from './normalize';
import { collectStyles, type LinkedStyle } from './styles';
import type { SectionData } from './types';

const OLDER_PLUGIN = 'the Figma plugin is an older build. Close the Pixel Twin window in Figma and run it again.';

/** Asks the plugin for one section and turns it into the data the tools send. */
export async function loadSection(
  bridge: Bridge,
  file: ConnectedFile,
  nodeId: string,
): Promise<{ section: SectionData; hints: LayoutHint[]; styles: LinkedStyle[]; motionHints: MotionHint[] }> {
  const id = file.connectionId;
  const [json, textDetails, variables, extras, motion] = await Promise.all([
    bridge.call(id, 'getNodeJson', { nodeId }),
    bridge.call(id, 'getTextDetails', { nodeId }),
    bridge.call(id, 'resolveVariables', { nodeId }),
    // Rotation, size before rotating and style names. A plugin built before this request existed
    // can't answer it; the section still loads, with style names from the export instead.
    bridge.call(id, 'getLayerExtras', { nodeId }).catch(() => null),
    // Interactions, states, video, links and keyframes. It walks every layer, so it gets the long wait.
    // If it fails (an older plugin build can't answer), the section still loads and says why motion is missing.
    bridge.call(id, 'getMotion', { nodeId }, { timeoutMs: EXPORT_TIMEOUT_MS })
      .catch((err: unknown) => ({ failed: err instanceof Error ? err.message : String(err) })),
  ]);
  // The export result may also carry a top-level `styles` map that the shared type does not list.
  const stylesMap = (json as { styles?: Record<string, { name?: string }> }).styles;
  const section = toSectionData({ document: json.document as RestNode, textDetails, variables });
  const styles = extras ? applyExtras(section.root, extras) : collectStyles(json.document, stylesMap);
  if (Array.isArray(motion)) applyMotion(section.root, motion);
  else section.motionError = /Unknown request/.test(motion.failed) ? OLDER_PLUGIN : motion.failed;
  section.motionRead = Array.isArray(motion);
  return { section, hints: layoutHints(section.root), styles, motionHints: motionHints(section.root) };
}
