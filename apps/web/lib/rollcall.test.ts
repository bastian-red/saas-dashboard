import { describe, expect, it } from 'vitest';

import {
  bucketTotals,
  formatChange,
  median,
  MIN_SAMPLES,
  rollCall,
  VERDICT_DISPLAY,
} from './rollcall';

/** 30 day buckets plus today in progress: weekdays busy, weekends quiet. */
function month(latestValue: number, todaySoFar = 3): number[] {
  const days = Array.from({ length: 30 }, (_, i) =>
    i % 7 === 5 || i % 7 === 6 ? 20 : 100 + (i % 3),
  );
  days[29] = latestValue;
  return [...days, todaySoFar];
}

describe('the roll call', () => {
  it('never judges the bucket in progress', () => {
    // A partial day of 3 would read as a collapse; the judged bucket is the one before it.
    const call = rollCall(month(101), 'day');
    expect(call.index).toBe(29);
    expect(call.latest).toBe(101);
    expect(call.verdict).toBe('steady');
  });

  it('compares a day with the same weekday, so a quiet weekend is not "down"', () => {
    const days: number[] = Array.from({ length: 30 }, (_, i) => (i % 7 === 1 ? 20 : 100));
    // Index 29 is the same weekday as 1, 8, 15, 22: all quiet, so a quiet 29 is normal.
    days[29] = 21;
    const call = rollCall([...days, 0], 'day');
    expect(call.samples).toBe(4);
    expect(call.typical).toBe(20);
    expect(call.verdict).toBe('steady');
  });

  it('compares an hour with the same hour on other days, so a night is not "down"', () => {
    const hours: number[] = Array.from({ length: 168 }, (_, i) => (i % 24 < 6 ? 2 : 50));
    const latest = hours.length - 2; // hour 22 of the last day: busy
    hours[latest] = 4; // a busy hour that went quiet
    const call = rollCall(hours, 'hour');
    expect(call.verdict).toBe('down');
    // And a night hour at its usual level stays steady.
    const nights = Array.from({ length: 168 }, (_, i) => (i % 24 === 22 ? 2 : 50));
    expect(rollCall(nights, 'hour').verdict).toBe('steady');
  });

  it('calls a clear rise up and a clear fall down, with the change against typical', () => {
    const up = rollCall(month(150), 'day');
    expect(up.verdict).toBe('up');
    expect(up.typical).toBe(101);
    expect(formatChange(up)).toBe('+49%');
    const down = rollCall(month(60), 'day');
    expect(down.verdict).toBe('down');
    expect(formatChange(down)).toBe('-41%');
  });

  it('reports the steady band it judged against, so "steady" can be checked by eye', () => {
    // Lumpy revenue: a day far below typical is still inside a band that wide.
    const lumpy = [900, 40, 700, 20, 1200, 60, 500, 30, 800, 50, 300, 0, 600, 10, 49, 0];
    const call = rollCall(lumpy, 'hour');
    expect(call.verdict).toBe('unknown'); // 16 hours: no earlier same hour
    const daily = [
      ...Array.from({ length: 28 }, (_, i) => [900, 40, 700, 20, 1200, 60, 500][i % 7]!),
      49,
      0,
    ];
    const day = rollCall(daily, 'day');
    expect(day.index).toBe(28);
    expect(day.typical).toBe(900);
    expect(day.range).not.toBeNull();
    expect(day.latest).toBeLessThan(day.range!.low);
    expect(day.verdict).toBe('down');
  });

  it('needs a baseline: the 24-hour range has no earlier same hour, and says so', () => {
    const call = rollCall(
      Array.from({ length: 24 }, () => 10),
      'hour',
    );
    expect(call.samples).toBeLessThan(MIN_SAMPLES);
    expect(call.verdict).toBe('unknown');
    expect(VERDICT_DISPLAY.unknown.word).toBe('No baseline');
  });

  it('does not flip a mostly-zero lane on a single event', () => {
    const sparse = Array.from({ length: 31 }, () => 0);
    sparse[29] = 1;
    const call = rollCall(sparse, 'day');
    expect(call.verdict).toBe('steady');
    expect(call.change).toBeNull();
    expect(formatChange(call)).toBe('+1');
  });

  it('judges a breakdown by its total, and survives an empty window', () => {
    expect(
      bucketTotals([
        [1, 2, 3],
        [0, 0, 0],
      ]),
    ).toEqual([6, 0]);
    expect(rollCall([], 'day')).toMatchObject({ verdict: 'unknown', index: null });
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
