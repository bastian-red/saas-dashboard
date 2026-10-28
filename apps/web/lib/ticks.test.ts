/**
 * Expected ticks were produced by running calendarTicks under Node 20's ICU
 * and pasted, never typed from a calendar in memory.
 */
import { describe, expect, it } from 'vitest';

import { calendarTicks } from './ticks';

const H = 3_600_000;
const hours = (endIso: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(endIso) - (n - i) * H).toISOString());
const days = (startIso: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(startIso) + i * 24 * H).toISOString());

describe('calendar ticks', () => {
  it('24 hours: every 4 hours on the clock, not every 4th bucket from an odd start', () => {
    expect(calendarTicks(hours('2026-10-28T14:00:00Z', 24), 'hour', 'UTC')).toEqual([
      { index: 2, label: '16:00' },
      { index: 6, label: '20:00' },
      { index: 10, label: '00:00' },
      { index: 14, label: '04:00' },
      { index: 18, label: '08:00' },
      { index: 22, label: '12:00' },
    ]);
  });

  it('7 days: each local midnight, labelled by its day', () => {
    const ticks = calendarTicks(hours('2026-10-28T20:00:00Z', 168), 'hour', 'UTC');
    expect(ticks.map((t) => t.label)).toEqual([
      'Thu 22',
      'Fri 23',
      'Sat 24',
      'Sun 25',
      'Mon 26',
      'Tue 27',
      'Wed 28',
    ]);
    expect(ticks[0]!.index).toBe(4);
  });

  it("7 days in another zone: midnight is the zone's own, three hours later in Sao Paulo", () => {
    const ticks = calendarTicks(hours('2026-10-28T20:00:00Z', 168), 'hour', 'America/Sao_Paulo');
    expect(ticks.map((t) => t.index)).toEqual([7, 31, 55, 79, 103, 127, 151]);
  });

  it('30 days: Mondays', () => {
    expect(calendarTicks(days('2026-09-28T00:00:00Z', 31), 'day', 'UTC')).toEqual([
      { index: 0, label: 'Sep 28' },
      { index: 7, label: 'Oct 5' },
      { index: 14, label: 'Oct 12' },
      { index: 21, label: 'Oct 19' },
      { index: 28, label: 'Oct 26' },
    ]);
  });

  it('90 days: the 1st and the 15th', () => {
    expect(
      calendarTicks(days('2026-07-31T00:00:00Z', 91), 'day', 'UTC').map((t) => t.label),
    ).toEqual(['Aug 1', 'Aug 15', 'Sep 1', 'Sep 15', 'Oct 1', 'Oct 15']);
  });

  it('never repeats a label and never puts one against the right edge', () => {
    for (const [buckets, bucket] of [
      [hours('2026-10-28T20:00:00Z', 168), 'hour'],
      [days('2026-09-28T00:00:00Z', 31), 'day'],
    ] as const) {
      const ticks = calendarTicks(buckets, bucket, 'UTC');
      expect(new Set(ticks.map((t) => t.label)).size).toBe(ticks.length);
      for (const t of ticks) expect(t.index / buckets.length).toBeLessThanOrEqual(0.96);
    }
  });
});
