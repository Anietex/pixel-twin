import type { PluginMethods } from '@pixel-twin/shared';
import { EXPORT_TIMEOUT_MS, type Bridge } from '../bridge';
import { PluginError } from '../errors';

type Params = PluginMethods['exportNode']['params'];
type Result = PluginMethods['exportNode']['result'];

/** Figma's message when the app loses touch with Figma's servers while it makes a picture. */
const CONNECTION_LOST = /unable to establish connection to figma/i;

/** How long to wait before the second try (ms). */
export const EXPORT_RETRY_DELAY_MS = 1000;

/**
 * Asks the plugin for a picture (or SVG) of a layer. Figma's export sometimes fails for a moment, so a
 * failure the plugin reports is tried once more. A second failure becomes a plain-language error.
 * Timeouts and a closed plugin are not tried again: they would only fail the same way.
 */
export async function exportPicture(
  bridge: Pick<Bridge, 'call'>,
  connectionId: string,
  params: Params,
  retryDelayMs = EXPORT_RETRY_DELAY_MS,
): Promise<Result> {
  const once = () => bridge.call(connectionId, 'exportNode', params, { timeoutMs: EXPORT_TIMEOUT_MS });
  try {
    return await once();
  } catch (err) {
    if (!(err instanceof PluginError)) throw err;
  }
  await new Promise((r) => setTimeout(r, retryDelayMs));
  try {
    return await once();
  } catch (err) {
    if (!(err instanceof PluginError)) throw err;
    throw new Error(explainExportError(err.message, params));
  }
}

/** The plain-language message for an export that failed twice. */
export function explainExportError(figmaMessage: string, params: Params): string {
  const what = `${params.format === 'SVG' ? 'an SVG' : 'a picture'} of layer ${params.nodeId}`;
  if (CONNECTION_LOST.test(figmaMessage)) {
    return `Figma could not make ${what}: the Figma app lost its connection to Figma's servers while exporting. `
      + 'It failed twice. Check the internet connection, wait a moment and try again. '
      + `If it keeps failing, restart the Figma app and run Pixel Twin again. (Figma said: "${figmaMessage}")`;
  }
  return `Figma could not make ${what}. It failed twice. (Figma said: "${figmaMessage}")`;
}
