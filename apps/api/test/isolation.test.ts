/**
 * SPECS outcomes 1-3: tenant isolation, proven three ways.
 *
 * 1. The live catalog: every table is either a tenant table with RLS enabled,
 *    FORCED and a policy, or an explained global one; no partition is readable
 *    directly by the app role; no function outside the audited list runs as
 *    SECURITY DEFINER.
 * 2. Raw SQL as the app role: with tenant A's context, not one of tenant B's
 *    rows is visible in any tenant table; with no context, none at all.
 * 3. Every workspace route the application actually registered (read from
 *    RouteAudit, not from a hand-written list that could miss one), called by a
 *    member of another workspace with REAL ids from this one: 404. And the
 *    whole role x route matrix: 403 exactly where the role matrix says no.
 */
import { createHash } from 'node:crypto';

import { DEFINER_FUNCTIONS, EVENT_PARTITION, GLOBAL_TABLES, TENANT_TABLES } from '@saas/db';
import { ACTIONS, can, ROLES, type Action, type Role, type SessionUser } from '@saas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RouteAudit } from '../src/tenancy/route-audit';
import { addMember, asApp, boot, call, newUser, newWorkspace, type Harness } from './support';

let harness: Harness;
let ownerA: SessionUser;
let ownerB: SessionUser;
const membersA: Partial<Record<Role, SessionUser>> = {};
let A: { id: string; slug: string };
let B: { id: string; slug: string };
/** Real ids in workspace A, so a probe is a real target, not a random 404. */
const ids: Record<string, string> = {};

beforeAll(async () => {
  harness = await boot();
  ownerA = await newUser(harness.db, 'iso-owner-a');
  ownerB = await newUser(harness.db, 'iso-owner-b');
  A = await newWorkspace(harness, ownerA, 'iso-a');
  B = await newWorkspace(harness, ownerB, 'iso-b');
  membersA.owner = ownerA;
  // Four roles need four seats; the free plan has three. Upgraded through the
  // mock checkout, which is the real signed-webhook path.
  const upgrade = await call(harness, 'POST', `/workspaces/${A.slug}/billing/mock`, {
    user: ownerA,
    body: { plan: 'team' },
  });
  if (upgrade.status !== 200) throw new Error(`upgrade: ${String(upgrade.status)} ${upgrade.text}`);
  for (const role of ['admin', 'analyst', 'viewer'] as const) {
    const u = await newUser(harness.db, `iso-${role}`);
    await addMember(harness, ownerA, A.slug, u, role);
    membersA[role] = u;
  }

  // Content in both workspaces, through the API.
  for (const [ws, owner] of [
    [A, ownerA],
    [B, ownerB],
  ] as const) {
    const d = await call<{ id: string }>(harness, 'POST', `/workspaces/${ws.slug}/dashboards`, {
      user: owner,
      body: { name: 'Main' },
    });
    const withLane = await call<{ lanes: { id: string }[] }>(
      harness,
      'POST',
      `/workspaces/${ws.slug}/dashboards/${d.body.id}/lanes`,
      {
        user: owner,
        body: { spec: { metric: 'count', event: 'Signed up' } },
      },
    );
    const key = await call<{ id: string }>(harness, 'POST', `/workspaces/${ws.slug}/api-keys`, {
      user: owner,
      body: { name: 'k' },
    });
    const invite = await call<{ id: string }>(harness, 'POST', `/workspaces/${ws.slug}/invites`, {
      user: owner,
      body: { email: `pending-${ws.slug}@saas.test`, role: 'viewer' },
    });
    if (ws === A) {
      ids.id = d.body.id;
      ids.laneId = withLane.body.lanes[0]!.id;
      ids.apiKeyId = key.body.id;
      ids.inviteId = invite.body.id;
      ids.userId = membersA.viewer!.id;
    }
    // Raw events and rollups, written as the owner (the ingest path is tested on its own).
    const uh = createHash('sha256').update(`${ws.id}|u`).digest().subarray(0, 16);
    await harness.db.$executeRawUnsafe(
      `INSERT INTO events (tenant_id, id, at, event, user_hash, properties) VALUES ($1::uuid, gen_random_uuid(), now(), 'Signed up', $2, '{"plan":"pro","amount":3}')`,
      ws.id,
      uh,
    );
    await harness.db.$executeRawUnsafe(
      `INSERT INTO event_hours (tenant_id, hour, event, count, users_hll) VALUES ($1::uuid, date_trunc('hour', now()), 'Signed up', 1, $2)`,
      ws.id,
      Buffer.alloc(2048),
    );
    await harness.db.$executeRawUnsafe(
      `INSERT INTO event_dim_hours (tenant_id, hour, event, property, value, count) VALUES ($1::uuid, date_trunc('hour', now()), 'Signed up', 'plan', 'pro', 1)`,
      ws.id,
    );
    await harness.db.$executeRawUnsafe(
      `INSERT INTO event_sum_hours (tenant_id, hour, event, property, sum) VALUES ($1::uuid, date_trunc('hour', now()), 'Signed up', 'amount', 3)`,
      ws.id,
    );
    await harness.db.$executeRawUnsafe(
      `INSERT INTO aggregation_watermarks (tenant_id, through) VALUES ($1::uuid, now())`,
      ws.id,
    );
  }
});

afterAll(async () => {
  for (const ws of [A, B]) {
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
  }
  await harness.db.user.deleteMany({ where: { email: { contains: 'iso-' } } });
  await harness.close();
});

describe('1. the live catalog', () => {
  it('classifies every table and isolates every tenant table, partitions included', async () => {
    const tables = await harness.db.$queryRaw<
      {
        name: string;
        rls: boolean;
        forced: boolean;
        policies: bigint;
        has_tenant: boolean;
        app_select: boolean;
      }[]
    >`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
             has_table_privilege('saas_app', c.oid, 'SELECT') AS app_select
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;
    expect(tables.length).toBeGreaterThan(12);
    for (const t of tables) {
      const partition = EVENT_PARTITION.test(t.name);
      const tenant = (TENANT_TABLES as readonly string[]).includes(t.name) || partition;
      expect(
        tenant || t.name in GLOBAL_TABLES,
        `${t.name} is neither a tenant table nor an explained global one`,
      ).toBe(true);
      if (t.has_tenant || tenant) {
        expect(
          t.rls && t.forced && Number(t.policies) > 0,
          `${t.name}: rls=${String(t.rls)} forced=${String(t.forced)} policies=${String(t.policies)}`,
        ).toBe(true);
      }
      if (partition)
        expect(t.app_select, `${t.name} must not be readable except through its parent`).toBe(
          false,
        );
    }
  });

  it('runs no SECURITY DEFINER function outside the audited list, and the app role cannot bypass RLS', async () => {
    const definers = await harness.db.$queryRaw<{ name: string }[]>`
      SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef`;
    expect(definers.map((d) => d.name).sort()).toEqual([...DEFINER_FUNCTIONS].sort());
    const [role] = await harness.db.$queryRaw<
      { bypass: boolean; superuser: boolean }[]
    >`SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = 'saas_app'`;
    expect(role).toEqual({ bypass: false, superuser: false });
  });
});

describe('2. raw SQL as the app role', () => {
  it.each(TENANT_TABLES)(
    '%s: tenant A sees none of B, and no context sees nothing',
    async (table) => {
      const column = table === 'tenants' ? 'id' : 'tenant_id';
      const crossed = await asApp<{ n: string }>(
        harness,
        A.id,
        `SELECT count(*) AS n FROM ${table} WHERE ${column} = $1::uuid`,
        [B.id],
      );
      expect(Number(crossed[0]!.n)).toBe(0);
      const own = await asApp<{ n: string }>(harness, A.id, `SELECT count(*) AS n FROM ${table}`);
      expect(Number(own[0]!.n)).toBeGreaterThan(0);
      const none = await asApp<{ n: string }>(harness, null, `SELECT count(*) AS n FROM ${table}`);
      expect(Number(none[0]!.n)).toBe(0);
    },
  );

  it('refuses to write a row into another tenant from inside one', async () => {
    await expect(
      asApp(
        harness,
        A.id,
        `INSERT INTO dashboards (id, tenant_id, name) VALUES ('cforged0000000000000000001', $1::uuid, 'forged')`,
        [B.id],
      ),
    ).rejects.toThrow(/row-level security/u);
  });

  it("refuses a lane on another tenant's dashboard by foreign key, even with the right tenant context", async () => {
    // The lane is B's own row (tenant_id = B, so row-level security's WITH
    // CHECK passes) but points at A's dashboard. Only the composite foreign
    // key (dashboard_id, tenant_id) -> dashboards(id, tenant_id) refuses it.
    // The first version wrote tenant_id = A, which RLS refused first, and a
    // bare toThrow() accepted that: the test stayed green with the FK dropped.
    const [aDash] = await harness.db.dashboard.findMany({ where: { tenantId: A.id } });
    expect(aDash).toBeDefined();
    await expect(
      asApp(
        harness,
        B.id,
        `INSERT INTO lanes (id, tenant_id, dashboard_id, position, spec) VALUES ('cforgedlane000000000000001', $1::uuid, $2, 9, '{}')`,
        [B.id, aDash!.id],
      ),
    ).rejects.toThrow(/lanes_dashboard_tenant_fkey/u);
  });
});

/** Fill a route's parameters with real ids from workspace A. */
function concrete(path: string): string {
  return path
    .replace(':workspace', A.slug)
    .replace(/:(\w+)/gu, (_m, name: string) => ids[name] ?? 'cmissing00000000000000000');
}

const BODIES: Record<string, unknown> = {
  'PATCH /workspaces/:workspace/members/:userId': { role: 'viewer' },
  'POST /workspaces/:workspace/invites': { email: 'probe@saas.test', role: 'viewer' },
  'POST /workspaces/:workspace/api-keys': { name: 'probe' },
  'POST /workspaces/:workspace/dashboards': { name: 'probe' },
  'PATCH /workspaces/:workspace/dashboards/:id': { name: 'probe' },
  'POST /workspaces/:workspace/dashboards/:id/lanes': { spec: { metric: 'count', event: 'x' } },
  'PUT /workspaces/:workspace/dashboards/:id/lanes/order': { order: ['cmissing00000000000000000'] },
  'PATCH /workspaces/:workspace/dashboards/:id/lanes/:laneId': { title: 'probe' },
  'POST /workspaces/:workspace/billing/checkout': { plan: 'team' },
  'POST /workspaces/:workspace/billing/mock': { plan: 'team' },
  'PUT /workspaces/:workspace/branding': { accent: '#5a4590' },
};

interface Route {
  method: string;
  path: string;
  action: Action;
}

function workspaceRoutes(): Route[] {
  // From the application's own registry, per HANDLER: method, path and action
  // together, so two handlers on one path keep their own permissions.
  return harness.app
    .get(RouteAudit)
    .routes.filter((r) => r.path.includes(':workspace'))
    .map((r) => ({ method: r.method, path: r.path, action: r.action as Action }));
}

describe('3. every workspace route', () => {
  it('found the routes from the application itself', () => {
    const routes = workspaceRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(20);
    expect(new Set(routes.map((r) => r.action)).size).toBeGreaterThanOrEqual(10);
  });

  it("answers 404 to a member of ANOTHER workspace, on every route, with this workspace's real ids", async () => {
    const leaks: string[] = [];
    for (const r of workspaceRoutes()) {
      const reply = await call(harness, r.method, concrete(r.path), {
        user: ownerB,
        body: BODIES[`${r.method} ${r.path}`],
      });
      if (reply.status !== 404) leaks.push(`${r.method} ${r.path} -> ${String(reply.status)}`);
    }
    expect(leaks).toEqual([]);
  });

  it('answers 403 exactly where the role matrix says no, for every role on every route', async () => {
    const wrong: string[] = [];
    for (const role of ROLES) {
      const user = membersA[role]!;
      for (const r of workspaceRoutes()) {
        // Destructive routes are checked for the refusal only: running them as
        // an allowed role would delete the fixtures the rest of the matrix needs.
        if (can(role, r.action) && (r.method === 'DELETE' || r.path.endsWith('/members/:userId')))
          continue;
        // Leaving is allowed to everyone; running it would remove the fixture.
        if (r.path.endsWith('/membership')) continue;
        const reply = await call(harness, r.method, concrete(r.path), {
          user,
          body: BODIES[`${r.method} ${r.path}`],
        });
        const forbidden = reply.status === 403;
        if (forbidden === can(role, r.action))
          wrong.push(`${role} ${r.method} ${r.path} -> ${String(reply.status)} (${r.action})`);
      }
    }
    expect(wrong).toEqual([]);
    // Not vacuous: every action is exercised by some route.
    const exercised = new Set(workspaceRoutes().map((r) => r.action));
    expect(ACTIONS.filter((a) => !exercised.has(a))).toEqual([]);
  });
});
