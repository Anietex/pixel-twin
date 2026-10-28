/** Shared helpers for the read commands. They only read; they never change the file. */

export function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Missing ${what} in the request.`);
  return value;
}

export function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  return current as PageNode | null;
}

/** Finds a layer and loads its page, so its children can be read. */
export async function loadNode(api: PluginAPI, nodeId: string): Promise<BaseNode> {
  const node = await api.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Layer ${nodeId} not found in this file`);
  const page = pageOf(node);
  if (page) await page.loadAsync();
  return node;
}
