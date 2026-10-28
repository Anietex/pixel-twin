/**
 * Every warning `normalize` can give, with the property it is about and whether a browser can draw it.
 * - browserCanDraw true: the numbers can't confirm it, so the agent checks it by eye in the overlay image.
 * - browserCanDraw false: no browser can draw it exactly, so the agent stops and tells the owner (req 6.3).
 */
export interface WarningKind { reason: string; property: string; browserCanDraw: boolean }

export const WARNING = {
  noBox: { reason: 'Layer has no position or size in the Figma data, so its box is unknown', property: 'box', browserCanDraw: true },
  rotated: { reason: 'Layer is rotated; its box is the rotated outline', property: 'rotation', browserCanDraw: true },
  imageTransformed: { reason: 'Image is rotated/filtered in Figma, which Pixel Twin can\'t check', property: 'image', browserCanDraw: true },
  patternFill: { reason: 'Has a pattern fill, which Pixel Twin can\'t check', property: 'background', browserCanDraw: true },
  paintedBorder: { reason: 'Border uses a gradient or image, which Pixel Twin can\'t check', property: 'border', browserCanDraw: true },
  textColorNotSolid: {
    reason: 'Text colour is not a plain solid fill (gradient, image or no fill), so Pixel Twin used black', property: 'color', browserCanDraw: true,
  },
  diamondGradient: { reason: 'Has a diamond gradient, which browsers can\'t draw exactly', property: 'background', browserCanDraw: false },
  progressiveBlur: { reason: 'Has a progressive blur, which browsers can\'t draw exactly', property: 'filter', browserCanDraw: false },
  textureNoise: { reason: 'Has a texture/noise effect, which browsers can\'t draw exactly', property: 'effects', browserCanDraw: false },
} as const satisfies Record<string, WarningKind>;

const BY_REASON = new Map<string, WarningKind>(Object.values(WARNING).map((w) => [w.reason, w]));

/** Looks up a warning by its text. An unknown warning counts as something to check by eye. */
export function warningKind(reason: string): WarningKind {
  return BY_REASON.get(reason) ?? { reason, property: 'other', browserCanDraw: true };
}
