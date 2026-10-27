import { describe, expect, it } from 'vitest';

import { isTimeZone, windowFor } from './window';

describe('windowFor', () => {
  it('ends at the end of the current hour and picks the bucket by span', () => {
    const now = new Date('2026-10-26T14:37:00Z');
    expect(windowFor('24h', 'UTC', now)).toEqual({
      from: new Date('2026-10-25T15:00:00Z'),
      to: new Date('2026-10-26T15:00:00Z'),
      bucket: 'hour',
      tz: 'UTC',
    });
    expect(windowFor('30d', 'Europe/Berlin', now).bucket).toBe('day');
    expect(windowFor('7d', 'UTC', now).bucket).toBe('hour');
  });

  it('knows a real zone from a made-up one', () => {
    expect(isTimeZone('America/Santiago')).toBe(true);
    expect(isTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
