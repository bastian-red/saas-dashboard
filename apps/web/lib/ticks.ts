/**
 * Axis ticks on calendar boundaries, in the dashboard's time zone.
 *
 * The old ticks were every ceil(n / 6)th bucket counted from the first, so a
 * 7-day axis that started at 19:00 labelled "Wed 04:00", "Sat 16:00": true,
 * and useless for reading a week. A tick now sits where a person would put
 * one, and its label says only what changes there:
 *
 * - 24 hours (hour buckets, at most a day): every 4 hours on the clock, "08:00".
 * - 7 days (hour buckets, more than a day): each local midnight, "Tue 27".
 * - 30 days (day buckets, at most 45): each Monday, "Oct 5".
 * - 90 days (day buckets, more): the 1st and the 15th, "Oct 1", "Oct 15".
 *
 * A tick in the last EDGE share of the axis is dropped: its label would be
 * clipped by the right edge, where the readout column begins.
 */

export interface Tick {
  readonly index: number;
  readonly label: string;
}

const EDGE = 0.04;

interface Parts {
  hour: number;
  day: number;
  weekday: string;
  month: string;
}

function partsOf(iso: string, tz: string): Parts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hourCycle: 'h23',
    day: 'numeric',
    weekday: 'short',
    month: 'short',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    hour: Number(get('hour')),
    day: Number(get('day')),
    weekday: get('weekday'),
    month: get('month'),
  };
}

export function calendarTicks(
  buckets: readonly string[],
  bucket: 'hour' | 'day',
  tz: string,
): Tick[] {
  const n = buckets.length;
  const out: Tick[] = [];
  const parts = buckets.map((b) => partsOf(b, tz));
  for (let i = 0; i < n; i++) {
    if (i / Math.max(1, n) > 1 - EDGE) break;
    const p = parts[i]!;
    let label: string | null = null;
    if (bucket === 'hour' && n <= 25) {
      if (p.hour % 4 === 0) label = `${String(p.hour).padStart(2, '0')}:00`;
    } else if (bucket === 'hour') {
      if (p.hour === 0) label = `${p.weekday} ${String(p.day)}`;
    } else if (n <= 45) {
      if (p.weekday === 'Mon') label = `${p.month} ${String(p.day)}`;
    } else if (p.day === 1 || p.day === 15) {
      label = `${p.month} ${String(p.day)}`;
    }
    if (label !== null) out.push({ index: i, label });
  }
  return out;
}
