import { describe, expect, it } from 'vitest';

import {
  areaPath,
  axisTicks,
  bucketAt,
  laneMax,
  linePath,
  niceMax,
  PLOT_WIDTH,
  slot,
  stackedSegments,
  yFor,
} from './chart';

describe('the shared axis', () => {
  it('puts bucket i at the same x whatever the lane', () => {
    expect(slot(0, 4)).toEqual({ left: 0, right: 250, mid: 125 });
    expect(slot(3, 4).right).toBe(PLOT_WIDTH);
  });

  it('maps a pointer x back to the bucket under it, clamped to the axis', () => {
    expect(bucketAt(0, 24)).toBe(0);
    expect(bucketAt(999.9, 24)).toBe(23);
    expect(bucketAt(PLOT_WIDTH, 24)).toBe(23);
    expect(bucketAt(-50, 24)).toBe(0);
    // Every bucket's middle maps back to itself: the crosshair never drifts a slot.
    for (let i = 0; i < 168; i += 1) expect(bucketAt(slot(i, 168).mid, 168)).toBe(i);
  });
});

describe('the y domain', () => {
  it.each([
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
    [1, 1],
    [7, 10],
    [12, 20],
    [21, 25],
    [26, 50],
    [940, 1000],
    [1001, 2000],
    [2400, 2500],
  ])('niceMax(%s) is %s', (max, expected) => {
    expect(niceMax(max)).toBe(expected);
  });

  it('pins zero at the baseline and the top at y 0', () => {
    expect(yFor(0, 100, 80)).toBe(80);
    expect(yFor(100, 100, 80)).toBe(0);
    expect(yFor(-5, 100, 80)).toBe(80);
  });

  it('sizes stacked lanes by the tallest stack, single lanes by the tallest point', () => {
    const points = [
      [1, 2, 3],
      [4, 0, 0],
    ];
    expect(laneMax(points, true)).toBe(6);
    expect(laneMax(points, false)).toBe(4);
  });
});

describe('marks', () => {
  it('draws a line of straight segments through the slot middles', () => {
    expect(linePath([0, 10], 10, 100)).toBe('M250.00 100.00 L750.00 0.00');
    expect(areaPath([0, 10], 10, 100)).toBe(
      'M250.00 100.00 L750.00 0.00 L750.00 100 L250.00 100 Z',
    );
    expect(areaPath([], 10, 100)).toBe('');
  });

  it('caps a column at 24 units and leaves a 2-unit gap between stacked segments', () => {
    const segs = stackedSegments([[50, 50]], 100, 100);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.width).toBe(24);
    expect(segs[0]).toMatchObject({ series: 0, y: 50, height: 50 });
    // The second segment's top is at 0 and its bottom stops 2 short of the first's top.
    expect(segs[1]).toMatchObject({ series: 1, y: 0, height: 48 });
  });

  it('narrows columns in a crowded axis instead of overlapping them', () => {
    const segs = stackedSegments(
      Array.from({ length: 168 }, () => [1]),
      1,
      100,
    );
    expect(segs[0]!.width).toBeLessThan(PLOT_WIDTH / 168);
  });

  it('skips zero values and slivers thinner than their gap', () => {
    const segs = stackedSegments([[100, 0, 0.5]], 100, 100);
    expect(segs.map((s) => s.series)).toEqual([0]);
  });
});

describe('axis ticks', () => {
  it('labels about six buckets, starting at the first', () => {
    expect(axisTicks(0)).toEqual([]);
    expect(axisTicks(1)).toEqual([0]);
    expect(axisTicks(24)).toEqual([0, 4, 8, 12, 16, 20]);
    expect(axisTicks(30)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(axisTicks(168)).toEqual([0, 28, 56, 84, 112, 140]);
  });
});
