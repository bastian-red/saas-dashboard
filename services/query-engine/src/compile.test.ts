import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { laneSpecSchema, type LaneSpec } from '@saas/shared';

import { compileBuckets, compileLane, pathFor, type Window } from './compile';

const W: Window = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-10-08T00:00:00Z'),
  bucket: 'day',
  tz: 'America/Santiago',
};
// Parsed, so a test spec gets the same defaults and refusals a real one does.
const spec = (s: unknown): LaneSpec => laneSpecSchema.parse(s);

describe('path selection', () => {
  it.each([
    [{ metric: 'count', event: 'Signed up' }, 'rollup'],
    [{ metric: 'count', event: 'Signed up', breakdown: 'plan' }, 'rollup'],
    [{ metric: 'unique_users', event: 'Signed up' }, 'rollup'],
    [{ metric: 'sum', event: 'Paid', sumProperty: 'amount' }, 'rollup'],
    [{ metric: 'unique_users', event: 'Signed up', breakdown: 'plan' }, 'raw'],
    [
      {
        metric: 'count',
        event: 'Signed up',
        filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
      },
      'raw',
    ],
  ] as const)('%j -> %s', (s, path) => {
    expect(pathFor(spec(s))).toBe(path);
  });
});

describe('golden SQL', () => {
  it('count by breakdown reads event_dim_hours with every value bound', () => {
    const c = compileLane(spec({ metric: 'count', event: 'Signed up', breakdown: 'plan' }), W);
    expect(c.sql).toBe(
      `SELECT (date_trunc($4, hour AT TIME ZONE $5) AT TIME ZONE $5) AS bucket, value AS key, sum("count")::float8 AS value FROM event_dim_hours WHERE event = $1 AND property = $6 AND hour >= $2 AND hour < $3 GROUP BY 1, 2`,
    );
    expect(c.params).toEqual(['Signed up', W.from, W.to, 'day', 'America/Santiago', 'plan']);
  });

  it('cuts hour buckets in UTC whatever the viewer zone', () => {
    const c = compileLane(spec({ metric: 'count', event: 'x' }), { ...W, bucket: 'hour' });
    expect(c.params).toContain('UTC');
    expect(c.params).not.toContain('America/Santiago');
  });

  it('a filtered unique count reads raw events and counts distinct hashes', () => {
    const c = compileLane(
      spec({
        metric: 'unique_users',
        event: 'Viewed',
        filters: [{ property: 'plan', op: 'neq', value: 'free' }],
      }),
      W,
    );
    expect(c.path).toBe('raw');
    expect(c.sql).toContain('count(DISTINCT user_hash)');
    expect(c.sql).toContain('(properties ->> $6) IS DISTINCT FROM $7');
  });

  it('never filters on tenant_id: row-level security scopes every statement', () => {
    for (const s of [
      spec({ metric: 'count', event: 'x' }),
      spec({
        metric: 'sum',
        event: 'x',
        sumProperty: 'y',
        filters: [{ property: 'a', op: 'eq', value: 'b' }],
      }),
    ]) {
      expect(compileLane(s, W).sql).not.toContain('tenant_id');
    }
  });

  it('builds the zero-filled axis from the same bucket rules', () => {
    const b = compileBuckets(W);
    expect(b.params).toEqual(['day', 'America/Santiago', W.from, W.to]);
    expect(b.sql).toContain('generate_series');
  });
});

/** Strings an attacker would try, constrained to what each schema field accepts. */
const hostileEvent = fc.constantFrom(
  'Signed up',
  "A'; DROP TABLE events; --",
  'A" OR 1=1',
  'A$1',
  'A\\\\',
);
const property = fc.constantFrom('plan', 'country', 'amount');
const hostileValue = fc.constantFrom(
  'premium_tier',
  "' OR '1'='1",
  '$$; SELECT 1; $$',
  '\\x00',
  '%',
);

const arbSpec = fc
  .record({
    metric: fc.constantFrom('count', 'unique_users', 'sum'),
    event: hostileEvent,
    breakdown: fc.option(property, { nil: null }),
    filters: fc.array(
      fc.record({ property, op: fc.constantFrom('eq', 'neq'), value: hostileValue }),
      { maxLength: 3 },
    ),
  })
  .map((r) => ({ ...r, sumProperty: r.metric === 'sum' ? 'amount' : null }))
  .filter((r) => laneSpecSchema.safeParse(r).success)
  .map((r) => laneSpecSchema.parse(r));

describe('injection: nothing from the spec reaches the SQL text', () => {
  it('the text depends only on the spec SHAPE, never on its strings', () => {
    fc.assert(
      fc.property(arbSpec, (s) => {
        const c = compileLane(s, W);
        // A canonical spec of the same shape, every string replaced.
        const canon = laneSpecSchema.parse({
          ...s,
          event: 'E',
          breakdown: s.breakdown === null ? null : 'p',
          sumProperty: s.sumProperty === null ? null : 'q',
          filters: s.filters.map((f) => ({ ...f, property: 'f', value: 'v' })),
        });
        expect(c.sql).toBe(compileLane(canon, W).sql);
        for (const text of [s.event, ...s.filters.map((f) => f.value)]) {
          if (text.length > 2) expect(c.sql).not.toContain(text);
        }
      }),
      { seed: 12, numRuns: 500 },
    );
  });

  it('the schema refuses hostile event names before the compiler sees them', () => {
    expect(
      laneSpecSchema.safeParse({ metric: 'count', event: "A'; DROP TABLE events; --" }).success,
    ).toBe(false);
  });
});
