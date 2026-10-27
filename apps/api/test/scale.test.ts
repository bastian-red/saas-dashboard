/**
 * SPECS outcome 7: a dashboard of 8 lanes over 30 days of a 10,000,000-event
 * workspace answers in under 300 ms at p95.
 *
 * The rollups are generated directly at the size 10M events produce (8 events,
 * every hour of 30 days, three breakdown properties with up to 12 values each,
 * one numeric property, a HyperLogLog sketch per hour), because the raw events
 * themselves would need gigabytes this lane does not need: the dashboard never
 * reads them on the rollup path, and the aggregator's own suite proves the
 * rollups equal a recount of the raw log. What is measured here is the READ
 * path, through the real endpoint, uncached.
 */
import { randomBytes } from 'node:crypto';

import type { SessionUser } from '@saas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { boot, call, newUser, newWorkspace, type Harness } from './support';

const P95_BUDGET_MS = 300;
const RUNS = 30;
const EVENTS = [
  'Signed up',
  'Viewed page',
  'Started trial',
  'Purchased',
  'Invited teammate',
  'Exported',
  'Searched',
  'Churned',
];

let harness: Harness;
let owner: SessionUser;
let ws: { id: string; slug: string };
let dashboardId: string;

beforeAll(async () => {
  harness = await boot();
  owner = await newUser(harness.db, 'scale-owner');
  ws = await newWorkspace(harness, owner, 'scale');
  const started = Date.now();
  // ~13,900 events per hour across 8 event types over 720 hours = 10M events.
  await harness.db.$executeRawUnsafe(
    `INSERT INTO event_hours (tenant_id, hour, event, count, users_hll)
     SELECT $1::uuid, h, e, 1000 + (random() * 2500)::int, $2
       FROM generate_series(date_trunc('hour', now()) - INTERVAL '30 days', date_trunc('hour', now()), INTERVAL '1 hour') h,
            unnest($3::text[]) e`,
    ws.id,
    randomBytes(2048).map((b) => b % 18),
    EVENTS,
  );
  await harness.db.$executeRawUnsafe(
    `INSERT INTO event_dim_hours (tenant_id, hour, event, property, value, count)
     SELECT $1::uuid, h, e, p, p || '-' || v, 10 + (random() * 200)::int
       FROM generate_series(date_trunc('hour', now()) - INTERVAL '30 days', date_trunc('hour', now()), INTERVAL '1 hour') h,
            unnest($2::text[]) e, unnest(ARRAY['plan', 'country', 'device']) p, generate_series(1, 12) v`,
    ws.id,
    EVENTS,
  );
  await harness.db.$executeRawUnsafe(
    `INSERT INTO event_sum_hours (tenant_id, hour, event, property, sum)
     SELECT $1::uuid, h, e, 'amount', random() * 50000
       FROM generate_series(date_trunc('hour', now()) - INTERVAL '30 days', date_trunc('hour', now()), INTERVAL '1 hour') h, unnest($2::text[]) e`,
    ws.id,
    EVENTS,
  );
  for (const t of ['event_hours', 'event_dim_hours', 'event_sum_hours'])
    await harness.db.$executeRawUnsafe(`ANALYZE ${t}`);
  const n =
    (
      await harness.db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT sum(count)::float8 AS n FROM event_hours WHERE tenant_id = $1::uuid`,
        ws.id,
      )
    )[0]?.n ?? 0;
  console.log(
    `[scale] rollups for ${Math.round(n / 1e6).toString()}M events generated in ${String(Date.now() - started)} ms`,
  );

  const d = await call<{ id: string }>(harness, 'POST', `/workspaces/${ws.slug}/dashboards`, {
    user: owner,
    body: { name: 'Everything' },
  });
  dashboardId = d.body.id;
  await call(harness, 'PATCH', `/workspaces/${ws.slug}/dashboards/${dashboardId}`, {
    user: owner,
    body: { range: '30d' },
  });
  const lanes = [
    { metric: 'count', event: 'Signed up' },
    { metric: 'count', event: 'Viewed page', breakdown: 'country', viz: 'stacked' },
    { metric: 'unique_users', event: 'Viewed page', viz: 'number' },
    { metric: 'sum', event: 'Purchased', sumProperty: 'amount' },
    { metric: 'count', event: 'Started trial', breakdown: 'plan' },
    { metric: 'unique_users', event: 'Signed up' },
    { metric: 'count', event: 'Searched', breakdown: 'device', viz: 'stacked' },
    { metric: 'count', event: 'Churned', viz: 'number' },
  ];
  for (const spec of lanes)
    await call(harness, 'POST', `/workspaces/${ws.slug}/dashboards/${dashboardId}/lanes`, {
      user: owner,
      body: { spec },
    });
}, 300_000);

afterAll(async () => {
  for (const t of ['event_hours', 'event_dim_hours', 'event_sum_hours'])
    await harness.db.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id = $1::uuid`, ws.id);
  await harness.db.tenant.deleteMany({ where: { id: ws.id } });
  await harness.db.user.deleteMany({ where: { id: owner.id } });
  await harness.close();
}, 120_000);

describe('an 8-lane dashboard over 10M events', () => {
  it(`answers in under ${String(P95_BUDGET_MS)} ms at p95, through the endpoint`, async () => {
    const timings: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const started = performance.now();
      const r = await call<{ lanes: unknown[] }>(
        harness,
        'GET',
        `/workspaces/${ws.slug}/dashboards/${dashboardId}/data?tz=${i % 2 === 0 ? 'UTC' : 'America/Santiago'}`,
        { user: owner },
      );
      timings.push(performance.now() - started);
      expect(r.status).toBe(200);
      expect(r.body.lanes).toHaveLength(8);
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(RUNS / 2)]!;
    const p95 = timings[Math.ceil(RUNS * 0.95) - 1]!;
    console.log(
      `[scale] ${String(RUNS)} dashboards: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});
