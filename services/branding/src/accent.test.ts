/**
 * Expected colours were produced by running these functions and pasted; the
 * property tests re-derive every ratio independently of the code under test.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, checkAccent, DARK, LIGHT, suggestAccent } from './accent';
import { contrast } from './colour';

describe('checkAccent', () => {
  it("accepts the product's own plum and derives its dark step", () => {
    expect(checkAccent('#5A4590')).toEqual({
      ok: true,
      light: { accent: '#5a4590', ink: '#ffffff', soft: '#e2e4ed' },
      dark: { accent: '#9581d2', ink: '#0c2621', soft: '#1b2d30' },
    });
  });

  it('refuses a colour that fails on one background, naming that pair and its ratio', () => {
    expect(checkAccent('#2563eb')).toEqual({
      ok: false,
      issues: ['light: #2563eb on panels (#cdeee6) is 4.18:1, needs 4.5:1'],
    });
  });

  it('refuses yellow on every light background', () => {
    const result = checkAccent('#ffd400');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(3);
  });

  it('refuses anything that is not #rrggbb', () => {
    expect(checkAccent('red')).toEqual({ ok: false, issues: ['not a #rrggbb colour'] });
  });
});

describe('suggestAccent', () => {
  it.each([
    ['#2563eb', '#1f5ce4'],
    ['#e11d48', '#cd0c3e'],
    ['#ffd400', '#7b660f'],
    ['#5a4590', '#5a4590'],
  ])('%s -> %s', (input, expected) => {
    expect(suggestAccent(input)).toBe(expected);
  });
});

const hex = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, '0')}`);

describe('properties over random colours', () => {
  it('an accepted accent clears every pair it will be painted in, in both schemes', () => {
    let accepted = 0;
    fc.assert(
      fc.property(hex, (colour) => {
        const r = checkAccent(colour);
        if (!r.ok) return;
        accepted += 1;
        for (const [step, s] of [
          [r.light, LIGHT],
          [r.dark, DARK],
        ] as const) {
          for (const bg of [s.bg, s.surface, s.surface2])
            expect(contrast(step.accent, bg)).toBeGreaterThanOrEqual(AA_TEXT);
          expect(contrast(step.ink, step.accent)).toBeGreaterThanOrEqual(AA_TEXT);
          expect(contrast(s.text, step.soft)).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }),
      { seed: 10, numRuns: 1000 },
    );
    // Not vacuous: a real share of random colours is accepted.
    expect(accepted).toBeGreaterThan(100);
  });

  it('every suggestion is itself accepted', () => {
    fc.assert(
      fc.property(hex, (colour) => {
        const s = suggestAccent(colour);
        if (s !== null) expect(checkAccent(s).ok).toBe(true);
      }),
      { seed: 11, numRuns: 100 },
    );
  });
});
