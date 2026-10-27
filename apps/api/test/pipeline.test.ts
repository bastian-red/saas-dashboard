/**
 * The whole data path in one process: the real ingest handler, a real
 * aggregator pass, and the dashboard data endpoint, for a workspace whose key
 * was minted through the API.
 */
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { aggregateTenant } from '@saas/aggregator';
import { AdmissionControl, BatchWriter, buildServer, KeyDirectory } from '@saas/ingest';
import type { DashboardData, SessionUser } from '@saas/shared';

import {
  boot,
  call,
  DATABASE_URL,
  newUser,
  newWorkspace,
  REDIS_URL,
  type Harness,
} from './support';

let harness: Harness;
let owner: SessionUser;
let ingest: ReturnType<typeof buildServer>;
let pool: pg.Pool;
let redis: Redis;
let ws: { id: string; slug: string };

beforeAll(async () => {
  harness = await boot();
  owner = await newUser(harness.db, 'pipe-owner');
  ws = await newWorkspace(harness, owner, 'pipe');
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  redis = new Redis(REDIS_URL);
  ingest = buildServer({
    pool,
    redis,
    directory: new KeyDirectory(pool),
    admission: new AdmissionControl(redis),
    writer: new BatchWriter(pool, 1000),
    version: 'test',
  });
});

afterAll(async () => {
  for (const t of [
    'events',
    'event_hours',
    'event_dim_hours',
    'event_sum_hours',
    'aggregation_watermarks',
  ]) {
    await harness.db.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id = $1::uuid`, ws.id);
  }
  await harness.db.tenant.deleteMany({ where: { id: ws.id } });
  await harness.db.user.deleteMany({ where: { id: owner.id } });
  await ingest.close();
  await pool.end();
  redis.disconnect();
  await harness.close();
});

describe('events to a dashboard', () => {
  it('ingested events appear on the lanes after one aggregation pass, by breakdown, sum and unique users', async () => {
    const key = await call<{ key: string }>(harness, 'POST', `/workspaces/${ws.slug}/api-keys`, {
      user: owner,
      body: { name: 'pipe' },
    });
    // The product's own prefix, never Stripe's `sk_live_`/`sk_test_`: a customer's
    // key must not read (or scan) as a payment-provider credential.
    expect(key.body.key).toMatch(/^sk_saas_[A-Za-z0-9_-]{20,}$/u);
    const events = Array.from({ length: 30 }, (_, i) => ({
      event: 'Purchased',
      userId: `user-${String(i % 10)}`,
      timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      properties: { plan: i % 3 === 0 ? 'business' : 'team', amount: 10 },
    }));
    const r = await ingest.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${key.body.key}` },
      payload: { events },
    });
    expect(r.statusCode).toBe(202);

    // The ingest transaction committed; aggregate up to just after it.
    const pass = await aggregateTenant(pool, ws.id, new Date(Date.now() + 1000));
    expect(pass.events).toBe(30);

    const d = await call<{ id: string }>(harness, 'POST', `/workspaces/${ws.slug}/dashboards`, {
      user: owner,
      body: { name: 'Revenue' },
    });
    for (const spec of [
      { metric: 'count', event: 'Purchased', breakdown: 'plan', viz: 'stacked' },
      { metric: 'sum', event: 'Purchased', sumProperty: 'amount' },
      { metric: 'unique_users', event: 'Purchased', viz: 'number' },
      {
        metric: 'count',
        event: 'Purchased',
        filters: [{ property: 'plan', op: 'eq', value: 'business' }],
      },
    ]) {
      expect(
        (
          await call(harness, 'POST', `/workspaces/${ws.slug}/dashboards/${d.body.id}/lanes`, {
            user: owner,
            body: { spec },
          })
        ).status,
      ).toBe(201);
    }
    await call(harness, 'PATCH', `/workspaces/${ws.slug}/dashboards/${d.body.id}`, {
      user: owner,
      body: { range: '24h' },
    });
    const data = await call<DashboardData>(
      harness,
      'GET',
      `/workspaces/${ws.slug}/dashboards/${d.body.id}/data?tz=Europe/Berlin`,
      { user: owner },
    );
    expect(data.status).toBe(200);
    const [byPlan, revenue, users, filtered] = data.body.lanes;
    expect(data.body.buckets).toHaveLength(24);
    expect(byPlan!.series).toEqual(['team', 'business']);
    expect(byPlan!.total).toBe(30);
    expect(revenue!.total).toBe(300);
    expect(users!.total).toBe(10);
    expect(users!.error).toBeGreaterThan(0);
    expect(filtered!.total).toBe(10);

    const catalog = await call<{
      events: { name: string }[];
      properties: { property: string; kind: string }[];
    }>(harness, 'GET', `/workspaces/${ws.slug}/catalog`, { user: owner });
    expect(catalog.body.events.map((e) => e.name)).toEqual(['Purchased']);
    expect(catalog.body.properties.map((p) => `${p.property}:${p.kind}`).sort()).toEqual([
      'amount:number',
      'plan:string',
    ]);
  });

  it('refuses a time zone that does not exist', async () => {
    const d = await call<{ id: string }>(harness, 'POST', `/workspaces/${ws.slug}/dashboards`, {
      user: owner,
      body: { name: 'tz' },
    });
    expect(
      (
        await call(
          harness,
          'GET',
          `/workspaces/${ws.slug}/dashboards/${d.body.id}/data?tz=Mars/Base`,
          { user: owner },
        )
      ).status,
    ).toBe(400);
  });
});
