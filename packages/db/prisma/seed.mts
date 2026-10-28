/**
 * The demo: two workspaces, three people, and about 100,000 product events over
 * the last 90 days, rolled up and ready to chart.
 *
 * Five properties, each with the mechanism that holds it:
 *
 * 1. **The events go through production code.** Every synthetic event is hashed
 *    by ingest's own `userHash` and written by its `BatchWriter` (the same
 *    transaction, under the same row-level security, that a real POST takes),
 *    then folded into rollups by the aggregator's own `aggregateTenant`. The
 *    numbers on the dashboards are real rollups, and `scripts/seed-check.sh`
 *    proves they equal a recount.
 * 2. **It is deterministic relative to its anchor.** A seeded PRNG and a fixed
 *    anchor (the current UTC hour) make every run within the same hour produce
 *    the same rows; across hours, the same rows shifted in time. Anchoring to
 *    "now" is deliberate: a dashboard seeded with September's events shows an
 *    empty "last 7 days" to anyone who clones the repo in November.
 * 3. **It is idempotent and touches only its own rows.** It deletes its two
 *    workspaces (by fixed id, inside each one's own tenant context, events and
 *    rollups included) and its three users, then recreates everything.
 * 4. **It connects as `saas_app`**, like every service. It cannot see or touch
 *    any other workspace on the database, by the same policies the app runs
 *    under.
 * 5. **The constants are readable from outside.** `scripts/seed-check.sh`,
 *    `scripts/dev-smoke.sh` and the E2E suite `sed` the `const NAME = '...'`
 *    lines below. One line each, single quotes, no template literals.
 *
 * DEMO_API_KEY is a local development key for a local database, published on
 * purpose so `scripts/dev-smoke.sh` and the README's curl example work on a
 * fresh clone. It authenticates nothing anywhere else.
 */
import pg from 'pg';

import { aggregateTenant } from '@saas/aggregator';
import { checkAccent } from '@saas/branding';
import { BatchWriter, hashKey, userHash, type Row } from '@saas/ingest';
import { laneSpecSchema, type LaneSpec } from '@saas/shared';
import { hashPassword } from '@saas/shared/server';

const DEMO_EMAIL = 'sam@fieldnote.test';
const DEMO_PASSWORD = 'demo-password-2026';
const DEMO_NAME = 'Sam Okafor';
const VIEWER_EMAIL = 'rui@fieldnote.test';
const VIEWER_PASSWORD = 'viewer-password-2026';
const VIEWER_NAME = 'Rui Tanaka';
const OUTSIDER_EMAIL = 'jo@harbor.test';
const OUTSIDER_PASSWORD = 'outsider-password-2026';
const OUTSIDER_NAME = 'Jo Lindqvist';
const MAIN_SLUG = 'fieldnote';
const MAIN_NAME = 'Fieldnote';
const MAIN_TENANT = '6f1e2c3a-0b5d-4e8f-9a1b-2c3d4e5f6a70';
const SECOND_SLUG = 'harbor-labs';
const SECOND_NAME = 'Harbor Labs';
const SECOND_TENANT = '7a2f3d4b-1c6e-4f90-8b2c-3d4e5f6a7b81';
const SECOND_ACCENT = '#b11f57';
const HERO_DASHBOARD = 'Product health';
const DEMO_API_KEY = 'sk_demo_fieldnote_local_dev_only_0000';

/** Window of synthetic traffic, ending at the anchor. */
const DAYS = 90;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ANCHOR = new Date(Math.floor(Date.now() / HOUR) * HOUR);

/** Same shape as cuid(): 25 lowercase alphanumerics, so every contract accepts it. */
function seedId(kind: string, name: string): string {
  return `c${kind}${name}${'0'.repeat(40)}`.slice(0, 25);
}

const USERS = [
  { id: seedId('user', 'sam'), email: DEMO_EMAIL, name: DEMO_NAME, password: DEMO_PASSWORD },
  { id: seedId('user', 'rui'), email: VIEWER_EMAIL, name: VIEWER_NAME, password: VIEWER_PASSWORD },
  {
    id: seedId('user', 'jo'),
    email: OUTSIDER_EMAIL,
    name: OUTSIDER_NAME,
    password: OUTSIDER_PASSWORD,
  },
];

interface SeedDashboard {
  name: string;
  range: '24h' | '7d' | '30d' | '90d';
  lanes: {
    title: string;
    height?: number;
    spec: Partial<LaneSpec> & Pick<LaneSpec, 'metric' | 'event'>;
  }[];
}

interface SeedWorkspace {
  id: string;
  slug: string;
  name: string;
  plan: 'team' | 'business';
  accent: string | null;
  members: [userIndex: number, role: 'owner' | 'admin' | 'analyst' | 'viewer'][];
  /** Traffic scale relative to the main workspace. */
  scale: number;
  /** Distinct people in the product at the start and at the end of the window. */
  users: [number, number];
  apiKey: string | null;
  dashboards: SeedDashboard[];
}

const WORKSPACES: SeedWorkspace[] = [
  {
    id: MAIN_TENANT,
    slug: MAIN_SLUG,
    name: MAIN_NAME,
    plan: 'business',
    accent: null,
    members: [
      [0, 'owner'],
      [1, 'viewer'],
    ],
    scale: 1,
    users: [1800, 5200],
    apiKey: DEMO_API_KEY,
    dashboards: [
      {
        name: HERO_DASHBOARD,
        range: '30d',
        lanes: [
          {
            title: 'Active users',
            spec: { metric: 'unique_users', event: 'page_viewed', viz: 'line' },
          },
          {
            title: 'Sign-ups by source',
            spec: { metric: 'count', event: 'signed_up', breakdown: 'source', viz: 'stacked' },
          },
          {
            title: 'Revenue booked (USD)',
            height: 14,
            spec: {
              metric: 'sum',
              event: 'checkout_completed',
              sumProperty: 'amount',
              viz: 'number',
            },
          },
          {
            title: 'Projects created by template',
            spec: { metric: 'count', event: 'project_created', breakdown: 'template', viz: 'line' },
          },
          {
            title: 'Business upgrades',
            spec: {
              metric: 'count',
              event: 'checkout_completed',
              filters: [{ property: 'plan', op: 'eq', value: 'business' }],
              viz: 'line',
            },
          },
          {
            title: 'Page views by device',
            spec: { metric: 'count', event: 'page_viewed', breakdown: 'device', viz: 'table' },
          },
        ],
      },
      {
        name: 'Growth, last quarter',
        range: '90d',
        lanes: [
          { title: 'Sign-ups', spec: { metric: 'count', event: 'signed_up', viz: 'line' } },
          {
            title: 'People signing up',
            spec: { metric: 'unique_users', event: 'signed_up', viz: 'number' },
          },
          {
            title: 'Checkouts by plan',
            spec: {
              metric: 'count',
              event: 'checkout_completed',
              breakdown: 'plan',
              viz: 'stacked',
            },
          },
        ],
      },
    ],
  },
  {
    id: SECOND_TENANT,
    slug: SECOND_SLUG,
    name: SECOND_NAME,
    plan: 'team',
    accent: SECOND_ACCENT,
    members: [
      [2, 'owner'],
      [0, 'analyst'],
    ],
    scale: 0.2,
    users: [300, 900],
    apiKey: null,
    dashboards: [
      {
        name: 'This week',
        range: '7d',
        lanes: [
          { title: 'Page views', spec: { metric: 'count', event: 'page_viewed', viz: 'line' } },
          {
            title: 'Active users',
            spec: { metric: 'unique_users', event: 'page_viewed', viz: 'number' },
          },
        ],
      },
    ],
  },
];

// --- deterministic randomness ----------------------------------------------------

/** mulberry32: small, fast, and good enough for synthetic traffic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rand: () => number, weighted: readonly [T, number][]): T {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [value, weight] of weighted) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return weighted[weighted.length - 1]![0];
}

/** A version-4-shaped UUID from the PRNG, so event ids are reproducible. */
function seedUuid(rand: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Math.floor(rand() * 4)]!;
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** UTC hour-of-day weights: a team spread from the Americas to Europe. */
const DIURNAL = [3, 2, 2, 2, 2, 3, 5, 8, 11, 13, 14, 14, 13, 14, 15, 15, 14, 12, 10, 8, 7, 6, 5, 4];
const DIURNAL_MEAN = DIURNAL.reduce((a, b) => a + b, 0) / DIURNAL.length;

/** Expected events per day at full scale, before the weekly cycle and growth. */
const DAILY = {
  page_viewed: 760,
  project_created: 55,
  signed_up: 34,
  checkout_completed: 3.2,
} as const;

const PATHS: [string, number][] = [
  ['/projects', 40],
  ['/board', 25],
  ['/reports', 15],
  ['/settings', 8],
  ['/billing', 4],
  ['/', 8],
];
const DEVICES: [string, number][] = [
  ['desktop', 66],
  ['mobile', 27],
  ['tablet', 7],
];
const SOURCES: [string, number][] = [
  ['organic', 44],
  ['referral', 22],
  ['ads', 18],
  ['partner', 9],
  ['newsletter', 7],
];
const TEMPLATES: [string, number][] = [
  ['blank', 38],
  ['kanban', 30],
  ['roadmap', 18],
  ['okr', 9],
  ['retro', 5],
];

function generate(ws: SeedWorkspace, seed: number): Row[] {
  const rand = prng(seed);
  const start = ANCHOR.getTime() - DAYS * DAY;
  const rows: Row[] = [];
  let newcomers = 0;
  for (let h = 0; h < DAYS * 24; h += 1) {
    const at0 = start + h * HOUR;
    const day = Math.floor(h / 24);
    const weekday = new Date(at0).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.45 : 1;
    // Steady growth, and a launch on day 62 whose bump decays over a week.
    const growth = 0.75 + 0.5 * (day / DAYS) + (day >= 62 ? 0.9 * Math.exp(-(day - 62) / 5) : 0);
    const shape = (DIURNAL[h % 24]! / DIURNAL_MEAN / 24) * weekend * growth * ws.scale;
    const pool = Math.round(ws.users[0] + ((ws.users[1] - ws.users[0]) * day) / DAYS);
    // A synthetic incident across the last 48 hours before the anchor, so the
    // dashboard's roll call has something real to call (in any time zone,
    // "yesterday" falls inside it): a partner post more than doubles sign-ups,
    // which the roll call calls Up (e2e/tests/rollcall.spec.ts), and checkout
    // breaks (a tenth of the usual checkouts). One day of no revenue stays
    // Steady on purpose: daily revenue already swings from 0 to about 1.2K, and
    // the lane shows that band, so the verdict can be checked by eye.
    const incident = h >= (DAYS - 2) * 24;
    const incidentRate: Partial<Record<keyof typeof DAILY, number>> = incident
      ? { checkout_completed: 0.1, signed_up: 2.4 }
      : {};

    for (const [event, perDay] of Object.entries(DAILY) as [keyof typeof DAILY, number][]) {
      const expected =
        perDay *
        shape *
        (event === 'signed_up' && day >= 62 && day < 69 ? 1.6 : 1) *
        (incidentRate[event] ?? 1);
      const n = Math.floor(expected + rand());
      for (let i = 0; i < n; i += 1) {
        const at = new Date(at0 + Math.floor(rand() * HOUR));
        // Activity is skewed: a few people use the product a lot.
        const person =
          event === 'signed_up'
            ? `new-${String(seed)}-${String((newcomers += 1))}`
            : `user-${String(Math.floor(rand() ** 1.8 * pool))}`;
        let properties: Row['properties'];
        if (event === 'page_viewed')
          properties = { path: pick(rand, PATHS), device: pick(rand, DEVICES) };
        else if (event === 'project_created') properties = { template: pick(rand, TEMPLATES) };
        else if (event === 'signed_up') properties = { source: pick(rand, SOURCES) };
        else {
          const plan = pick(rand, [
            ['team', 78],
            ['business', 22],
          ] as [string, number][]);
          const annual = rand() < 0.3;
          const monthly = plan === 'team' ? 49 : 299;
          properties = { plan, annual, amount: annual ? monthly * 10 : monthly };
        }
        rows.push({
          id: seedUuid(rand),
          clientId: true,
          at,
          event,
          userHash: userHash(ws.id, person),
          properties,
        });
      }
    }
  }
  return rows;
}

// --- writing -----------------------------------------------------------------------

async function inTenant<T>(
  client: pg.PoolClient,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function teardown(client: pg.PoolClient): Promise<void> {
  for (const ws of WORKSPACES) {
    await inTenant(client, ws.id, async () => {
      for (const table of [
        'events',
        'event_hours',
        'event_dim_hours',
        'event_sum_hours',
        'aggregation_watermarks',
      ]) {
        await client.query(`DELETE FROM ${table}`);
      }
      // Cascades to memberships, invites, keys, dashboards and lanes.
      await client.query('DELETE FROM tenants');
    });
  }
  await client.query('DELETE FROM users WHERE id = ANY($1) OR email = ANY($2)', [
    USERS.map((u) => u.id),
    USERS.map((u) => u.email),
  ]);
}

async function createWorkspace(client: pg.PoolClient, ws: SeedWorkspace): Promise<void> {
  let branding: string | null = null;
  if (ws.accent !== null) {
    const result = checkAccent(ws.accent);
    if (!result.ok)
      throw new Error(`seed accent ${ws.accent} is refused: ${result.issues.join('; ')}`);
    // Exactly the shape BillingService.setBranding stores; the API reads anything else as no branding.
    branding = JSON.stringify({
      accent: ws.accent.toLowerCase(),
      light: result.light,
      dark: result.dark,
    });
  }
  await inTenant(client, ws.id, async () => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, plan, subscription_status, provider_customer_id, provider_subscription_id,
                            current_period_end, subscription_updated_at, branding, created_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9::jsonb, $8)`,
      [
        ws.id,
        ws.slug,
        ws.name,
        ws.plan,
        `cus_seed_${ws.slug}`,
        `sub_seed_${ws.slug}`,
        new Date(ANCHOR.getTime() + 20 * DAY),
        new Date(ANCHOR.getTime() - DAYS * DAY),
        branding,
      ],
    );
    for (const [index, role] of ws.members) {
      await client.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
        ws.id,
        USERS[index]!.id,
        role,
      ]);
    }
    if (ws.apiKey !== null) {
      await client.query(
        'INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4, $5)',
        [
          seedId('key', ws.slug.replace(/-/gu, '')),
          ws.id,
          'Demo key (local only)',
          ws.apiKey.slice(0, 12),
          hashKey(ws.apiKey),
        ],
      );
    }
    for (const [d, dash] of ws.dashboards.entries()) {
      const dashboardId = seedId('dash', `${ws.slug.replace(/-/gu, '')}${String(d)}`);
      await client.query(
        'INSERT INTO dashboards (id, tenant_id, name, range, updated_at) VALUES ($1, $2, $3, $4, $5)',
        [dashboardId, ws.id, dash.name, dash.range, new Date(ANCHOR.getTime() - d * HOUR)],
      );
      for (const [position, lane] of dash.lanes.entries()) {
        const spec = laneSpecSchema.parse(lane.spec);
        await client.query(
          'INSERT INTO lanes (id, tenant_id, dashboard_id, title, position, height, spec) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
          [
            seedId('lane', `${ws.slug.replace(/-/gu, '')}${String(d)}x${String(position)}`),
            ws.id,
            dashboardId,
            lane.title,
            position,
            lane.height ?? 20,
            JSON.stringify(spec),
          ],
        );
      }
    }
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set');

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  try {
    const client = await pool.connect();
    try {
      await teardown(client);
      for (const u of USERS) {
        await client.query(
          'INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
          [
            u.id,
            u.email,
            u.name,
            hashPassword(u.password),
            new Date(ANCHOR.getTime() - DAYS * DAY),
          ],
        );
      }
      await client.query(
        `SELECT ensure_event_partitions($1::timestamptz - INTERVAL '${String(DAYS + 1)} days', $1::timestamptz + INTERVAL '2 months')`,
        [ANCHOR],
      );
      for (const ws of WORKSPACES) await createWorkspace(client, ws);
    } finally {
      client.release();
    }

    // The ingest writer's own transaction, 2,000 rows at a time.
    const writer = new BatchWriter(pool, 2000);
    for (const [index, ws] of WORKSPACES.entries()) {
      const rows = generate(ws, 2000 + index);
      let written = 0;
      for (let i = 0; i < rows.length; i += 2000)
        written += (await writer.write(ws.id, rows.slice(i, i + 2000))).inserted;
      // Every write above has committed, and nothing else writes these two
      // workspaces, so "now" is a safe upper bound (the aggregator's 5 s lag
      // exists for concurrent writers).
      const upto = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!
        .now;
      const pass = await aggregateTenant(pool, ws.id, upto);
      console.log(
        `seed: ${ws.name} (/w/${ws.slug}): ${String(written)} events, ${String(pass.hours)} hour rollups`,
      );
    }
    console.log(`seed: sign in as ${DEMO_EMAIL} (anchor ${ANCHOR.toISOString()})`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
