import type { Interaction, KeyframeTrack, LayerMotion, MotionEasing, PluginMethods, Variant } from '@pixel-twin/shared';
import { loadNode, requireString } from './loadNode';

const OVERFLOW = { HORIZONTAL: 'HORIZONTAL', VERTICAL: 'VERTICAL', BOTH: 'BOTH' } as const;

/** Figma's easing as plain data, with the numbers of a custom curve or spring. */
function easingOf(e: Easing | MotionEasing | undefined | null): MotionEasing {
  const easing = (e ?? { type: 'LINEAR' }) as Easing & { easingFunctionSpring?: Partial<EasingFunctionSpring & NormalizedSpring> };
  const out: MotionEasing = { type: easing.type };
  const b = easing.easingFunctionCubicBezier;
  if (b) out.bezier = [b.x1, b.y1, b.x2, b.y2];
  const sp = easing.easingFunctionSpring;
  if (sp) out.spring = { ...sp };
  return out;
}

/** Turns a layer's prototype reactions into plain interactions. Names of destination layers are looked up once each. */
async function interactionsOf(api: PluginAPI, reactions: ReadonlyArray<Reaction>, names: Map<string, string | null>): Promise<Interaction[]> {
  const nameOf = async (id: string): Promise<string | null> => {
    if (!names.has(id)) names.set(id, (await api.getNodeByIdAsync(id))?.name ?? null);
    return names.get(id) ?? null;
  };
  const out: Interaction[] = [];
  for (const reaction of reactions) {
    const trigger = reaction.trigger;
    if (!trigger) continue;
    const actions = reaction.actions ?? (reaction.action ? [reaction.action] : []);
    for (const action of actions) {
      const item: Interaction = { trigger: trigger.type, action: action.type };
      if (trigger.type === 'AFTER_TIMEOUT') item.delayMs = Math.round(trigger.timeout * 1000);
      else if ('delay' in trigger && trigger.delay > 0) item.delayMs = Math.round(trigger.delay * 1000);
      if (action.type === 'URL') item.url = action.url;
      if (action.type === 'NODE') {
        item.action = String(action.navigation);   // a DOM type shares the name Navigation, so make it a plain string
        if (action.destinationId) {
          item.destinationId = action.destinationId;
          const name = await nameOf(action.destinationId);
          if (name !== null) item.destinationName = name;
        }
        const t = action.transition;
        if (t) {
          item.transition = { type: t.type, durationMs: Math.round(t.duration * 1000), easing: easingOf(t.easing) };
          if ('direction' in t) item.transition.direction = t.direction;
        }
      }
      out.push(item);
    }
  }
  return out;
}

/**
 * For an instance of a component in a component set: the set's variants and the instance's own choice.
 * `cache` holds the answer per main component, so many instances of one component are read once.
 */
async function statesOf(api: PluginAPI, node: InstanceNode, names: Map<string, string | null>,
  cache: Map<string, LayerMotion['states']>): Promise<LayerMotion['states']> {
  const main = await node.getMainComponentAsync();
  if (main && cache.has(main.id)) return cache.get(main.id);
  const set = main?.parent;
  if (!main || !set || set.type !== 'COMPONENT_SET') {
    if (main) cache.set(main.id, undefined);
    return undefined;
  }
  const variants: Variant[] = [];
  for (const child of set.children) {
    if (child.type !== 'COMPONENT') continue;
    variants.push({ id: child.id, name: child.name, properties: { ...(child.variantProperties ?? {}) },
      interactions: await interactionsOf(api, child.reactions ?? [], names) });
  }
  const states = { setId: set.id, setName: set.name, current: { ...(main.variantProperties ?? {}) }, variants };
  cache.set(main.id, states);
  return states;
}

/** Linked text: each run of characters that links to a web address or to a frame. */
function linksOf(node: TextNode): LayerMotion['links'] {
  const out: NonNullable<LayerMotion['links']> = [];
  for (const seg of node.getStyledTextSegments(['hyperlink'])) {
    const target = seg.hyperlink;
    if (!target) continue;
    out.push({ start: seg.start, end: seg.end, text: seg.characters,
      ...(target.type === 'URL' ? { url: target.value } : { nodeId: target.value }) });
  }
  return out;
}

const KEYFRAME_VALUE = (v: KeyframeValue | undefined): unknown => (v ? v.value : null);

/** Figma Motion (beta): animation styles and keyframe tracks. Missing on Figma versions without Motion. */
function animationsOf(node: SceneNode): LayerMotion['animations'] {
  const n = node as SceneNode & Partial<MotionNodeMixin>;
  let styles: ReadonlyArray<AppliedAnimationStyle> = [];
  let animations: Animations = {};
  try {
    styles = n.animationStyles ?? [];
    animations = n.animations ?? {};
  } catch {
    return undefined;   // this Figma version, or this layer type, has no Motion
  }
  const tracks: KeyframeTrack[] = [];
  for (const [property, binding] of Object.entries(animations)) {
    const b = binding as KeyframeBinding | undefined;
    if (!b || !Array.isArray(b.tracks)) continue;   // fills, strokes and effects hold nested tracks: listed by name only
    for (const track of b.tracks) {
      tracks.push({ property, durationMs: Math.round(b.timelineDuration * 1000),
        keyframes: track.keyframes.map((k: ManualKeyframe) => ({ atMs: Math.round(k.timelinePosition * 1000), value: KEYFRAME_VALUE(k.value),
          ...('type' in (k.easing ?? {}) ? { easing: easingOf(k.easing as MotionEasing) } : {}) })) });
    }
  }
  for (const key of ['fills', 'strokes', 'effects'] as const) {
    if (animations[key]) tracks.push({ property: key, durationMs: 0, keyframes: [] });
  }
  if (styles.length === 0 && tracks.length === 0) return undefined;
  return {
    styles: styles.map((st) => ({
      name: st.name, type: st.type,
      ...('duration' in st && st.duration !== undefined ? { durationMs: Math.round(st.duration * 1000) } : {}),
      ...(st.timelineOffset !== undefined ? { offsetMs: Math.round(st.timelineOffset * 1000) } : {}),
      ...('props' in st && st.props ? { props: { ...st.props } } : {}),
    })),
    tracks,
  };
}

/**
 * The motion the designer set on every layer in the subtree: prototype interactions, component states,
 * scrolling, video fills, text links and Figma Motion keyframes. Only layers with at least one are listed.
 */
export async function getMotion(api: PluginAPI, params: PluginMethods['getMotion']['params']): Promise<LayerMotion[]> {
  const node = await loadNode(api, requireString(params.nodeId, 'layer id'));
  const names = new Map<string, string | null>();
  const statesCache = new Map<string, LayerMotion['states']>();
  const fixedIds = new Set<string>();
  const out: LayerMotion[] = [];
  const visit = async (n: SceneNode): Promise<void> => {
    const m: LayerMotion = { id: n.id };
    if ('reactions' in n && n.reactions.length > 0) {
      const list = await interactionsOf(api, n.reactions, names);
      if (list.length > 0) m.interactions = list;
    }
    if (n.type === 'INSTANCE') {
      const states = await statesOf(api, n, names, statesCache);
      if (states) m.states = states;
    }
    if ('overflowDirection' in n && n.overflowDirection !== 'NONE') m.overflow = OVERFLOW[n.overflowDirection];
    // Fixed children sit on top of the scrolling ones, so they are the last ones in the list.
    if ('numberOfFixedChildren' in n && n.numberOfFixedChildren > 0) {
      for (const c of n.children.slice(-n.numberOfFixedChildren)) fixedIds.add(c.id);
    }
    if (fixedIds.has(n.id)) m.fixed = true;
    if ('fills' in n && Array.isArray(n.fills)) {
      const videos = (n.fills as Paint[]).filter((p): p is VideoPaint => p.type === 'VIDEO' && p.visible !== false);
      if (videos.length > 0) m.media = videos.map((v) => ({ kind: 'video' as const, hash: v.videoHash }));
    }
    if (n.type === 'TEXT') {
      const links = linksOf(n);
      if (links && links.length > 0) m.links = links;
    }
    const animations = animationsOf(n);
    if (animations) m.animations = animations;
    if (Object.keys(m).length > 1) out.push(m);
    if ('children' in n) for (const child of n.children) await visit(child);
  };
  if (node.type === 'PAGE') for (const child of node.children) await visit(child);
  else if (node.type !== 'DOCUMENT') await visit(node as SceneNode);
  return out;
}
