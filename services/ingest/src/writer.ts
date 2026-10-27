import type { Pool } from 'pg';

import type { Row } from './normalise';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Group-committed, durable writes.
 *
 * A workspace's writes go out in ONE transaction at a time: set the tenant
 * context, insert everything with ON CONFLICT DO NOTHING, commit. When no
 * write is running for the workspace, a request's events are written at once
 * (after one microtask, so requests that arrived in the same tick share it);
 * while one is running, everything that arrives waits and goes out together
 * in the next transaction, up to `flushRows` per transaction. Every request
 * is answered with its own share of the result only after the commit, so
 * `202 Accepted` means the events are on disk.
 *
 * Group commit rather than a timer: an idle workspace pays no waiting at all,
 * and a busy one batches exactly as much as arrived during the previous write.
 * The first version flushed on a 50 ms timer, which put a 50 ms floor under
 * every request's latency; scripts/loadtest.sh measured p50 at 72 ms.
 *
 * One transaction per WORKSPACE, never one mixing workspaces: the insert runs
 * under row-level security, and `WITH CHECK` refuses any row whose tenant_id
 * is not the one set for the transaction. A batch that mixed tenants could not
 * be written at all, which is the property working, not a limitation.
 *
 * The two `SET LOCAL ... timeout`s are part of the aggregator's correctness: it
 * reads up to "now minus 5 seconds", which is safe only if no write transaction
 * can stay open longer than that and commit rows with an older ingested_at. A
 * statement cannot run, and the transaction cannot sit idle, for more than
 * WRITE_TIMEOUT_MS (2 s), well inside SAFE_LAG_MS.
 */

export const WRITE_TIMEOUT_MS = 2000;

interface Waiter {
  rows: Row[];
  resolve: (r: { inserted: number }) => void;
  reject: (e: unknown) => void;
}

interface Lane {
  waiting: Waiter[];
  /** The write in progress for this workspace, if any. */
  running: Promise<void> | null;
}

export class BatchWriter {
  private readonly lanes = new Map<string, Lane>();

  constructor(
    private readonly pool: Pool,
    /** At most this many events in one transaction; the rest go in the next. */
    private readonly flushRows: number,
  ) {}

  /** Resolves with how many of `rows` were new (the rest were retries). */
  write(tenantId: string, rows: Row[]): Promise<{ inserted: number }> {
    return new Promise((resolve, reject) => {
      let lane = this.lanes.get(tenantId);
      if (lane === undefined) {
        lane = { waiting: [], running: null };
        this.lanes.set(tenantId, lane);
      }
      lane.waiting.push({ rows, resolve, reject });
      if (lane.running === null) this.start(tenantId, lane);
    });
  }

  /** Wait until every workspace's queue is written (graceful shutdown). */
  async flushAll(): Promise<void> {
    while ([...this.lanes.values()].some((l) => l.running !== null)) {
      await Promise.all([...this.lanes.values()].map((l) => l.running));
    }
  }

  private start(tenantId: string, lane: Lane): void {
    lane.running = (async () => {
      // One microtask: requests parsed in the same tick join this transaction.
      await Promise.resolve();
      while (lane.waiting.length > 0) {
        const take: Waiter[] = [];
        let count = 0;
        while (
          lane.waiting.length > 0 &&
          (take.length === 0 || count + lane.waiting[0]!.rows.length <= this.flushRows)
        ) {
          const w = lane.waiting.shift()!;
          take.push(w);
          count += w.rows.length;
        }
        await this.flush(tenantId, take);
      }
      lane.running = null;
      this.lanes.delete(tenantId);
    })();
  }

  private async flush(tenantId: string, waiters: Waiter[]): Promise<void> {
    const rows = waiters.flatMap((w) => w.rows);
    const client = await this.pool.connect();
    let insertedIds: Set<string>;
    try {
      // BEGIN, both timeouts and the tenant context in ONE round trip (the
      // simple protocol runs several statements per message; parameters would
      // need the extended protocol, one statement each). Measured: five
      // sequential round trips were 6.5 ms of a 13.5 ms idle request. The
      // tenant id is inlined, so it is re-validated here even though it comes
      // from the key directory (a uuid column), never from the client.
      if (!UUID.test(tenantId)) throw new Error(`not a tenant id: ${tenantId}`);
      await client.query(
        `BEGIN; SET LOCAL statement_timeout = ${String(WRITE_TIMEOUT_MS)}; ` +
          `SET LOCAL idle_in_transaction_session_timeout = ${String(WRITE_TIMEOUT_MS)}; ` +
          `SELECT set_config('app.tenant_id', '${tenantId}', true)`,
      );
      // ON CONFLICT only when a row can conflict: one with a client-sent id (a
      // retried batch). Server-generated ids are fresh v4 UUIDs, and the
      // speculative insertion ON CONFLICT needs measured at twice the cost of a
      // plain insert (2.2 ms against 1.2 ms for 25 rows).
      const retryable = rows.some((r) => r.clientId);
      const result = await client.query<{ id: string }>(
        `INSERT INTO events (tenant_id, id, at, event, user_hash, properties)
         SELECT $1::uuid, u.id, u.at, u.event, u.user_hash, u.properties
           FROM unnest($2::uuid[], $3::timestamptz[], $4::text[], $5::bytea[], $6::jsonb[])
                AS u(id, at, event, user_hash, properties)
         ${retryable ? 'ON CONFLICT DO NOTHING' : ''}
         RETURNING id`,
        [
          tenantId,
          rows.map((r) => r.id),
          rows.map((r) => r.at),
          rows.map((r) => r.event),
          rows.map((r) => r.userHash),
          rows.map((r) => JSON.stringify(r.properties)),
        ],
      );
      await client.query('COMMIT');
      insertedIds = new Set(result.rows.map((r) => r.id));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      for (const w of waiters) w.reject(error);
      return;
    }
    client.release();
    // Each stored id is claimed by exactly one waiter: two requests in one flush
    // carrying the same event id stored one row, and only one of them may report
    // it as new, or the duplicate's quota would never be refunded.
    for (const w of waiters) {
      let inserted = 0;
      for (const r of w.rows) if (insertedIds.delete(r.id)) inserted += 1;
      w.resolve({ inserted });
    }
  }
}
