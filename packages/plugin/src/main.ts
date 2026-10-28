import type { Hello, PluginRequest, PluginResponse } from '@pixel-twin/shared';
import { PLUGIN_VERSION } from '@pixel-twin/shared';
import { handleRequest } from './router';

declare const __PIXEL_TWIN_SECRET__: string;

figma.showUI(__html__, { width: 240, height: 96, title: 'Pixel Twin' });

const hello: Hello = {
  type: 'hello',
  fileName: figma.root.name,
  fileKey: figma.fileKey ?? null,
  editorType: figma.editorType,
  pluginVersion: PLUGIN_VERSION,
  secret: __PIXEL_TWIN_SECRET__,
};
figma.ui.postMessage(hello);

figma.ui.onmessage = async (msg: PluginRequest | { type: 'ui-ready' }) => {
  // The window asks for the hello once it is listening, in case the first one arrived too early.
  if (msg?.type === 'ui-ready') {
    figma.ui.postMessage(hello);
    return;
  }
  if (!msg || msg.type !== 'request') return;
  let reply: PluginResponse;
  try {
    reply = { type: 'response', id: msg.id, ok: true, result: await handleRequest(figma, msg.method, msg.params) };
  } catch (err) {
    reply = { type: 'response', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  figma.ui.postMessage(reply);
};
