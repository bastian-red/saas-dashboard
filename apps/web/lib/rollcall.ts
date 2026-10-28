/**
 * The roll call: for each lane, is the latest complete bucket up, down or
 * steady against what that bucket is usually like?
 *
 * Deliberately computed from the data the dashboard already has, not from a
 * second "previous period" query: the 8-lane scale test sits at 260-286 ms of
 * a 300 ms budget, and doubling every lane's scan would break it.
 *
 * Properties held, each pinned by `rollcall.test.ts`:
 *
 * - **The bucket in progress is never judged.** The window ends at the end of
 *   the current hour, so the last bucket is a partial hour or a partial day; a
 *   half-finished day always looks "down". The latest COMPLETE bucket is n - 2.
 * - **Seasonal, not flat.** Hours are compared with the same hour on other
 *   days, days with the same weekday in other weeks. A plain median of every
 *   hour would call every night "down" and every weekend "down".
 * - **A verdict needs a baseline.** Fewer than MIN_SAMPLES earlier slots (the
 *   24-hour range has none) is `unknown`, said in words, never a guess.
 * - **Noise is measured, not assumed.** The band is the median absolute
 *   deviation of the samples (scaled to a standard deviation), floored at 10%
 *   of typical and at 1 event, so a lane of mostly zeros does not flip on a
 *   single event.
 */

export type Verdict = 'up' | 'down' | 'steady' | 'unknown';

export interface Call {
  readonly verdict: Verdict;
  /** Index of the bucket judged (the latest complete one), or null with no data. */
  readonly index: number | null;
  readonly latest: number;
  /** Median of the same slot in earlier periods. */
  readonly typical: number;
  /** (latest - typical) / typical, or null when typical is 0. */
  readonly change: number | null;
  readonly samples: number;
  /** The steady band, typical +- BAND noise widths (low clamped at 0); null without a baseline. */
  readonly range: { readonly low: number; readonly high: number } | null;
}

export const MIN_SAMPLES = 4;
/** How many noise widths from typical before a bucket is called up or down. */
export const BAND = 2;
/** MAD to standard deviation, for normally distributed noise. */
const MAD_TO_SD = 1.4826;

export function period(bucket: 'hour' | 'day'): number {
  return bucket === 'hour' ? 24 : 7;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function rollCall(totals: readonly number[], bucket: 'hour' | 'day'): Call {
  const index = totals.length - 2;
  if (index < 0) {
    return {
      verdict: 'unknown',
      index: null,
      latest: 0,
      typical: 0,
      change: null,
      samples: 0,
      range: null,
    };
  }
  const latest = totals[index]!;
  const step = period(bucket);
  const samples: number[] = [];
  for (let i = index - step; i >= 0; i -= step) samples.push(totals[i]!);
  const typical = median(samples);
  const change = typical === 0 ? null : (latest - typical) / typical;
  if (samples.length < MIN_SAMPLES) {
    return {
      verdict: 'unknown',
      index,
      latest,
      typical,
      change: null,
      samples: samples.length,
      range: null,
    };
  }
  const mad = median(samples.map((v) => Math.abs(v - typical)));
  const noise = Math.max(MAD_TO_SD * mad, 0.1 * typical, 1);
  const low = Math.max(0, typical - BAND * noise);
  const high = typical + BAND * noise;
  const verdict: Verdict = latest > high ? 'up' : latest < low ? 'down' : 'steady';
  return { verdict, index, latest, typical, change, samples: samples.length, range: { low, high } };
}

/** A lane's per-bucket total across its series (a breakdown is judged as a whole). */
export function bucketTotals(points: readonly (readonly number[])[]): number[] {
  return points.map((p) => p.reduce((a, b) => a + b, 0));
}

/** "+36%", "-31%", "0%"; null change (typical was zero) reads as the difference in events. */
export function formatChange(call: Call): string {
  if (call.change === null) {
    const diff = call.latest - call.typical;
    return `${diff >= 0 ? '+' : '-'}${String(Math.round(Math.abs(diff)))}`;
  }
  const pct = Math.round(call.change * 100);
  return `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${String(Math.abs(pct))}%`;
}

/** Glyph and word for each verdict: colour is the third channel, never the only one. */
export const VERDICT_DISPLAY: Record<Verdict, { glyph: string; word: string }> = {
  up: { glyph: '▲', word: 'Up' },
  down: { glyph: '▼', word: 'Down' },
  steady: { glyph: '●', word: 'Steady' },
  unknown: { glyph: '○', word: 'No baseline' },
};
