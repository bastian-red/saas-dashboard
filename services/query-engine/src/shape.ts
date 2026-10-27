import { MAX_SERIES, type LaneResult } from '@saas/shared';

import { emptySketch, estimate, mergeInto, STANDARD_ERROR } from './hll';

/**
 * Rows from a compiled lane to the shape every lane shares: one value per
 * series per bucket of the dashboard's axis, zero-filled.
 *
 * Breakdowns keep the top MAX_SERIES keys by total and fold the rest into
 * "Other" (dataviz: categorical colour is assigned in fixed order and never
 * cycled, so a fourth series gets no new hue; it gets folded). The top keys are
 * chosen by the whole window, not per bucket, so a series keeps its colour from
 * the first bucket to the last.
 */
export const OTHER = 'Other';

export interface ValueRow {
  bucket: Date;
  key: string;
  value: number;
}

export interface SketchRow {
  bucket: Date;
  sketch: Uint8Array;
}

const keyOf = (d: Date): number => d.getTime();

export function shapeValues(
  laneId: string,
  buckets: readonly Date[],
  rows: readonly ValueRow[],
): LaneResult {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.key, (totals.get(r.key) ?? 0) + r.value);
  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k]) => k);
  const top = ranked.slice(0, MAX_SERIES);
  const folded = ranked.length > MAX_SERIES;
  const series = folded ? [...top, OTHER] : top.length > 0 ? top : ['value'];

  const index = new Map(buckets.map((b, i) => [keyOf(b), i]));
  const points = buckets.map(() => new Array<number>(series.length).fill(0));
  for (const r of rows) {
    const i = index.get(keyOf(r.bucket));
    if (i === undefined) continue;
    const s = top.includes(r.key) ? series.indexOf(r.key) : series.indexOf(OTHER);
    if (s >= 0) points[i]![s]! += r.value;
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  return { laneId, series, points, error: null, total };
}

/**
 * Unique users per bucket, by merging the hours' sketches, and over the whole
 * window by merging everything. The window total is NOT the sum of the
 * buckets: a person active on three days is one user for the month.
 */
export function shapeSketches(
  laneId: string,
  buckets: readonly Date[],
  rows: readonly SketchRow[],
): LaneResult {
  const perBucket = buckets.map(() => emptySketch());
  const index = new Map(buckets.map((b, i) => [keyOf(b), i]));
  for (const r of rows) {
    const i = index.get(keyOf(r.bucket));
    if (i === undefined) continue;
    mergeInto(perBucket[i]!, r.sketch);
  }
  // The window's union from the buckets' unions: 31 merges for a month of day
  // buckets instead of 721 hourly ones. Same result, merging is associative.
  const all = emptySketch();
  for (const s of perBucket) mergeInto(all, s);
  return {
    laneId,
    series: ['value'],
    points: perBucket.map((s) => [estimate(s)]),
    error: STANDARD_ERROR,
    total: estimate(all),
  };
}
