/**
 * The aggregator against real Postgres as saas_app: incremental passes add up
 * to a recount, a second pass over the same window adds nothing, two tenants
 * never mix, and a backlog spread over many passes still equals the truth.
 */
import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { estimate } from '@saas/query-engine';

import { aggregateTenant, pendingTenants, safeUpto } from '../src/aggregate';
import { rollupDrift } from '../src/recount';

const APP_URL = process.env.DATABASE_URL ?? '';
const OWNER_URL = process.env.DIRECT_DATABASE_URL ?? '';

let app: pg.Pool;
let owner: pg.Pool;
const tenants: string[] = [];

async function tenant(): Promise<string> {
  const id = randomUUID();
  await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
    id,
    `agg-${id.slice(0, 8)}`,
    'Agg',
  ]);
  tenants.push(id);
  return id;
}

/** Insert events as the owner with an explicit ingested_at, so windows are controlled. */
async function insert(
  tenantId: string,
  n: number,
  ingestedAt: Date,
  at = new Date(ingestedAt.getTime() - 60_000),
): Promise<void> {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: randomUUID(),
    event: i % 3 === 0 ? 'Paid' : 'Signed up',
    user: createHash('sha256')
      .update(`${tenantId}|u${String(i % 40)}`)
      .digest()
      .subarray(0, 16),
    props: JSON.stringify({
      plan: ['free', 'team', 'business'][i % 3],
      amount: i % 3 === 0 ? 10 + i : undefined,
      trial: i % 2 === 0,
    }),
  }));
  await owner.query(
    `INSERT INTO events (tenant_id, id, at, ingested_at, event, user_hash, properties)
     SELECT $1, u.id, $2, $3, u.event, u.uh, u.p::jsonb FROM unnest($4::uuid[], $5::text[], $6::bytea[], $7::text[]) AS u(id, event, uh, p)`,
    [
      tenantId,
      at,
      ingestedAt,
      rows.map((r) => r.id),
      rows.map((r) => r.event),
      rows.map((r) => r.user),
      rows.map((r) => r.props),
    ],
  );
}

async function readAs<T extends pg.QueryResultRow>(tenantId: string, sql: string): Promise<T[]> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query<T>(sql);
    await c.query('COMMIT');
    return r.rows;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  if (APP_URL === '' || OWNER_URL === '') throw new Error('Run through ./scripts/integration.sh');
  app = new pg.Pool({ connectionString: APP_URL, max: 4 });
  owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
});

afterAll(async () => {
  await owner.query('DELETE FROM events WHERE tenant_id = ANY($1::uuid[])', [tenants]);
  await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
  await Promise.all([app.end(), owner.end()]);
});

describe('incremental aggregation', () => {
  it('three passes over a growing log add up to a recount, sketches included', async () => {
    const t = await tenant();
    const base = Date.now() - 600_000;
    for (let pass = 0; pass < 3; pass += 1) {
      await insert(t, 120, new Date(base + pass * 60_000));
      const r = await aggregateTenant(app, t, new Date(base + pass * 60_000 + 1));
      expect(r.events).toBe(120);
    }
    expect(await rollupDrift(app, t)).toEqual([]);
    const [row] = await readAs<{ n: string; users_hll: Buffer }>(
      t,
      `SELECT sum(count)::text AS n, (array_agg(users_hll))[1] AS users_hll FROM event_hours WHERE event = 'Signed up'`,
    );
    expect(Number(row!.n)).toBe(240);
    expect(estimate(new Uint8Array(row!.users_hll))).toBeGreaterThan(20);
  });

  it('a second pass over the same window adds nothing', async () => {
    const t = await tenant();
    const at = new Date(Date.now() - 300_000);
    await insert(t, 50, at);
    const upto = new Date(at.getTime() + 1);
    expect((await aggregateTenant(app, t, upto)).events).toBe(50);
    expect((await aggregateTenant(app, t, upto)).events).toBe(0);
    expect(await rollupDrift(app, t)).toEqual([]);
  });

  it('never reads or writes another tenant, and the pending list names only tenants with new events', async () => {
    const a = await tenant();
    const b = await tenant();
    const at = new Date(Date.now() - 120_000);
    await insert(a, 30, at);
    await insert(b, 70, at);
    expect(await pendingTenants(app, await safeUpto(app))).toEqual(expect.arrayContaining([a, b]));
    await aggregateTenant(app, a, await safeUpto(app));
    const aCount = await readAs<{ n: string }>(
      a,
      'SELECT coalesce(sum(count), 0)::text AS n FROM event_hours',
    );
    const bCount = await readAs<{ n: string }>(
      b,
      'SELECT coalesce(sum(count), 0)::text AS n FROM event_hours',
    );
    expect(Number(aCount[0]!.n)).toBe(30);
    expect(Number(bCount[0]!.n)).toBe(0);
    expect(await pendingTenants(app, await safeUpto(app))).not.toContain(a);
  });

  it('two concurrent passes over one tenant: one does the work, the other skips', async () => {
    const t = await tenant();
    await insert(t, 200, new Date(Date.now() - 60_000));
    const upto = await safeUpto(app);
    const [x, y] = await Promise.all([
      aggregateTenant(app, t, upto),
      aggregateTenant(app, t, upto),
    ]);
    expect([x.events + y.events]).toEqual([200]);
    expect(await rollupDrift(app, t)).toEqual([]);
  });
});
