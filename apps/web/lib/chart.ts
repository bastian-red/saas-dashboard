/**
 * The geometry every lane shares. Pure, so the arithmetic is tested rather than
 * eyeballed in a browser.
 *
 * Lanes are drawn in a fixed 1000-unit-wide coordinate space (`PLOT_WIDTH`) and
 * stretched to the lane's real width by the SVG viewBox. Every lane on a
 * dashboard has the same buckets, so bucket `i` sits at the same x in every
 * lane: that is what lets one crosshair line up across all of them.
 */

export const PLOT_WIDTH = 1000;

/** The slot of bucket `i` of `n`: [left, right) in plot units. */
export function slot(i: number, n: number): { left: number; right: number; mid: number } {
  const w = PLOT_WIDTH / Math.max(1, n);
  return { left: i * w, right: (i + 1) * w, mid: (i + 0.5) * w };
}

/** The bucket under plot-x `x`, clamped to the axis. */
export function bucketAt(x: number, n: number): number {
  if (n <= 0) return 0;
  const i = Math.floor((x / PLOT_WIDTH) * n);
  return Math.min(n - 1, Math.max(0, i));
}

/**
 * A round upper bound for the y-axis: 1, 2, 2.5 or 5 times a power of ten, at
 * or above `max`. The domain is pinned at zero (dataviz: a bar or line that
 * starts above zero overstates change), and a round top makes the one labelled
 * gridline a number a person can read at a glance.
 */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

/** y in plot units (0 at the top) for `value` on a lane `height` tall with domain [0, top]. */
export function yFor(value: number, top: number, height: number): number {
  return height - (Math.max(0, value) / top) * height;
}

/**
 * A line through the middle of each slot. `M`/`L` only, so the path is exactly
 * the data: no smoothing curve inventing values between buckets.
 */
export function linePath(values: readonly number[], top: number, height: number): string {
  return values
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${slot(i, values.length).mid.toFixed(2)} ${yFor(v, top, height).toFixed(2)}`,
    )
    .join(' ');
}

/** The same line closed down to the baseline, for the 10% wash under it. */
export function areaPath(values: readonly number[], top: number, height: number): string {
  if (values.length === 0) return '';
  const n = values.length;
  return `${linePath(values, top, height)} L${slot(n - 1, n).mid.toFixed(2)} ${String(height)} L${slot(0, n).mid.toFixed(2)} ${String(height)} Z`;
}

export interface Segment {
  series: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Stacked columns, one per bucket, series in fixed order from the baseline up.
 *
 * Dataviz mark specs: a column never fills its slot (at most 24 px wide, and a
 * gap of air either side), and touching segments are separated by a 2-unit
 * surface gap rather than an outline. A segment too thin to survive its gap is
 * dropped from the drawing; its value is still in the readout and the table.
 */
export function stackedSegments(
  points: readonly (readonly number[])[],
  top: number,
  height: number,
  maxWidth = 24,
): Segment[] {
  const n = points.length;
  const slotWidth = PLOT_WIDTH / Math.max(1, n);
  const width = Math.min(maxWidth, slotWidth * 0.7);
  const gap = 2;
  const out: Segment[] = [];
  points.forEach((values, i) => {
    let base = height;
    const x = slot(i, n).mid - width / 2;
    values.forEach((v, s) => {
      const h = (Math.max(0, v) / top) * height;
      if (h <= 0) return;
      const drawn = h - (base < height ? gap : 0);
      if (drawn >= 0.5) out.push({ series: s, x, y: base - h, width, height: drawn });
      base -= h;
    });
  });
  return out;
}

/** The largest stack (breakdowns) or point (one series) on the lane: what the axis must hold. */
export function laneMax(points: readonly (readonly number[])[], stacked: boolean): number {
  let max = 0;
  for (const values of points) {
    const v = stacked ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values);
    if (v > max) max = v;
  }
  return max;
}

/** About six tick labels, evenly spaced from the first bucket, never one crowding the right edge. */
export function axisTicks(n: number): number[] {
  if (n <= 0) return [];
  const step = Math.max(1, Math.ceil(n / 6));
  const out: number[] = [];
  for (let i = 0; i < n - step / 2; i += step) out.push(i);
  return out;
}
