import type { LaneSpec } from '@saas/shared';

/**
 * A lane spec to one parameterised SQL statement.
 *
 * Two paths, chosen by what the rollups can answer:
 *
 * - ROLLUP: no filters, and not (unique users broken down by a property). Reads
 *   event_hours / event_dim_hours / event_sum_hours: hundreds of rows per lane
 *   whatever the event volume. This is the path the 300 ms dashboard budget is
 *   about.
 * - RAW: anything with a filter, or unique users per breakdown value. The
 *   rollups hold one dimension at a time, so "plan = pro, by country" needs the
 *   events themselves. Bounded by the (tenant_id, event, at) index and the
 *   range; measured separately.
 *
 * The rule that makes this safe: nothing from the spec is ever part of the SQL
 * TEXT. The event name, property names, filter values, bucket unit and time
 * zone are all bound parameters; property names are read with `properties ->>
 * $n`, so even a property name is data, not an identifier. The SQL text depends
 * only on the SHAPE of the spec (which path, how many filters), and the property
 * test asserts exactly that.
 *
 * No `tenant_id` predicate either, on purpose: every statement runs inside
 * withTenant, and row-level security is what scopes it. A tenant filter here
 * would be a second mechanism that could disagree with the first.
 */

export interface Window {
  from: Date;
  to: Date;
  bucket: 'hour' | 'day';
  /** IANA zone days are cut in. Hours are always cut in UTC (009 explains why). */
  tz: string;
}

export type Path = 'rollup' | 'raw';

export interface Compiled {
  path: Path;
  /** What the rows mean: `value` per bucket and series key, or HLL sketches to merge. */
  shape: 'values' | 'sketches';
  sql: string;
  params: unknown[];
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }
}

/** The bucket expression for a timestamp column, cut in UTC for hours and `tz` for days. */
function bucketExpr(column: string, w: Window, p: Params): string {
  const unit = p.add(w.bucket);
  const zone = p.add(w.bucket === 'hour' ? 'UTC' : w.tz);
  return `(date_trunc(${unit}, ${column} AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
}

export function pathFor(spec: LaneSpec): Path {
  if (spec.filters.length > 0) return 'raw';
  if (spec.metric === 'unique_users' && spec.breakdown !== null) return 'raw';
  return 'rollup';
}

export function compileLane(spec: LaneSpec, w: Window): Compiled {
  return pathFor(spec) === 'rollup' ? compileRollup(spec, w) : compileRaw(spec, w);
}

function compileRollup(spec: LaneSpec, w: Window): Compiled {
  const p = new Params();
  const event = p.add(spec.event);
  const from = p.add(w.from);
  const to = p.add(w.to);
  const bucket = bucketExpr('hour', w, p);

  if (spec.metric === 'unique_users') {
    // One sketch per hour; the caller merges them per bucket.
    return {
      path: 'rollup',
      shape: 'sketches',
      sql: `SELECT ${bucket} AS bucket, users_hll AS sketch FROM event_hours WHERE event = ${event} AND hour >= ${from} AND hour < ${to}`,
      params: p.values,
    };
  }
  if (spec.metric === 'sum') {
    const property = p.add(spec.sumProperty);
    return {
      path: 'rollup',
      shape: 'values',
      sql: `SELECT ${bucket} AS bucket, 'value' AS key, sum("sum")::float8 AS value FROM event_sum_hours WHERE event = ${event} AND property = ${property} AND hour >= ${from} AND hour < ${to} GROUP BY 1`,
      params: p.values,
    };
  }
  if (spec.breakdown !== null) {
    const property = p.add(spec.breakdown);
    return {
      path: 'rollup',
      shape: 'values',
      sql: `SELECT ${bucket} AS bucket, value AS key, sum("count")::float8 AS value FROM event_dim_hours WHERE event = ${event} AND property = ${property} AND hour >= ${from} AND hour < ${to} GROUP BY 1, 2`,
      params: p.values,
    };
  }
  return {
    path: 'rollup',
    shape: 'values',
    sql: `SELECT ${bucket} AS bucket, 'value' AS key, sum("count")::float8 AS value FROM event_hours WHERE event = ${event} AND hour >= ${from} AND hour < ${to} GROUP BY 1`,
    params: p.values,
  };
}

function compileRaw(spec: LaneSpec, w: Window): Compiled {
  const p = new Params();
  const event = p.add(spec.event);
  const from = p.add(w.from);
  const to = p.add(w.to);
  const bucket = bucketExpr('at', w, p);
  const where = [`event = ${event}`, `at >= ${from}`, `at < ${to}`];
  for (const f of spec.filters) {
    const key = p.add(f.property);
    const value = p.add(f.value);
    // A property that is absent compares as NULL; `neq` keeps those events
    // (they are not equal to the value), which is what a reader means by "not".
    where.push(
      f.op === 'eq'
        ? `properties ->> ${key} = ${value}`
        : `(properties ->> ${key}) IS DISTINCT FROM ${value}`,
    );
  }
  const key =
    spec.breakdown === null ? `'value'` : `coalesce(properties ->> ${p.add(spec.breakdown)}, '')`;
  let measure: string;
  if (spec.metric === 'count') measure = 'count(*)::float8';
  else if (spec.metric === 'unique_users') measure = 'count(DISTINCT user_hash)::float8';
  else {
    const prop = p.add(spec.sumProperty);
    // Only JSON numbers are summed; a string that looks like a number is not
    // silently coerced, and one that does not would otherwise abort the query.
    measure = `coalesce(sum(CASE WHEN jsonb_typeof(properties -> ${prop}) = 'number' THEN (properties ->> ${prop})::float8 END), 0)::float8`;
  }
  return {
    path: 'raw',
    shape: 'values',
    sql: `SELECT ${bucket} AS bucket, ${key} AS key, ${measure} AS value FROM events WHERE ${where.join(' AND ')} GROUP BY 1, 2`,
    params: p.values,
  };
}

/** Every bucket start in the window, zero-filled axis for every lane. */
export function compileBuckets(w: Window): { sql: string; params: unknown[] } {
  const p = new Params();
  const unit = p.add(w.bucket);
  const zone = p.add(w.bucket === 'hour' ? 'UTC' : w.tz);
  const from = p.add(w.from);
  const to = p.add(w.to);
  return {
    sql: `SELECT (g AT TIME ZONE ${zone}) AS bucket FROM generate_series(date_trunc(${unit}, ${from}::timestamptz AT TIME ZONE ${zone}), date_trunc(${unit}, (${to}::timestamptz - INTERVAL '1 millisecond') AT TIME ZONE ${zone}), ('1 ' || ${unit})::interval) AS g ORDER BY 1`,
    params: p.values,
  };
}
