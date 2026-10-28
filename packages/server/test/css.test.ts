import { parseColor } from '../src/compare/css';

const near = (got: { r: number; g: number; b: number; a: number } | null, want: [number, number, number, number]) => {
  expect(got).not.toBeNull();
  [got!.r, got!.g, got!.b].forEach((c, i) => expect(Math.abs(c - want[i])).toBeLessThanOrEqual(1));
  expect(got!.a).toBeCloseTo(want[3], 5);
};

test('rgb() and rgba() in comma and space form', () => {
  expect(parseColor('rgb(34, 85, 255)')).toEqual({ r: 34, g: 85, b: 255, a: 1 });
  expect(parseColor('rgba(0, 0, 0, 0.25)')).toEqual({ r: 0, g: 0, b: 0, a: 0.25 });
  expect(parseColor('rgb(34 85 255 / 50%)')).toEqual({ r: 34, g: 85, b: 255, a: 0.5 });
  expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  expect(parseColor('hsl(0 100% 50%)')).toBeNull();
});

test('oklch() and oklab() turn into sRGB within rounding', () => {
  near(parseColor('oklch(0.627955 0.257683 29.233885)'), [255, 0, 0, 1]);
  near(parseColor('oklch(53.8184% 0.255833 265.027028deg / 0.5)'), [0x22, 0x55, 0xff, 0.5]);
  near(parseColor('oklab(0.538184 -0.022177 -0.25487)'), [0x22, 0x55, 0xff, 1]);
  near(parseColor('oklab(1 0 0 / 25%)'), [255, 255, 255, 0.25]);
  near(parseColor('oklch(0 0 none)'), [0, 0, 0, 1]);
});

test('colours outside sRGB are clamped to 0..255', () => {
  const c = parseColor('oklch(0.7 0.4 150)')!;
  for (const v of [c.r, c.g, c.b]) expect(v >= 0 && v <= 255 && Number.isInteger(v)).toBe(true);
});

test('color(srgb ...) with an optional alpha', () => {
  expect(parseColor('color(srgb 1 0 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  expect(parseColor('color(srgb 0.5 0.5 0.5 / 0.5)')).toEqual({ r: 128, g: 128, b: 128, a: 0.5 });
  expect(parseColor('color(display-p3 1 0 0)')).toBeNull();
});
