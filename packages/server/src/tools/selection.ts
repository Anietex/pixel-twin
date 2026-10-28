import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { figmaLink, type FigmaSelection, type SelectedLayer } from '@pixel-twin/shared';
import type { ConnectedFile } from '../bridge';
import type { ServerDeps } from '../createServer';
import { resolveTarget, toolError } from './common';

/** How many selected layers the status line names. */
const STATUS_NAMES = 3;
/** How long status waits for each plugin to say what is selected (ms), so a busy plugin doesn't hold it up. */
const STATUS_WAIT_MS = 3000;

const NO_FILE = 'No Figma file has Pixel Twin running. Open a file in the Figma desktop app, then run Plugins → Development → Pixel Twin.';

/** True when the plugin was built before it could read the selection. */
const olderPlugin = (err: unknown): boolean => err instanceof Error && err.message.includes('Unknown request: getSelection');

/** The plain explanation when the plugin can't read the selection, or the error itself. */
function selectionError(file: ConnectedFile, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (olderPlugin(err)) {
    return `The Pixel Twin plugin running in ${JSON.stringify(file.fileName)} is an older build that can't read the selection. `
      + 'Build it again (npm run build in the Pixel Twin folder), close its window in Figma, then run Plugins → Development → Pixel Twin again.';
  }
  return message;
}

/** For status: what is selected in a file, in a few words, and whether anything is. It never throws. */
export async function selectionLine(deps: ServerDeps, file: ConnectedFile): Promise<{ text: string; selected: boolean }> {
  let selection: FigmaSelection;
  try {
    selection = await deps.bridge.call(file.connectionId, 'getSelection', {}, { timeoutMs: STATUS_WAIT_MS });
  } catch (err) {
    return { text: `selection unknown${olderPlugin(err) ? ', as this plugin build is older: build it again and re-run it' : ''}`, selected: false };
  }
  if (!Array.isArray(selection?.layers)) return { text: 'selection unknown', selected: false };
  const page = `on page ${JSON.stringify(selection.pageName)}`;
  if (selection.total === 0) return { text: `nothing selected ${page}`, selected: false };
  if (selection.total === 1) {
    return { text: `${JSON.stringify(selection.layers[0].name)} (${selection.layers[0].type}) selected ${page}`, selected: true };
  }
  const names = selection.layers.slice(0, STATUS_NAMES).map((l) => JSON.stringify(l.name)).join(', ');
  return { text: `${selection.total} layers selected ${page}: ${names}${selection.total > STATUS_NAMES ? ', …' : ''}`, selected: true };
}

function describeLayer(file: ConnectedFile, layer: SelectedLayer, index: number): string {
  const where = layer.path.length === 0 ? 'at the top of the page' : `in ${layer.path.map((n) => JSON.stringify(n)).join(' / ')}`;
  // Without the file's key there is no link; the agent passes the file's own link with this nodeId.
  const link = file.fileKey ? figmaLink(file.fileKey, file.fileName, layer.id) : null;
  return `${index + 1}. ${JSON.stringify(layer.name)}: ${layer.type}, ${Math.round(layer.width)} × ${Math.round(layer.height)} px, ${where}`
    + `${layer.visible ? '' : ', hidden'}\n   `
    + (link ?? `nodeId "${layer.id}" (the file's key is not known: pass the file's own link with this nodeId)`);
}

export function registerSelection(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_selection',
    {
      description:
        'Lists the layers the owner has selected in Figma right now (on the page they are on), with a link to each that the other tools take. '
        + 'Use it when the owner says "the selected section" or "this frame" instead of giving a link.',
      inputSchema: z.object({
        link: z.string().optional().describe('A Figma link to the file. Needed only when Pixel Twin runs in more than one file.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ link }) => {
      if (deps.bridgeError) return toolError(deps.bridgeError.message);
      let file: ConnectedFile;
      try {
        if (link) {
          file = (await resolveTarget(deps, link)).file;
        } else {
          const files = deps.bridge.files();
          if (files.length === 0) return toolError(NO_FILE);
          if (files.length > 1) {
            return toolError(`Pixel Twin runs in ${files.length} Figma files: ${files.map((f) => JSON.stringify(f.fileName)).join(', ')}. `
              + 'Pass a link to the file whose selection you want (any link to that file works).');
          }
          file = files[0];
        }
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
      let selection: FigmaSelection;
      try {
        selection = await deps.bridge.call(file.connectionId, 'getSelection', {});
      } catch (err) {
        return toolError(selectionError(file, err));
      }
      const fileName = JSON.stringify(file.fileName);
      const pageName = JSON.stringify(selection.pageName);
      if (selection.total === 0) {
        return { content: [{ type: 'text', text: `Nothing is selected on page ${pageName} in ${fileName}. `
          + 'Ask the owner to select the section in Figma, then call get_selection again.' }] };
      }
      const count = selection.total === 1 ? '1 layer' : `${selection.total} layers`;
      const partial = selection.layers.length < selection.total ? ` The first ${selection.layers.length} are listed.` : '';
      const text = `Selected in ${fileName}, page ${pageName}: ${count}.${partial}\n`
        + `${selection.layers.map((l, i) => describeLayer(file, l, i)).join('\n')}\n`
        + 'Pass a layer\'s link to get_section, get_screenshot, compare and the other tools. '
        + 'Before building, tell the owner which layer you will build, by name, in case the selection is not what they meant.';
      return { content: [{ type: 'text', text }] };
    },
  );
}
