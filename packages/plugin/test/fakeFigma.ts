/** A frozen, read-only stand-in for the Figma plugin API. Any write throws. */
export interface Spec {
  id: string;
  name: string;
  type: string;
  x?: number; y?: number; width?: number; height?: number; visible?: boolean;
  characters?: string;
  hasMissingFont?: boolean;
  segments?: { fontName: { family: string; style: string }; fontWeight: number; textStyleId?: string }[];
  rotation?: number;
  fillStyleId?: string; strokeStyleId?: string; effectStyleId?: string;
  /** 'MIXED' stands for figma.mixed. */
  textStyleId?: string;
  boundVariables?: Record<string, unknown>;
  // Motion
  reactions?: unknown[];
  overflowDirection?: string;
  numberOfFixedChildren?: number;
  fills?: unknown[];
  variantProperties?: Record<string, string> | null;
  /** The id of the main component that getMainComponentAsync returns. */
  mainComponentId?: string;
  /** What getStyledTextSegments returns when asked for 'hyperlink'. */
  linkSegments?: { start: number; end: number; characters: string; hyperlink: { type: 'URL' | 'NODE'; value: string } | null }[];
  animationStyles?: unknown[];
  animations?: Record<string, unknown>;
  children?: Spec[];
}
export interface VariableSpec { id: string; name: string; collectionId: string; value: unknown }
export interface FakeTree {
  pages: Spec[];
  /** Page ids that start out loaded. All others throw 'Page not loaded' when children are read. */
  loadedPages?: string[];
  variables?: VariableSpec[];
  collections?: { id: string; name: string }[];
  images?: Record<string, number[]>;
  styles?: { id: string; name: string }[];
  /** The page the owner is on. Default: the first page. */
  currentPage?: string;
  /** The selected layer ids on each page. */
  selections?: Record<string, string[]>;
}

const MIXED = Symbol('mixed');

function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key)!;
    if ('value' in desc) deepFreeze(desc.value, seen);
  }
  return Object.freeze(value);
}

export function makeFakeFigma(tree: FakeTree) {
  const exportCalls: unknown[] = [];
  const loadCalls: string[] = [];
  const loaded = new Set(tree.loadedPages ?? []);
  const byId = new Map<string, any>();

  function build(spec: Spec, parent: any, pageId: string | null): any {
    const { children, segments, boundVariables, mainComponentId, linkSegments, ...plain } = spec;
    const node: any = { ...plain, parent };
    if (spec.textStyleId === 'MIXED') node.textStyleId = MIXED;
    if (boundVariables) node.boundVariables = boundVariables;
    const thisPage = spec.type === 'PAGE' ? spec.id : pageId;
    byId.set(spec.id, node);
    const kids: any[] = [];
    if (children) {
      Object.defineProperty(node, 'children', {
        enumerable: true,
        get() {
          if (thisPage && !loaded.has(thisPage)) throw new Error('Page not loaded');
          return kids;
        },
      });
      for (const c of children) kids.push(build(c, node, thisPage));
    }
    if (spec.type === 'PAGE') {
      node.loadAsync = async () => { loadCalls.push(spec.id); loaded.add(spec.id); };
      Object.defineProperty(node, 'selection', {
        enumerable: true,
        get: () => (tree.selections?.[spec.id] ?? []).map((id) => byId.get(id)),
      });
    }
    if (children) {
      node.findAllWithCriteria = ({ types }: { types: string[] }) => {
        const out: any[] = [];
        const walk = (n: any) => { for (const k of n.children ?? []) { if (types.includes(k.type)) out.push(k); walk(k); } };
        walk(node);
        return out;
      };
    }
    node.exportAsync = async (args: unknown) => {
      exportCalls.push(args);
      const fmt = (args as { format: string }).format;
      if (fmt === 'PNG' || fmt === 'JPG') return new Uint8Array([1, 2, 3]);
      if (fmt === 'SVG_STRING') return `<svg id="${spec.id}"/>`;
      return { document: { id: spec.id, name: spec.name } };
    };
    if (segments || linkSegments) {
      node.getStyledTextSegments = (fields: string[]) =>
        (fields.includes('hyperlink') ? linkSegments ?? [] : segments ?? []).map((s) => ({ ...s }));
    }
    if (mainComponentId) node.getMainComponentAsync = async () => byId.get(mainComponentId) ?? null;
    // The children getter hides the array from deepFreeze, so freeze both here.
    Object.freeze(kids);
    return Object.freeze(node);
  }

  const pages: any[] = [];
  const root: any = { id: '0:0', name: 'Demo file', type: 'DOCUMENT', children: pages };
  for (const p of tree.pages) pages.push(build(p, root, null));
  Object.freeze(pages);

  const variables = new Map((tree.variables ?? []).map((v) => [v.id, v]));
  const collections = new Map((tree.collections ?? []).map((c) => [c.id, c]));
  const images = tree.images ?? {};

  const styles = new Map((tree.styles ?? []).map((st) => [st.id, st]));
  const api: any = {
    root,
    currentPage: pages.find((p) => p.id === (tree.currentPage ?? tree.pages[0]?.id)) ?? null,
    mixed: MIXED,
    getStyleByIdAsync: async (id: string) => styles.get(id) ?? null,
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    getImageByHash: (hash: string) =>
      images[hash] ? { hash, getBytesAsync: async () => new Uint8Array(images[hash]) } : null,
    variables: {
      getVariableByIdAsync: async (id: string) => {
        const v = variables.get(id);
        return v ? { id: v.id, name: v.name, variableCollectionId: v.collectionId, resolveForConsumer: () => ({ value: v.value }) } : null;
      },
      getVariableCollectionByIdAsync: async (id: string) => collections.get(id) ?? null,
    },
  };
  // The page list is made of the same objects, so freeze everything reachable.
  deepFreeze(api);
  return { api: api as PluginAPI, exportCalls, loadCalls };
}
