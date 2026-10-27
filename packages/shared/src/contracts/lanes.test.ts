import { describe, expect, it } from 'vitest';

import { laneSpecSchema } from './lanes';

describe('laneSpecSchema', () => {
  it('accepts a breakdown line and fills the defaults', () => {
    expect(
      laneSpecSchema.parse({ metric: 'count', event: 'Signed up', breakdown: 'plan' }),
    ).toEqual({
      metric: 'count',
      event: 'Signed up',
      sumProperty: null,
      breakdown: 'plan',
      filters: [],
      viz: 'line',
    });
  });

  it.each([
    ['sum without a property', { metric: 'sum', event: 'Paid' }],
    ['a property on count', { metric: 'count', event: 'Paid', sumProperty: 'amount' }],
    ['stacked without a breakdown', { metric: 'count', event: 'Paid', viz: 'stacked' }],
    ['an event name carrying SQL', { metric: 'count', event: "x'; DROP TABLE events;--" }],
    ['a property name with a quote', { metric: 'count', event: 'Paid', breakdown: 'pl"an' }],
    ['an unknown field', { metric: 'count', event: 'Paid', sql: 'select 1' }],
  ])('refuses %s', (_name, spec) => {
    expect(laneSpecSchema.safeParse(spec).success).toBe(false);
  });
});
