/**
 * The ingest service against real Postgres (as saas_app) and real Redis,
 * in-process through Fastify's inject: no port, the same handler.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PLANS } from '@saas/shared';

import { AdmissionControl, quotaKey } from '../src/admission';
import { INVALIDATE_CHANNEL, KeyDirectory } from '../src/directory';
import { hashKey } from '../src/normalise';
import { buildServer } from '../src/server';
import { BatchWriter } from '../src/writer';

const APP_URL = process.env.DATABASE_URL ?? '';
const OWNER_URL = process.env.DIRECT_DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';

let app: ReturnType<typeof buildServer>;
let appPool: pg.Pool;
let owner: pg.Pool;
let redis: Redis;
let directory: KeyDirectory;
const tenants: string[] = [];

/** A workspace and a key, created as the owner (setup is not under test). */
async function workspace(plan = 'free'): Promise<{ tenantId: string; key: string }> {
  const tenantId = randomUUID();
  const key = `sk_test_${randomBytes(18).toString('base64url')}`;
  await owner.query(
    'INSERT INTO tenants (id, slug, name, plan, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [tenantId, `t-${tenantId.slice(0, 8)}`, 'Test', plan, plan === 'free' ? null : 'active'],
  );
  await owner.query(
    'INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4, $5)',
    [
      `ck${randomUUID().replaceAll('-', '').slice(0, 23)}`,
      tenantId,
      'test',
      key.slice(0, 12),
      hashKey(key),
    ],
  );
  tenants.push(tenantId);
  return { tenantId, key };
}

const send = (key: string, events: unknown[]) =>
  app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: { authorization: `Bearer ${key}` },
    payload: { events },
  });

const ev = (i: number, extra: Record<string, unknown> = {}) => ({
  event: 'Signed up',
  userId: `u${String(i)}`,
  properties: { plan: 'pro' },
  ...extra,
});

async function countAs(tenantId: string | null): Promise<number> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId !== null)
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM events');
    await c.query('COMMIT');
    return Number(rows[0]!.n);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  if (APP_URL === '' || OWNER_URL === '' || REDIS_URL === '')
    throw new Error('Run through ./scripts/integration.sh');
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });
  owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
  redis = new Redis(REDIS_URL);
  directory = new KeyDirectory(appPool);
  app = buildServer({
    pool: appPool,
    redis,
    directory,
    admission: new AdmissionControl(redis),
    writer: new BatchWriter(appPool, 1000),
    version: 'test',
  });
});

afterAll(async () => {
  await owner.query('DELETE FROM events WHERE tenant_id = ANY($1::uuid[])', [tenants]);
  await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
  await app.close();
  await Promise.all([appPool.end(), owner.end()]);
  redis.disconnect();
});

describe('a batch', () => {
  it('is stored under its own workspace only, and 202 means it is already on disk', async () => {
    const a = await workspace();
    const b = await workspace();
    const r = await send(a.key, [ev(1), ev(2), ev(3)]);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({
      accepted: 3,
      duplicates: 0,
      remainingThisMonth: PLANS.free.monthlyEvents - 3,
    });
    expect(await countAs(a.tenantId)).toBe(3);
    expect(await countAs(b.tenantId)).toBe(0);
    expect(await countAs(null)).toBe(0);
  });

  it('retried with the same ids is stored once and charged once', async () => {
    const a = await workspace();
    const timestamp = new Date().toISOString();
    const events = [ev(1, { id: randomUUID(), timestamp }), ev(2, { id: randomUUID(), timestamp })];
    expect((await send(a.key, events)).json()).toMatchObject({ accepted: 2, duplicates: 0 });
    expect((await send(a.key, events)).json()).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(await countAs(a.tenantId)).toBe(2);
    expect(Number(await redis.get(quotaKey(a.tenantId, new Date())))).toBe(2);
  });

  it('with one invalid event stores nothing and charges nothing', async () => {
    const a = await workspace();
    const r = await send(a.key, [ev(1), ev(2, { timestamp: '2020-01-01T00:00:00Z' })]);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'INVALID', events: [{ index: 1 }] });
    expect(await countAs(a.tenantId)).toBe(0);
    expect(await redis.get(quotaKey(a.tenantId, new Date()))).toBeNull();
  });

  it('with an id but no timestamp is refused, because it could not be recognised on retry', async () => {
    const a = await workspace();
    const r = await send(a.key, [ev(1, { id: randomUUID() })]);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'INVALID', fields: ['events.0.timestamp'] });
  });

  it('with an unknown key or no key is refused', async () => {
    expect((await send('sk_test_nonexistent_key_000000000', [ev(1)])).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/events', payload: { events: [ev(1)] } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('the monthly quota (SPECS outcome 6)', () => {
  it('is exact under concurrency: of 20 batches of 10 straddling the limit, exactly 5 fit', async () => {
    const a = await workspace();
    const key = quotaKey(a.tenantId, new Date());
    await redis.set(key, String(PLANS.free.monthlyEvents - 50));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        send(
          a.key,
          Array.from({ length: 10 }, (_, j) => ev(i * 10 + j)),
        ),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    // The rate limit (free: 20 events/s, burst one maximal batch of 500) admits
    // all 200 events; the quota decides.
    expect(codes.filter((c) => c === 202)).toHaveLength(5);
    expect(codes.filter((c) => c === 402)).toHaveLength(15);
    expect(Number(await redis.get(key))).toBe(PLANS.free.monthlyEvents);
    expect(await countAs(a.tenantId)).toBe(50);
  });

  it('is lifted the moment the plan changes, without waiting for the key cache', async () => {
    const a = await workspace();
    await redis.set(quotaKey(a.tenantId, new Date()), String(PLANS.free.monthlyEvents));
    expect((await send(a.key, [ev(1)])).statusCode).toBe(402);
    await owner.query(
      "UPDATE tenants SET plan = 'team', subscription_status = 'active' WHERE id = $1",
      [a.tenantId],
    );
    // What the API does on a plan change; main.ts wires this channel to the directory.
    directory.invalidateTenant(a.tenantId);
    expect(INVALIDATE_CHANNEL).toBe('ingest:invalidate');
    expect((await send(a.key, [ev(1)])).statusCode).toBe(202);
  });
});

describe('the per-workspace rate limit', () => {
  it('counts EVENTS, not requests: one maximal batch fits a Free burst, the next is refused', async () => {
    // Regression: charged per request, a Free workspace (20 events/s) could
    // send 20 batches of 500 every second. scripts/loadtest.sh found it.
    const a = await workspace();
    const full = (offset: number) => Array.from({ length: 500 }, (_, i) => ev(offset + i));
    expect((await send(a.key, full(0))).statusCode).toBe(202);
    const second = await send(a.key, full(500));
    expect(second.statusCode).toBe(429);
    // 500 events at 20/s is 25 s of allowance to earn back.
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(20);
  });

  it('refuses with Retry-After past the burst, and another workspace is unaffected', async () => {
    const a = await workspace();
    const b = await workspace();
    // 30 batches of 25 = 750 events against a burst of 500.
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        send(
          a.key,
          Array.from({ length: 25 }, (_, j) => ev(i * 25 + j)),
        ),
      ),
    );
    const limited = results.filter((r) => r.statusCode === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(Number(limited[0]!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await send(b.key, [ev(1)])).statusCode).toBe(202);
  });
});
