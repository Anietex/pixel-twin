import type { PluginMethods, ResolvedVariable } from '@pixel-twin/shared';
import { loadNode, requireString } from './loadNode';

function isAlias(v: unknown): v is VariableAlias {
  return typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string';
}

async function collect(api: PluginAPI, node: SceneNode, out: ResolvedVariable[]): Promise<void> {
  const bound = ('boundVariables' in node ? node.boundVariables : undefined) as Record<string, unknown> | undefined;
  for (const [prop, value] of Object.entries(bound ?? {})) {
    const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [`${prop}[${i}]`, v]) : [[prop, value]];
    for (const [property, alias] of entries) {
      if (!isAlias(alias)) continue;
      const variable = await api.variables.getVariableByIdAsync(alias.id);
      if (!variable) continue;
      const collection = await api.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      out.push({
        nodeId: node.id,
        property,
        variableName: variable.name,
        collectionName: collection ? collection.name : '',
        value: variable.resolveForConsumer(node).value,
      });
    }
  }
  if ('children' in node) for (const child of node.children) await collect(api, child, out);
}

export async function resolveVariables(api: PluginAPI, params: PluginMethods['resolveVariables']['params']): Promise<ResolvedVariable[]> {
  const node = await loadNode(api, requireString(params.nodeId, 'layer id'));
  const out: ResolvedVariable[] = [];
  if (node.type === 'PAGE') for (const child of node.children) await collect(api, child, out);
  else if (node.type !== 'DOCUMENT') await collect(api, node as SceneNode, out);
  return out;
}
