/**
 * Every expected string below was produced by running the function under the
 * Node this repo pins, then pasted: Intl output is a platform fact, not
 * something to recall: a wrong expectation invites "fixing" correct code until it passes.
 */
import { describe, expect, it } from 'vitest';

import {
  formatBucket,
  formatBucketLong,
  formatCompact,
  formatDate,
  formatError,
  formatUsd,
  formatWhole,
} from './format';

describe('numbers', () => {
  it('compacts from a thousand up, and not below', () => {
    expect(formatCompact(940)).toBe('940');
    expect(formatCompact(1234)).toBe('1.2K');
    expect(formatCompact(3_450_000)).toBe('3.5M');
  });

  it('groups exact values and dollars', () => {
    expect(formatWhole(1_234_567)).toBe('1,234,567');
    expect(formatUsd(12_345)).toBe('$12,345');
  });

  it('states a sketch error as a plus-or-minus percentage', () => {
    expect(formatError(0.0229)).toBe('±2.3%');
  });
});

describe('instants, in the viewer zone', () => {
  const at = '2026-10-14T14:00:00.000Z';

  it('labels an hour bucket by weekday and hour, in the zone asked for', () => {
    expect(formatBucket(at, 'hour', 'UTC')).toBe('Wed 14:00');
    expect(formatBucket(at, 'hour', 'America/Santiago')).toBe('Wed 11:00');
  });

  it('labels a day bucket by its date', () => {
    expect(formatBucket('2026-10-14T03:00:00.000Z', 'day', 'UTC')).toBe('Oct 14');
  });

  it('spells the long form out for the crosshair and the table', () => {
    expect(formatBucketLong(at, 'hour', 'UTC')).toBe('Wed, Oct 14, 14:00');
    expect(formatBucketLong('2026-10-14T00:00:00.000Z', 'day', 'Asia/Tokyo')).toBe(
      'Wed, Oct 14, 2026',
    );
    expect(formatDate('2026-11-20T12:00:00.000Z', 'UTC')).toBe('Nov 20, 2026');
  });
});
