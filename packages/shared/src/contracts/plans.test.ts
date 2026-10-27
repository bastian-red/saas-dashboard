import { describe, expect, it } from 'vitest';

import { effectivePlan, PLAN_IDS, PLANS } from './plans';

describe('plans', () => {
  it('grow in every limit from free to business', () => {
    for (let i = 1; i < PLAN_IDS.length; i += 1) {
      const a = PLANS[PLAN_IDS[i - 1]!];
      const b = PLANS[PLAN_IDS[i]!];
      expect(b.monthlyEvents).toBeGreaterThan(a.monthlyEvents);
      expect(b.seats).toBeGreaterThan(a.seats);
      expect(b.ingestRps).toBeGreaterThan(a.ingestRps);
    }
  });

  it('gives an unpaid subscription the free plan, and keeps a past-due one on its plan', () => {
    expect(effectivePlan('team', 'active')).toBe('team');
    expect(effectivePlan('team', 'past_due')).toBe('team');
    expect(effectivePlan('team', 'canceled')).toBe('free');
    expect(effectivePlan('business', 'incomplete')).toBe('free');
    expect(effectivePlan('business', null)).toBe('free');
  });
});
