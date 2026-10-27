/**
 * Colour maths: WCAG 2.1 contrast, and OKLCH for deriving steps that keep a hue.
 * Pure functions; every number they produce is pinned by a test.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const linear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const gamma = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export function toOklch(hex: string): Oklch {
  const { r, g, b } = parseHex(hex);
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

/** OKLCH back to hex, or null when the colour is outside sRGB. */
export function fromOklch({ l, c, h }: Oklch): string | null {
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l3 = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m3 = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s3 = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  if (rgb.some((v) => v < -1e-4 || v > 1 + 1e-4)) return null;
  const [r, g, b] = rgb.map((v) => gamma(Math.min(1, Math.max(0, v))) * 255) as [
    number,
    number,
    number,
  ];
  return toHex({ r, g, b });
}

/** `top` at `alpha` over `bottom`, composited to an opaque 8-bit colour. */
export function mix(top: string, bottom: string, alpha: number): string {
  const t = parseHex(top);
  const b = parseHex(bottom);
  return toHex({
    r: t.r * alpha + b.r * (1 - alpha),
    g: t.g * alpha + b.g * (1 - alpha),
    b: t.b * alpha + b.b * (1 - alpha),
  });
}
