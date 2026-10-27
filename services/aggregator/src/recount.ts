import type { Pool } from 'pg';

import { addHash, emptySketch } from '@saas/query-engine';

/**
 * The rollups of one workspace, recomputed from its raw events, as a list of
 * disagreements. Empty is the proof the incremental passes added up to the
 * truth: counts, every breakdown value, every sum, and every HyperLogLog sketch
 * byte for byte (sketch merging is exact, so an incremental sketch equals one
 * built from scratch).
 *
 * Runs inside the tenant's context like everything else; covers only rows the
 * aggregator has reached (ingested_at <= watermark).
 */
export interface Drift {
  table: string;
  key: string;
  stored: string;
  recounted: string;
}

export async function rollupDrift(pool: Pool, tenantId: string): Promise<Drift[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const wm =
      (await c.query<{ through: Date }>('SELECT through FROM aggregation_watermarks')).rows[0]
        ?.through ?? new Date(0);
    const drift: Drift[] = [];
    const hour = `date_trunc('hour', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

    const counts = await c.query<{ k: string; stored: string | null; recounted: string | null }>(
      `WITH r AS (SELECT ${hour} AS hour, event, count(*) AS n FROM events WHERE ingested_at <= $1 GROUP BY 1, 2)
       SELECT coalesce(r.event, s.event) || '@' || coalesce(r.hour, s.hour) AS k, s.count::text AS stored, r.n::text AS recounted
         FROM r FULL JOIN event_hours s ON s.event = r.event AND s.hour = r.hour
        WHERE s.count IS DISTINCT FROM r.n`,
      [wm],
    );
    for (const r of counts.rows)
      drift.push({
        table: 'event_hours',
        key: r.k,
        stored: r.stored ?? '-',
        recounted: r.recounted ?? '-',
      });

    const dims = await c.query<{ k: string; stored: string | null; recounted: string | null }>(
      `WITH r AS (
         SELECT ${hour} AS hour, event, kv.key AS property,
                CASE jsonb_typeof(kv.value) WHEN 'string' THEN kv.value #>> '{}' ELSE kv.value::text END AS value, count(*) AS n
           FROM events CROSS JOIN LATERAL jsonb_each(properties) kv
          WHERE ingested_at <= $1 AND jsonb_typeof(kv.value) IN ('string', 'boolean') GROUP BY 1, 2, 3, 4)
       SELECT coalesce(r.event, s.event) || '.' || coalesce(r.property, s.property) || '=' || coalesce(r.value, s.value) || '@' || coalesce(r.hour, s.hour) AS k,
              s.count::text AS stored, r.n::text AS recounted
         FROM r FULL JOIN event_dim_hours s ON s.event = r.event AND s.hour = r.hour AND s.property = r.property AND s.value = r.value
        WHERE s.count IS DISTINCT FROM r.n`,
      [wm],
    );
    for (const r of dims.rows)
      drift.push({
        table: 'event_dim_hours',
        key: r.k,
        stored: r.stored ?? '-',
        recounted: r.recounted ?? '-',
      });

    const sums = await c.query<{ k: string; stored: number | null; recounted: number | null }>(
      `WITH r AS (
         SELECT ${hour} AS hour, event, kv.key AS property, sum((kv.value #>> '{}')::float8) AS total
           FROM events CROSS JOIN LATERAL jsonb_each(properties) kv
          WHERE ingested_at <= $1 AND jsonb_typeof(kv.value) = 'number' GROUP BY 1, 2, 3)
       SELECT coalesce(r.event, s.event) || '.' || coalesce(r.property, s.property) || '@' || coalesce(r.hour, s.hour) AS k, s.sum AS stored, r.total AS recounted
         FROM r FULL JOIN event_sum_hours s ON s.event = r.event AND s.hour = r.hour AND s.property = r.property
        WHERE s.sum IS NULL OR r.total IS NULL OR abs(s.sum - r.total) > 1e-6 * greatest(1, abs(r.total))`,
      [wm],
    );
    for (const r of sums.rows)
      drift.push({
        table: 'event_sum_hours',
        key: r.k,
        stored: String(r.stored ?? '-'),
        recounted: String(r.recounted ?? '-'),
      });

    // Sketches: rebuilt from scratch per (hour, event) and compared byte for byte.
    const stored = await c.query<{ hour: Date; event: string; users_hll: Buffer }>(
      'SELECT hour, event, users_hll FROM event_hours',
    );
    for (const s of stored.rows) {
      const users = await c.query<{ user_hash: Buffer }>(
        `SELECT DISTINCT user_hash FROM events WHERE ingested_at <= $1 AND event = $2 AND at >= $3 AND at < $3 + INTERVAL '1 hour'`,
        [wm, s.event, s.hour],
      );
      const sketch = emptySketch();
      for (const u of users.rows) addHash(sketch, u.user_hash);
      if (!Buffer.from(sketch).equals(s.users_hll)) {
        drift.push({
          table: 'event_hours.users_hll',
          key: `${s.event}@${s.hour.toISOString()}`,
          stored: 'sketch',
          recounted: 'different sketch',
        });
      }
    }
    await c.query('COMMIT');
    return drift;
  } finally {
    c.release();
  }
}
