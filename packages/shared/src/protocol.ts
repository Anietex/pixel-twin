export type Hello = { type: 'hello'; fileName: string; fileKey: string | null; editorType: string; pluginVersion: string; secret: string };
/** The server's answer to a valid hello. The plugin shows "Connected" only after it arrives. */
export type Welcome = { type: 'welcome'; fileName: string };
export type PluginRequest = { type: 'request'; id: string; method: PluginMethod; params: unknown };
export type PluginResponse =
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: string };

export interface OutlineNode { id: string; name: string; type: string; x: number; y: number; width: number; height: number; visible: boolean; childCount: number; children?: OutlineNode[] }
/** A selected layer, with the names of the layers above it on its page (top first, the page left out). */
export interface SelectedLayer extends OutlineNode { path: string[] }
/** What the owner has selected on the page they are on: `total` layers, of which up to 50 are described. */
export interface FigmaSelection { pageId: string; pageName: string; total: number; layers: SelectedLayer[] }
export interface TextDetail { id: string; hasMissingFont: boolean; fonts: { family: string; style: string; weight: number }[] }
export interface FrameSections { frameId: string; frameName: string; frameWidth: number; sections: { id: string; name: string; texts: string[] }[] }
/** A rotated or styled layer: its angle and size before rotating, and the names of its linked styles. */
export interface LayerExtra {
  id: string; rotation: number; width: number; height: number;
  styles: { kind: 'fill' | 'stroke' | 'effect' | 'grid' | 'text'; id: string; name: string }[];
}
/**
 * Figma's easing for a transition or keyframe. `type` is Figma's name (EASE_OUT, CUSTOM_CUBIC_BEZIER,
 * GENTLE, CUSTOM_SPRING and so on). A custom curve carries its numbers.
 */
export interface MotionEasing {
  type: string;
  bezier?: [number, number, number, number];
  spring?: { mass?: number; stiffness?: number; damping?: number; initialVelocity?: number; bounce?: number };
}
/** One prototype interaction on a layer, as the designer set it. Times are in ms. */
export interface Interaction {
  trigger: string;        // ON_CLICK, ON_HOVER, ON_PRESS, ON_DRAG, AFTER_TIMEOUT, MOUSE_ENTER, MOUSE_LEAVE, MOUSE_UP, MOUSE_DOWN, ON_KEY_DOWN, ...
  delayMs?: number;       // the wait before it starts (AFTER_TIMEOUT and the MOUSE_ triggers)
  action: string;         // NAVIGATE, SWAP, OVERLAY, SCROLL_TO, CHANGE_TO, BACK, CLOSE, URL, SET_VARIABLE, ...
  destinationId?: string;
  destinationName?: string;
  url?: string;
  transition?: { type: string; direction?: string; durationMs: number; easing: MotionEasing };
}
/** One variant of a component set, such as State=Hover. */
export interface Variant { id: string; name: string; properties: Record<string, string>; interactions: Interaction[] }
/** A Figma Motion keyframe track on one property. */
export interface KeyframeTrack { property: string; durationMs: number; keyframes: { atMs: number; value: unknown; easing?: MotionEasing }[] }
/**
 * The motion facts of one layer. Only layers with at least one fact are listed.
 * - states: for a component instance, the variants of its component set.
 * - overflow: the frame scrolls inside itself in this direction.
 * - fixed: the layer stays put while its scrolling parent scrolls.
 * - media: video fills.
 * - links: linked text, with character positions.
 * - animations: Figma Motion animation styles and keyframe tracks.
 */
export interface LayerMotion {
  id: string;
  interactions?: Interaction[];
  states?: { setId: string; setName: string; current: Record<string, string>; variants: Variant[] };
  overflow?: 'HORIZONTAL' | 'VERTICAL' | 'BOTH';
  fixed?: boolean;
  media?: { kind: 'video'; hash: string | null }[];
  links?: { start: number; end: number; text: string; url?: string; nodeId?: string }[];
  animations?: { styles: { name: string; type: string; durationMs?: number; offsetMs?: number; props?: Record<string, unknown> }[]; tracks: KeyframeTrack[] };
}
export interface ResolvedVariable { nodeId: string; property: string; variableName: string; collectionName: string; value: unknown }

export interface PluginMethods {
  hasNode:          { params: { nodeId: string }; result: { exists: boolean; pageId: string | null } };
  getOutline:       { params: { nodeId: string | null; depth: number }; result: OutlineNode[] };
  getNodeJson:      { params: { nodeId: string }; result: { document: unknown } };
  getTextDetails:   { params: { nodeId: string }; result: TextDetail[] };
  listSections:     { params: { pageId: string }; result: FrameSections[] };
  exportNode:       { params: { nodeId: string; format: 'PNG' | 'JPG' | 'SVG'; scale: number }; result: { base64?: string; svg?: string } };
  getImageBytes:    { params: { imageHash: string }; result: { base64: string } };
  resolveVariables: { params: { nodeId: string }; result: ResolvedVariable[] };
  getLayerExtras:   { params: { nodeId: string }; result: LayerExtra[] };
  getMotion:        { params: { nodeId: string }; result: LayerMotion[] };
  getSelection:     { params: Record<string, never>; result: FigmaSelection };
}
export type PluginMethod = keyof PluginMethods;
