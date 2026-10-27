/**
 * The tenant-accent gate.
 *
 * Two facts make "an accepted accent can never break contrast" true, and this
 * file holds both:
 *
 * 1. services/branding judges a tenant's colour against the product's real
 *    surfaces. Its LIGHT/DARK tables must equal globals.css; if someone
 *    retints the canvas and forgets the branding service, an accent that passed
 *    yesterday could fail today with nobody re-checking it.
 * 2. The accent reaches only marks the branding service judged it for: the
 *    lane rail, primary buttons (with the derived ink), the focus ring, the
 *    workspace monogram, and the current-page marker (on the derived soft
 *    tint, under body text). Nothing else may read --brand, so a passing
 *    colour cannot leak into body text or a chart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkAccent, DARK, LIGHT } from '@saas/branding';
import { describe, expect, it } from 'vitest';

import { resolve, stripCssComments } from './contrast';
import { SURFACES } from './identity.test';

const css = stripCssComments(readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8'));

describe('the branding service judges accents on the real surfaces', () => {
  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ] as const)('%s: bg, surface, surface-2 and text equal globals.css', (scheme, table) => {
    const palette = SURFACES[scheme];
    expect({
      bg: table.bg,
      surface: table.surface,
      surface2: table.surface2,
      text: table.text,
    }).toEqual({
      bg: resolve(palette, '--bg'),
      surface: resolve(palette, '--surface'),
      surface2: resolve(palette, '--surface-2'),
      text: resolve(palette, '--text'),
    });
  });
});

/** Every rule whose declarations read a --brand token, as [selector, declarations]. */
function brandRules(): [string, string][] {
  const out: [string, string][] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    const body = m[2]!;
    // Declarations that DEFINE a --brand* token are the plumbing, not a use.
    const uses = body
      .split(';')
      .filter((d) => /var\(\s*--brand/u.test(d) && !d.trim().startsWith('--'))
      .join(';');
    if (uses !== '') out.push([selector.replace(/\s+/gu, ' '), uses]);
  }
  return out;
}

const ALLOWED = new Map<string, RegExp>([
  [':focus-visible', /^outline$/u],
  ['.button-primary', /^(background|border-color|color)$/u],
  ['.button-primary:hover', /^background$/u],
  ['.ws-mark', /^(background|color)$/u],
  [".nav-link[aria-current='page']", /^(border-left-color|background)$/u],
  ['.lane::before', /^background$/u],
]);

describe('the tenant accent reaches only the marks it was judged for', () => {
  const rules = brandRules();

  it('found the rules, so the scan is running', () => {
    expect(rules.length).toBeGreaterThanOrEqual(5);
  });

  it.each(rules)('%s may wear the accent', (selector, body) => {
    const allowed = ALLOWED.get(selector);
    expect(allowed, `${selector} reads --brand but is not on the allowlist`).toBeDefined();
    for (const decl of body.split(';')) {
      if (!/var\(\s*--brand/u.test(decl)) continue;
      const property = decl.split(':')[0]!.trim();
      expect(property, `${selector} uses --brand for ${property}`).toMatch(allowed!);
    }
  });

  it('pairs --brand-ink only with --brand, and --brand-soft only under body text', () => {
    for (const [selector, body] of rules) {
      if (body.includes('--brand-ink'))
        expect(body, selector).toMatch(/background:\s*var\(--brand\)/u);
      if (body.includes('--brand-soft')) expect(selector).toBe(".nav-link[aria-current='page']");
    }
  });

  it('resolves --brand on the element that carries the tenant values, in both schemes', () => {
    // Declared only on :root, --brand would resolve where no --tenant-* exists
    // and inherit as the product plum into every branded workspace. That shipped
    // once in development; this is the regression gate.
    const blocks = [...css.matchAll(/\[data-branded\]\s*\{([^}]*)\}/gu)].map((m) => m[1]!);
    expect(
      blocks.some((b) => b.includes('--brand: var(--tenant-accent-light, var(--accent))')),
    ).toBe(true);
    expect(
      blocks.some((b) => b.includes('--brand: var(--tenant-accent-dark, var(--accent))')),
    ).toBe(true);
  });

  it('falls back to the product accent when a workspace has no branding', () => {
    expect(SURFACES.light['--brand']).toBe('var(--tenant-accent-light, var(--accent))');
    expect(SURFACES.dark['--brand']).toBe('var(--tenant-accent-dark, var(--accent))');
  });
});

describe('the demo workspace accent passes the same gate', () => {
  it('#b4235a is accepted with a derived dark step', () => {
    const r = checkAccent('#b4235a');
    expect(r.ok).toBe(true);
  });
});
