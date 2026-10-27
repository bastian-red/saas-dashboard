import type { Pool, PoolClient } from 'pg';

import { addHash, emptySketch, mergeInto } from '@saas/query-engine';

/**
 * One aggregation pass over one workspace: everything ingested after its
 * watermark and up to `upto`, folded into the hourly rollups, and the watermark
 * moved to `upto`, in ONE transaction inside the tenant's RLS context.
 *
 * Exactly once, by construction:
 *
 * - The rollups and the watermark commit together, so a crash re-reads the
 *   same window and nothing was half-applied.
 * - `upto` trails the clock by SAFE_LAG_MS. `ingested_at` is set when the
 *   ingest transaction BEGINS, so a row is invisible until that transaction
 *   commits; the window only reaches rows whose transactions have certainly
 *   committed, because ingest bounds every write transaction to well under the
 *   lag (writer.ts: statement and idle-in-transaction timeouts of 2 s).
 * - A transaction-scoped advisory lock per tenant means two aggregator
 *   instances never process one workspace at once; the second skips it.
 *
 * Counts, breakdowns and sums are aggregated by Postgres. Unique users are
 * HyperLogLog sketches: the pass reads each (hour, event)'s DISTINCT user
 * hashes and folds them into the stored sketch, which merges exactly.
 */

export const SAFE_LAG_MS = 5_000;

export interface PassResult {
  tenantId: string;
  skipped: boolean;
  events: number;
  hours: number;
}

const WINDOW = `ingested_at > $1 AND ingested_at <= $2`;

export async function aggregateTenant(
  pool: Pool,
  tenantId: string,
  upto: Date,
): Promise<PassResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const lock = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('aggregate:' || $1)) AS ok",
      [tenantId],
    );
    if (!lock.rows[0]!.ok) {
      await c.query('ROLLBACK');
      return { tenantId, skipped: true, events: 0, hours: 0 };
    }
    const wm = await c.query<{ through: Date }>('SELECT through FROM aggregation_watermarks');
    const from = wm.rows[0]?.through ?? new Date(0);
    if (from >= upto) {
      await c.query('ROLLBACK');
      return { tenantId, skipped: false, events: 0, hours: 0 };
    }
    const params = [from, upto];

    // Breakdowns: every string or boolean property, one row per value.
    await c.query(
      `INSERT INTO event_dim_hours (tenant_id, hour, event, property, value, count)
       SELECT app_current_tenant(), date_trunc('hour', e.at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', e.event, kv.key,
              CASE jsonb_typeof(kv.value) WHEN 'string' THEN kv.value #>> '{}' ELSE kv.value::text END, count(*)
         FROM events e CROSS JOIN LATERAL jsonb_each(e.properties) kv
        WHERE ${WINDOW} AND jsonb_typeof(kv.value) IN ('string', 'boolean')
        GROUP BY 2, 3, 4, 5
        ORDER BY 2, 3, 4, 5
       ON CONFLICT (tenant_id, event, property, hour, value) DO UPDATE SET count = event_dim_hours.count + EXCLUDED.count`,
      params,
    );
    // Sums of numeric properties.
    await c.query(
      `INSERT INTO event_sum_hours (tenant_id, hour, event, property, sum)
       SELECT app_current_tenant(), date_trunc('hour', e.at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', e.event, kv.key, sum((kv.value #>> '{}')::float8)
         FROM events e CROSS JOIN LATERAL jsonb_each(e.properties) kv
        WHERE ${WINDOW} AND jsonb_typeof(kv.value) = 'number'
        GROUP BY 2, 3, 4
        ORDER BY 2, 3, 4
       ON CONFLICT (tenant_id, event, property, hour) DO UPDATE SET sum = event_sum_hours.sum + EXCLUDED.sum`,
      params,
    );

    // Counts and sketches, per (hour, event) touched by the window.
    const touched = await c.query<{ hour: Date; event: string; n: string }>(
      `SELECT date_trunc('hour', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour, event, count(*) AS n
         FROM events WHERE ${WINDOW} GROUP BY 1, 2 ORDER BY 1, 2`,
      params,
    );
    let events = 0;
    for (const t of touched.rows) {
      events += Number(t.n);
      const sketch = await sketchFor(c, t.hour, t.event, from, upto);
      await c.query(
        `INSERT INTO event_hours (tenant_id, hour, event, count, users_hll) VALUES (app_current_tenant(), $1, $2, $3, $4)
         ON CONFLICT (tenant_id, event, hour) DO UPDATE SET count = event_hours.count + EXCLUDED.count, users_hll = $5`,
        [t.hour, t.event, Number(t.n), Buffer.from(sketch.fresh), Buffer.from(sketch.merged)],
      );
    }

    await c.query(
      `INSERT INTO aggregation_watermarks (tenant_id, through) VALUES (app_current_tenant(), $1)
       ON CONFLICT (tenant_id) DO UPDATE SET through = EXCLUDED.through`,
      [upto],
    );
    await c.query('COMMIT');
    return { tenantId, skipped: false, events, hours: touched.rows.length };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** The window's users for one (hour, event): alone (for a new row) and merged into the stored sketch. */
async function sketchFor(
  c: PoolClient,
  hour: Date,
  event: string,
  from: Date,
  upto: Date,
): Promise<{ fresh: Uint8Array; merged: Uint8Array }> {
  const users = await c.query<{ user_hash: Buffer }>(
    `SELECT DISTINCT user_hash FROM events
      WHERE ${WINDOW} AND event = $3 AND at >= $4 AND at < $4 + INTERVAL '1 hour'`,
    [from, upto, event, hour],
  );
  const fresh = emptySketch();
  for (const u of users.rows) addHash(fresh, u.user_hash);
  // FOR UPDATE: the stored sketch is read and rewritten in this transaction.
  const stored = await c.query<{ users_hll: Buffer }>(
    'SELECT users_hll FROM event_hours WHERE event = $1 AND hour = $2 FOR UPDATE',
    [event, hour],
  );
  const merged = Uint8Array.from(fresh);
  if (stored.rows[0] !== undefined) mergeInto(merged, new Uint8Array(stored.rows[0].users_hll));
  return { fresh, merged };
}

/** The tenants with anything to aggregate up to `upto`, via the audited definer function. */
export async function pendingTenants(pool: Pool, upto: Date): Promise<string[]> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM tenants_pending_aggregation($1)',
    [upto],
  );
  return rows.map((r) => r.tenant_id);
}

/** The safe upper bound of a pass, from the DATABASE clock (ingested_at is the database's clock too). */
export async function safeUpto(pool: Pool): Promise<Date> {
  const { rows } = await pool.query<{ upto: Date }>(
    `SELECT now() - make_interval(secs => $1::float8 / 1000) AS upto`,
    [SAFE_LAG_MS],
  );
  return rows[0]!.upto;
}
