import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../createServer';
import { loadSettings, SETTINGS_FILE } from '../settings';
import { toolError } from './common';
import { selectionLine } from './selection';

export function registerStatus(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'status',
    {
      description: 'Lists the Figma files that have Pixel Twin running, what is selected in each, and the project settings from pixel-twin.json. Call this first to check the connection.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (deps.bridgeError) return toolError(deps.bridgeError.message);
      let settingsNote: string;
      try {
        const settings = await loadSettings(deps.workDir);
        settingsNote = Object.keys(settings).length === 0
          ? `\nNo project settings yet: write ${SETTINGS_FILE} in the project folder (see the skill).`
          : `\nProject settings (${SETTINGS_FILE}): ${JSON.stringify(settings)}`;
      } catch (err) {
        settingsNote = `\n${err instanceof Error ? err.message : String(err)}`;
      }
      const files = deps.bridge.files();
      const silent = deps.bridge.unintroduced();
      const silentNote = silent === 0 ? '' : `\n${silent} Pixel Twin ${silent === 1 ? 'window is' : 'windows are'} connected but `
        + 'never said which file ' + (silent === 1 ? 'it is in' : 'they are in')
        + '. Close the Pixel Twin window in Figma and run Plugins → Development → Pixel Twin again.';
      if (files.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No Figma file has Pixel Twin running. Open a file in the Figma desktop app, then run Plugins → Development → Pixel Twin.'
              + silentNote + settingsNote,
          }],
        };
      }
      const selections = await Promise.all(files.map((f) => selectionLine(deps, f)));
      const lines = files.map((f, i) => `- "${f.fileName}" (file key: ${f.fileKey ?? 'not available'}, ${f.editorType}): ${selections[i].text}`);
      const selectedNote = selections.some((s) => s.selected) ? '\nCall get_selection for a link to each selected layer.' : '';
      const sharedNote = deps.bridge.role?.() === 'shared' ? '\nThis session shares the Figma connection of another Pixel Twin session.' : '';
      return { content: [{ type: 'text', text: `Figma files with Pixel Twin running:\n${lines.join('\n')}${selectedNote}${silentNote}${sharedNote}${settingsNote}` }] };
    },
  );
}
