/**
 * Numbers and instants as people read them. One locale, `en-US`, everywhere:
 * the interface copy is English, and a page that writes "1.234" in one place
 * and "1,234" in another is one a reader cannot trust.
 */

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** Axis ticks and readouts: 940, 1.2K, 3.4M. */
export function formatCompact(value: number): string {
  return Math.abs(value) < 1000 ? whole.format(value) : compact.format(value);
}

/** Exact, grouped: tables and the hero number. */
export function formatWhole(value: number): string {
  return whole.format(value);
}

export function formatUsd(value: number): string {
  return money.format(value);
}

/** "±2.3%": the standard error a unique-users estimate carries. */
export function formatError(relative: number): string {
  return `±${(relative * 100).toFixed(1)}%`;
}

/**
 * One bucket's label in the viewer's zone. Hour buckets show the weekday and
 * the hour, day buckets the date: a crosshair on "Tue 14:00" is a time of day,
 * on "Oct 14" a whole day.
 */
export function formatBucket(iso: string, bucket: 'hour' | 'day', tz: string): string {
  const d = new Date(iso);
  if (bucket === 'day')
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
    }).format(d);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

/** The long form, for the crosshair's accessible value and the table's first column. */
export function formatBucketLong(iso: string, bucket: 'hour' | 'day', tz: string): string {
  const d = new Date(iso);
  const options: Intl.DateTimeFormatOptions =
    bucket === 'day'
      ? { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
      : {
          timeZone: tz,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        };
  return new Intl.DateTimeFormat('en-US', options).format(d);
}

export function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}
