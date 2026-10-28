import type { Interaction, LayerMotion, MotionEasing } from '@pixel-twin/shared';
import type { Layer, Motion } from './types';

/** Figma's preset curves as CSS cubic-bezier numbers, the same numbers Figma's own CSS export writes. */
export const FIGMA_BEZIER: Record<string, [number, number, number, number]> = {
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};

/**
 * Figma's spring presets as mass, stiffness and damping.
 * ASSUMPTION: Figma does not publish these numbers. They are the values its prototype panel shows; confirm
 * by looking at a recording (the record tool) next to the Figma prototype.
 */
export const FIGMA_SPRINGS: Record<string, { mass: number; stiffness: number; damping: number }> = {
  GENTLE: { mass: 1, stiffness: 100, damping: 15 },
  QUICK: { mass: 1, stiffness: 300, damping: 20 },
  BOUNCY: { mass: 1, stiffness: 600, damping: 15 },
  SLOW: { mass: 1, stiffness: 80, damping: 20 },
};

/** Points in a spring's CSS linear() curve. */
const SPRING_POINTS = 40;

/** A spring's movement from 0 to 1, sampled into a CSS linear() curve, and how long it takes to settle (ms). */
export function springCurve(s: { mass?: number; stiffness?: number; damping?: number; initialVelocity?: number }): { css: string; settleMs: number } {
  const mass = s.mass ?? 1;
  const stiffness = s.stiffness ?? 100;
  const damping = s.damping ?? 10;
  // Distance left to go (y) and its speed (v), stepped 1 ms at a time until it rests within 0.1 %.
  let y = 1;
  let v = -(s.initialVelocity ?? 0);
  const values: number[] = [0];
  let still = 0;
  let t = 0;
  for (; t < 5000 && still < 50; t++) {
    const a = (-stiffness * y - damping * v) / mass;
    v += a / 1000;
    y += v / 1000;
    values.push(1 - y);
    still = Math.abs(y) < 0.001 && Math.abs(v) < 0.01 ? still + 1 : 0;
  }
  const settleMs = Math.max(1, t - still);
  const points = Array.from({ length: SPRING_POINTS + 1 }, (_, i) => values[Math.round((i / SPRING_POINTS) * settleMs)] ?? 1);
  points[SPRING_POINTS] = 1;
  return { css: `linear(${points.map((p) => Math.round(p * 1000) / 1000).join(', ')})`, settleMs };
}

/**
 * The CSS timing function for a Figma easing: linear, a cubic-bezier, or for a spring a linear() curve.
 * Returns null for an easing CSS can't copy (a spring set only by its bounce, from Figma Motion).
 */
export function easingCss(e: MotionEasing): string | null {
  if (e.type === 'LINEAR') return 'linear';
  if (e.type === 'HOLD') return 'steps(1, end)';
  const b = e.bezier ?? FIGMA_BEZIER[e.type];
  if (b) return `cubic-bezier(${b.join(', ')})`;
  const spring = e.spring && e.spring.stiffness !== undefined ? e.spring : FIGMA_SPRINGS[e.type];
  return spring ? springCurve(spring).css : null;
}

const TRIGGER: Record<string, string> = {
  ON_CLICK: 'on click', ON_HOVER: 'while hovering', ON_PRESS: 'while pressing', ON_DRAG: 'on drag',
  MOUSE_ENTER: 'on mouse enter', MOUSE_LEAVE: 'on mouse leave', MOUSE_UP: 'on mouse up', MOUSE_DOWN: 'on mouse down',
  ON_KEY_DOWN: 'on key press', ON_MEDIA_HIT: 'at a video time', ON_MEDIA_END: 'when the video ends',
};
const ACTION: Record<string, string> = {
  NAVIGATE: 'go to', SWAP: 'swap with', OVERLAY: 'open overlay', SCROLL_TO: 'scroll to', CHANGE_TO: 'change to',
  BACK: 'go back', CLOSE: 'close overlay', URL: 'open link', SET_VARIABLE: 'set a variable', SET_VARIABLE_MODE: 'set a variable mode',
  CONDITIONAL: 'if/else', UPDATE_MEDIA_RUNTIME: 'control video',
};

/** One interaction in words, with the CSS timing function for its easing. */
export function describeInteraction(i: Interaction): string {
  const when = i.trigger === 'AFTER_TIMEOUT' ? `after ${i.delayMs ?? 0} ms` : `${TRIGGER[i.trigger] ?? i.trigger.toLowerCase()}${i.delayMs ? ` (after ${i.delayMs} ms)` : ''}`;
  const where = i.destinationId ? ` ${JSON.stringify(i.destinationName ?? '')} (${i.destinationId})` : i.url ? ` ${JSON.stringify(i.url)}` : '';
  const out = [`${when} → ${ACTION[i.action] ?? i.action.toLowerCase()}${where}`];
  const t = i.transition;
  if (t) {
    const css = easingCss(t.easing);
    const curve = `${t.easing.type.toLowerCase().replace(/_/g, '-')}${css && css !== 'linear' ? ` = ${css}` : ''}`;
    out.push(`${t.type.toLowerCase().replace(/_/g, ' ')}${t.direction ? ` from ${t.direction.toLowerCase()}` : ''} ${t.durationMs} ms, ${curve}`);
  }
  return out.join(', ');
}

/** Puts the motion the plugin read on each visible layer, next to the scrolling and GIFs from the export. */
export function applyMotion(root: Layer, motions: LayerMotion[]): void {
  const byId = new Map(motions.map((m) => [m.id, m]));
  const visit = (layer: Layer): void => {
    const m = byId.get(layer.id);
    if (m) {
      const merged: Motion = { ...layer.motion };
      if (m.interactions) merged.interactions = m.interactions;
      if (m.states) merged.states = m.states;
      if (m.overflow) merged.overflow = m.overflow;
      if (m.fixed && merged.scroll !== 'sticky') merged.scroll = 'fixed';
      if (m.media) merged.media = [...(merged.media ?? []), ...m.media.map((v) => ({ kind: v.kind, ref: v.hash }))];
      if (m.links) merged.links = m.links;
      if (m.animations) merged.animations = m.animations;
      if (Object.keys(merged).length > 0) layer.motion = merged;
    }
    layer.children.forEach(visit);
  };
  visit(root);
}
