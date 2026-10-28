/**
 * Expected colours were produced by running these functions and pasted; the
 * property tests re-derive every ratio independently of the code under test.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AA_TEXT,
  accentReport,
  checkAccent,
  DARK,
  effectiveBranding,
  LIGHT,
  suggestAccent,
} from './accent';
import { contrast } from './colour';

describe('checkAccent', () => {
  it("accepts the product's own orchid and derives its dark step", () => {
    expect(checkAccent('#86269B')).toEqual({
      ok: true,
      light: { accent: '#86269b', ink: '#ffffff', soft: '#dfd5e7' },
      dark: { accent: '#be60d4', ink: '#10181a', soft: '#262031' },
    });
  });

  it('refuses a colour that fails on one background, naming that pair and its ratio', () => {
    expect(checkAccent('#b4235a')).toEqual({
      ok: false,
      issues: ['light: #b4235a on the page (#d0d9db) is 4.40:1, needs 4.5:1'],
    });
    expect(checkAccent('#2563eb')).toEqual({
      ok: false,
      issues: [
        'light: #2563eb on the page (#d0d9db) is 3.60:1, needs 4.5:1',
        'light: #2563eb on panels (#dfe5e7) is 4.06:1, needs 4.5:1',
      ],
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
    ['#2563eb', '#1451d8'],
    ['#e11d48', '#bd0137'],
    ['#ffd400', '#6f5c13'],
    ['#86269b', '#86269b'],
  ])('%s -> %s', (input, expected) => {
    expect(suggestAccent(input)).toBe(expected);
  });
});

describe("effectiveBranding: a stored accent is re-judged against today's surfaces", () => {
  it('paints a still-passing accent with freshly derived steps', () => {
    expect(effectiveBranding('#86269b')).toMatchObject({
      kind: 'stored',
      light: { accent: '#86269b' },
      dark: { accent: '#be60d4' },
    });
  });

  it('moves an accent the redesign invalidated to its nearest passing shade', () => {
    // Harbor Labs' seeded accent: 4.5:1+ on the old mint page, 4.40:1 on the console grey.
    expect(effectiveBranding('#b4235a')).toEqual({
      kind: 'adjusted',
      requested: '#b4235a',
      used: '#b11f57',
      light: { accent: '#b11f57', ink: '#ffffff', soft: '#e5d4dd' },
      dark: { accent: '#e35280', ink: '#10181a', soft: '#2b1e26' },
    });
  });

  it('falls back to the product accent when nothing passes', () => {
    expect(effectiveBranding('not-a-colour')).toEqual({
      kind: 'product',
      requested: 'not-a-colour',
    });
  });

  it('never paints an accent that fails, for any stored colour', () => {
    fc.assert(
      fc.property(hex, (colour) => {
        const e = effectiveBranding(colour);
        if (e.kind === 'product') return;
        for (const [step, s] of [
          [e.light, LIGHT],
          [e.dark, DARK],
        ] as const) {
          for (const bg of [s.bg, s.surface, s.surface2])
            expect(contrast(step.accent, bg)).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }),
      { seed: 12, numRuns: 300 },
    );
  });
});

describe('accentReport: the refusal as rows', () => {
  it('measures every pair, so the page can show which surface fails and by how much', () => {
    const report = accentReport('#B4235A')!;
    expect(report.rows.map((r) => [r.where, r.ratio, r.pass])).toEqual([
      ['Text on the page', 4.4, false],
      ['Text on cards', 5.6, true],
      ['Text on panels', 4.96, true],
      ['Button label', 6.31, true],
      ['Text on the tint', 12.79, true],
    ]);
    expect(report.darkShade).toBe('#e1517f');
  });

  it('agrees with checkAccent on every random colour: no failing row means accepted', () => {
    fc.assert(
      fc.property(hex, (colour) => {
        const report = accentReport(colour)!;
        const clean = report.rows.every((r) => r.pass) && report.darkShade !== null;
        expect(checkAccent(colour).ok).toBe(clean);
      }),
      { seed: 13, numRuns: 500 },
    );
  });

  it('has no rows for a malformed colour', () => {
    expect(accentReport('#12')).toBeNull();
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
