import { contrast, fromOklch, mix, toOklch } from './colour';

/**
 * A tenant's accent, gated and stepped.
 *
 * An admin picks one colour. It appears in two schemes on three backgrounds,
 * as the text of links and selected tabs, as a button fill under a label, and as
 * a soft tint under body text. Each of those is a WCAG pair, and a tenant colour
 * that fails any of them would ship an unreadable product to that tenant's whole
 * team. So:
 *
 * - LIGHT: the colour is used as chosen. It must clear 4.5:1 as text on all
 *   three light backgrounds; if it does not, it is refused, naming the pair.
 *   The button label (ink) is whichever of white or a dark ink reads better on
 *   it, and must also clear 4.5:1.
 * - DARK: the chosen colour is almost never readable on a near-black canvas, so
 *   a dark step is DERIVED: same hue, lightness raised in OKLCH until it clears
 *   4.5:1 on all three dark backgrounds, chroma reduced only if the colour would
 *   leave sRGB. Refused only when no lightness works.
 * - SOFT (both schemes): the accent at 14% over the surface, with body text on
 *   it at 4.5:1 or better.
 *
 * Only the lane rail, primary buttons, focus ring and selected tab wear it. Body
 * text never does, so even an accepted colour cannot reach a paragraph.
 */

export interface Surfaces {
  bg: string;
  surface: string;
  surface2: string;
  text: string;
}

/** The product's own backgrounds. apps/web's branding gate asserts these equal globals.css. */
export const LIGHT: Surfaces = {
  bg: '#d0d9db',
  surface: '#eef2f3',
  surface2: '#dfe5e7',
  text: '#10181a',
};
export const DARK: Surfaces = {
  bg: '#050a0b',
  surface: '#0d1517',
  surface2: '#152023',
  text: '#e8eef0',
};

export const AA_TEXT = 4.5;
const SOFT_ALPHA = 0.14;
const WHITE = '#ffffff';
/** The dark label for a light fill: the light scheme's text colour, in both schemes. */
const DARK_INK = '#10181a';

export interface Step {
  accent: string;
  ink: string;
  soft: string;
}

export type AccentResult = { ok: true; light: Step; dark: Step } | { ok: false; issues: string[] };

const round = (n: number): string => n.toFixed(2);

function stepFor(accent: string, s: Surfaces): Step {
  // White or a dark ink, whichever reads better ON the accent: a light accent
  // (every dark-scheme step) needs a dark label, whatever the scheme's text is.
  const ink = contrast(WHITE, accent) >= contrast(DARK_INK, accent) ? WHITE : DARK_INK;
  return { accent, ink, soft: mix(accent, s.surface, SOFT_ALPHA) };
}

/** Problems with `accent` as a step on `s`, in words; empty when it passes. */
export function stepIssues(step: Step, s: Surfaces, scheme: 'light' | 'dark'): string[] {
  const issues: string[] = [];
  for (const [name, bg] of [
    ['the page', s.bg],
    ['cards', s.surface],
    ['panels', s.surface2],
  ] as const) {
    const r = contrast(step.accent, bg);
    if (r < AA_TEXT)
      issues.push(
        `${scheme}: ${step.accent} on ${name} (${bg}) is ${round(r)}:1, needs ${String(AA_TEXT)}:1`,
      );
  }
  const inkRatio = contrast(step.ink, step.accent);
  if (inkRatio < AA_TEXT)
    issues.push(`${scheme}: button labels on ${step.accent} reach only ${round(inkRatio)}:1`);
  const softRatio = contrast(s.text, step.soft);
  if (softRatio < AA_TEXT)
    issues.push(`${scheme}: text on the ${step.soft} tint is ${round(softRatio)}:1`);
  return issues;
}

/** The lightest-needed dark step for `accent`, or null when none clears AA. */
export function deriveDark(accent: string): string | null {
  const { c, h } = toOklch(accent);
  for (let l = 0.5; l <= 0.97; l += 0.005) {
    let candidate: string | null = null;
    // Reduce chroma only as far as needed to stay inside sRGB.
    for (let cc = c; cc >= 0 && candidate === null; cc -= 0.01)
      candidate = fromOklch({ l, c: cc, h });
    if (candidate === null) continue;
    const step = stepFor(candidate, DARK);
    if (stepIssues(step, DARK, 'dark').length === 0) return candidate;
  }
  return null;
}

export function checkAccent(input: string): AccentResult {
  const accent = input.toLowerCase();
  if (!/^#[0-9a-f]{6}$/u.test(accent)) return { ok: false, issues: ['not a #rrggbb colour'] };

  const light = stepFor(accent, LIGHT);
  const issues = stepIssues(light, LIGHT, 'light');
  const darkAccent = deriveDark(accent);
  if (darkAccent === null)
    issues.push('dark: no lighter shade of this hue reaches 4.5:1 on the dark backgrounds');
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, light, dark: stepFor(darkAccent!, DARK) };
}

/**
 * The closest colour to `input` that passes: same hue and chroma, lightness
 * stepped down (darker reads better on the light backgrounds, which is where a
 * refused colour almost always fails) until checkAccent accepts it. Lets the
 * settings page answer a refusal with "try #1d5bd6" instead of a dead end.
 */
export function suggestAccent(input: string): string | null {
  const accent = input.toLowerCase();
  if (checkAccent(accent).ok) return accent;
  const { l, c, h } = toOklch(accent);
  for (let ll = l; ll >= 0.2; ll -= 0.005) {
    let candidate: string | null = null;
    for (let cc = c; cc >= 0 && candidate === null; cc -= 0.01)
      candidate = fromOklch({ l: ll, c: cc, h });
    // The light pairs are cheap and decide almost every candidate; the dark
    // derivation (a search of its own) runs only once those pass.
    if (
      candidate !== null &&
      stepIssues(stepFor(candidate, LIGHT), LIGHT, 'light').length === 0 &&
      checkAccent(candidate).ok
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * What a tenant's stored accent paints as TODAY, re-judged against the current
 * surfaces on every render.
 *
 * Stored branding was judged against the backgrounds of the day it was saved.
 * The product's own palette can change after that (it did, 2026-10-28: Harbor
 * Labs' #b4235a cleared 4.5:1 on the old mint page and reaches 4.40:1 on the
 * new console grey). Painting the stored steps as-is would silently break the
 * promise that a tenant accent can never cost contrast, so:
 *
 * - still passing: its steps, freshly derived (the dark step too);
 * - no longer passing: the nearest passing shade, the same suggestion the
 *   settings page offers, and the admin is told;
 * - nothing passes: the product's own accent.
 */
export type EffectiveBranding =
  | { kind: 'stored'; requested: string; light: Step; dark: Step }
  | { kind: 'adjusted'; requested: string; used: string; light: Step; dark: Step }
  | { kind: 'product'; requested: string };

export function effectiveBranding(requested: string): EffectiveBranding {
  // Stored data is read on every render; a malformed value must fall back, never throw.
  if (!/^#[0-9a-f]{6}$/iu.test(requested)) return { kind: 'product', requested };
  const now = checkAccent(requested);
  if (now.ok) return { kind: 'stored', requested, light: now.light, dark: now.dark };
  const used = suggestAccent(requested);
  if (used !== null) {
    const adjusted = checkAccent(used);
    if (adjusted.ok)
      return { kind: 'adjusted', requested, used, light: adjusted.light, dark: adjusted.dark };
  }
  return { kind: 'product', requested };
}

/** One pair an accent is painted in, measured: what the settings page draws as a table row. */
export interface PairRow {
  readonly where: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly pass: boolean;
}

/**
 * Every light-scheme pair `input` would be painted in, passing or not, plus
 * whether a dark-scheme shade exists. The same measurements `stepIssues`
 * words as sentences, as rows, so a refusal can show which surfaces fail and
 * by how much instead of one paragraph of hexes. Null for a malformed colour.
 */
export function accentReport(input: string): { rows: PairRow[]; darkShade: string | null } | null {
  const accent = input.toLowerCase();
  if (!/^#[0-9a-f]{6}$/u.test(accent)) return null;
  const step = stepFor(accent, LIGHT);
  const row = (where: string, foreground: string, background: string): PairRow => {
    // Judged on the exact ratio, shown rounded: 4.497 must fail like checkAccent says, not read as 4.50.
    const exact = contrast(foreground, background);
    return {
      where,
      foreground,
      background,
      ratio: Number(exact.toFixed(2)),
      pass: exact >= AA_TEXT,
    };
  };
  return {
    rows: [
      row('Text on the page', step.accent, LIGHT.bg),
      row('Text on cards', step.accent, LIGHT.surface),
      row('Text on panels', step.accent, LIGHT.surface2),
      row('Button label', step.ink, step.accent),
      row('Text on the tint', LIGHT.text, step.soft),
    ],
    darkShade: deriveDark(accent),
  };
}
