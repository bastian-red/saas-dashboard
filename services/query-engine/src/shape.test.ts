import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { addHash, emptySketch } from './hll';
import { OTHER, shapeSketches, shapeValues } from './shape';

const LANE = 'clane000000000000000000001';
const days = [0, 1, 2].map((d) => new Date(Date.UTC(2026, 9, 1 + d)));

describe('shapeValues', () => {
  it('zero-fills every bucket of the axis', () => {
    const r = shapeValues(LANE, days, [{ bucket: days[1]!, key: 'value', value: 7 }]);
    expect(r.series).toEqual(['value']);
    expect(r.points).toEqual([[0], [7], [0]]);
    expect(r.total).toBe(7);
  });

  it('keeps the top three keys by WINDOW total and folds the rest into Other', () => {
    const rows = [
      { bucket: days[0]!, key: 'free', value: 50 },
      { bucket: days[0]!, key: 'team', value: 30 },
      { bucket: days[1]!, key: 'business', value: 20 },
      { bucket: days[1]!, key: 'trial', value: 5 },
      { bucket: days[2]!, key: 'legacy', value: 3 },
    ];
    const r = shapeValues(LANE, days, rows);
    expect(r.series).toEqual(['free', 'team', 'business', OTHER]);
    expect(r.points).toEqual([
      [50, 30, 0, 0],
      [0, 0, 20, 5],
      [0, 0, 0, 3],
    ]);
    expect(r.total).toBe(108);
  });

  it('answers an empty lane with one zero series, not a lane with no series', () => {
    expect(shapeValues(LANE, days, [])).toMatchObject({
      series: ['value'],
      points: [[0], [0], [0]],
      total: 0,
    });
  });
});

describe('shapeSketches', () => {
  const hash = (u: string) => createHash('sha256').update(u).digest().subarray(0, 16);
  const sketch = (users: string[]) => {
    const s = emptySketch();
    for (const u of users) addHash(s, hash(u));
    return s;
  };

  it('counts a user active on three days once for the window, and once per day', () => {
    const rows = days.map((bucket) => ({ bucket, sketch: sketch(['ada', 'grace']) }));
    const r = shapeSketches(LANE, days, rows);
    expect(r.points).toEqual([[2], [2], [2]]);
    expect(r.total).toBe(2);
    expect(r.error).toBeGreaterThan(0);
  });
});
