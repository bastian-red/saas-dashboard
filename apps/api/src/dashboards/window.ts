import type { RangeKey } from '@saas/shared';

import type { Window } from '@saas/query-engine';

/**
 * A dashboard's range to the query window every lane shares. Ends at the end
 * of the current hour, so the hour in progress is on the chart; hour buckets up
 * to 7 days (168 points), day buckets beyond.
 */
const HOUR = 3_600_000;
const SPAN: Record<RangeKey, number> = {
  '24h': 24 * HOUR,
  '7d': 7 * 24 * HOUR,
  '30d': 30 * 24 * HOUR,
  '90d': 90 * 24 * HOUR,
};

export function windowFor(range: RangeKey, tz: string, now: Date): Window {
  const to = Math.ceil((now.getTime() + 1) / HOUR) * HOUR;
  return {
    from: new Date(to - SPAN[range]),
    to: new Date(to),
    bucket: range === '24h' || range === '7d' ? 'hour' : 'day',
    tz,
  };
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
