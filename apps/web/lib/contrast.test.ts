/**
 * Every colour pair this app paints, against WCAG AA, in both schemes, parsed
 * from the real stylesheet. Never from a copy of the palette: a table of hexes
 * in TypeScript would pass forever while the CSS said something else.
 *
 * The tenant's accent is not here: it is customer data, and lib/branding.test.ts
 * proves services/branding judges it against these very surfaces.
 */
import { describe, expect, it } from 'vitest';

import { AA_NORMAL, AA_UI, composite, greyscale, ratio, resolve } from './contrast';
import { SURFACES } from './identity.test';

const BACKGROUNDS = ['--bg', '--surface', '--surface-2'] as const;
/** Everything that is ever text: body, secondary, links, and the three status words. */
const TEXT_ON_BACKGROUNDS = [
  '--text',
  '--muted',
  '--accent',
  '--danger',
  '--ok',
  '--warn',
] as const;
const PAIRS = [
  ['--accent-ink', '--accent'], // primary button with the product colour
  ['--text', '--accent-soft'], // current-page marker, notices, the key reveal
  ['--danger', '--danger-soft'], // form errors
  ['--surface', '--text'], // the crosshair's time label (inverse)
] as const;

const schemes = Object.entries(SURFACES);

describe('text clears AA everywhere it is painted', () => {
  for (const [name, palette] of schemes) {
    for (const foreground of TEXT_ON_BACKGROUNDS) {
      for (const background of BACKGROUNDS) {
        it(`${name}: ${foreground} on ${background}`, () => {
          const value = ratio(resolve(palette, foreground), resolve(palette, background));
          expect(
            value,
            `${name} ${foreground} on ${background} is ${String(value)}:1`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
    for (const [foreground, background] of PAIRS) {
      it(`${name}: ${foreground} on ${background}`, () => {
        const value = ratio(resolve(palette, foreground), resolve(palette, background));
        expect(
          value,
          `${name} ${foreground} on ${background} is ${String(value)}:1`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }
});

describe('control edges, the focus ring, the crosshair and every chart mark clear 3:1', () => {
  const MARKS = [
    '--border',
    '--accent',
    '--crosshair',
    '--series-1',
    '--series-2',
    '--series-3',
    '--series-other',
  ] as const;
  for (const [name, palette] of schemes) {
    for (const mark of MARKS) {
      for (const background of BACKGROUNDS) {
        it(`${name}: ${mark} on ${background}`, () => {
          expect(
            ratio(resolve(palette, mark), resolve(palette, background)),
          ).toBeGreaterThanOrEqual(AA_UI);
        });
      }
    }
  }
});

describe('the area wash under a line stays a wash', () => {
  // 10% of the series over the lane surface: body-weight text and the
  // crosshair must still read on top of it.
  for (const [name, palette] of schemes) {
    it(`${name}: text and the crosshair over the series-1 wash`, () => {
      const wash = composite(resolve(palette, '--series-1'), resolve(palette, '--surface'), 0.1);
      expect(ratio(resolve(palette, '--text'), wash)).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(ratio(resolve(palette, '--crosshair'), wash)).toBeGreaterThanOrEqual(AA_UI);
    });
  }
});

describe('colour is never the only channel', () => {
  for (const [name, palette] of schemes) {
    it(`${name}: the status colours are close in greyscale, so status words carry a glyph`, () => {
      const [ok, warn, danger] = (['--ok', '--warn', '--danger'] as const).map((t) =>
        greyscale(resolve(palette, t)),
      );
      // All three sit under 1.6:1 from each other once colour is removed: a
      // reader who cannot see hue cannot tell them apart without the glyph.
      expect(ratio(ok!, warn!)).toBeLessThan(1.6);
      expect(ratio(ok!, danger!)).toBeLessThan(1.6);
    });
  }
});
