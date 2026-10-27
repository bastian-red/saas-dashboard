#!/usr/bin/env node
/**
 * The ingest load lane: the work behind scripts/loadtest.sh.
 *
 * Two measurements, each a pass/fail with its number printed:
 *
 * 1. THROUGHPUT. Four Business workspaces send 500 events/s each (2,000/s in
 *    total, batches of 25) for LOADTEST_SECONDS. Every batch must be accepted
 *    (202), accept latency p99 must be under LOADTEST_P99_MS, and afterwards
 *    each workspace must have stored exactly the events it was told were
 *    accepted: 202 means on disk, so zero loss is a row count, not a hope.
 *
 * 2. NOISY NEIGHBOUR. A quiet Business workspace sends 300 events/s (batches
 *    of 5, so each phase has hundreds of samples) alone,
 *    then again while a Free workspace floods ingest at 10x its plan's rate
 *    (200/s against 20/s, so nearly all of it is refused with 429). The quiet
 *    workspace must keep every batch, and its p99 under the flood must stay
 *    within 20% of its p99 alone (or 2 ms, whichever is larger: at single
 *    milliseconds a 20% band is smaller than scheduler jitter).
 *
 * The load is OPEN-LOOP: requests are sent on a fixed schedule whether or not
 * earlier ones have answered, so a slow server shows up as latency instead of
 * silently lowering the offered rate (the coordinated-omission trap of
 * closed-loop "send, wait, send" harnesses).
 *
 * Tenants are provisioned through the real API: sign-up, a minted service
 * token, workspaces, keys, and the plan upgrade through the mock billing
 * provider's signed-webhook path. Nothing is written behind the API's back.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(ROOT, 'services', 'ingest', 'package.json'));
const pg = require('pg');
const { mintServiceToken } = require(
  join(ROOT, 'packages', 'shared', 'dist', 'server', 'index.js'),
);

const API = process.env.API_BASE_URL ?? 'http://localhost:4000';
const INGEST = process.env.INGEST_INTERNAL_URL ?? 'http://localhost:4200';
const SECONDS = Number(process.env.LOADTEST_SECONDS ?? 20);
const P99_MS = Number(process.env.LOADTEST_P99_MS ?? 50);
const NOISY_SECONDS = Number(process.env.LOADTEST_NOISY_SECONDS ?? 12);
const OUT = process.env.LOADTEST_OUT ?? '/tmp/saas-loadtest';
const BATCH = 25;

mkdirSync(OUT, { recursive: true });

// --- provisioning, through the API ---------------------------------------------------

const address = () => `10.${[1, 2, 3].map(() => 1 + Math.floor(Math.random() * 254)).join('.')}`;

async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-forwarded-for': address(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${String(response.status)} ${text}`);
  return text === '' ? null : JSON.parse(text);
}

async function provision(label, count, plan) {
  const stamp = `${String(Date.now()).slice(-7)}${String(Math.floor(Math.random() * 1000))}`;
  const user = await api(null, 'POST', '/auth/sign-up', {
    email: `load-${label}-${stamp}@saas.test`,
    name: `Load ${label}`,
    password: 'load-test-password',
  });
  const token = () => mintServiceToken(user, process.env.AUTH_SECRET);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const slug = `load-${label}-${String(i)}-${stamp}`;
    const ws = await api(token(), 'POST', '/workspaces', {
      name: `Load ${label} ${String(i)}`,
      slug,
    });
    if (plan !== 'free')
      await api(token(), 'POST', `/workspaces/${slug}/billing/mock`, { plan, status: 'active' });
    const key = await api(token(), 'POST', `/workspaces/${slug}/api-keys`, { name: 'load' });
    out.push({
      slug,
      tenantId: ws.id,
      key: key.key,
      token,
      accepted: 0,
      latencies: [],
      refused: 0,
      errors: 0,
    });
  }
  return out;
}

// --- open-loop load ------------------------------------------------------------------

let seq = 0;
function batch(size) {
  const at = new Date().toISOString();
  return JSON.stringify({
    events: Array.from({ length: size }, () => ({
      event: 'load_event',
      userId: `u${String((seq += 1) % 5000)}`,
      timestamp: at,
      properties: { plan: seq % 3 === 0 ? 'business' : 'team', n: seq % 100 },
    })),
  });
}

async function send(tenant, size = BATCH) {
  const started = performance.now();
  try {
    const response = await fetch(`${INGEST}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tenant.key}`, 'content-type': 'application/json' },
      body: batch(size),
    });
    const body = await response.json();
    const ms = performance.now() - started;
    if (response.status === 202) {
      tenant.accepted += body.accepted;
      tenant.latencies.push(ms);
    } else if (response.status === 429 || response.status === 402) tenant.refused += 1;
    else tenant.errors += 1;
  } catch {
    tenant.errors += 1;
  }
}

/** Send `rate` events/s per tenant (in batches of `size`) for `seconds`, on a fixed schedule. */
async function drive(tenants, rate, seconds, size = BATCH) {
  const perSecond = rate / size;
  const intervalMs = 1000 / perSecond;
  const inflight = [];
  const start = performance.now();
  const total = Math.round(perSecond * seconds);
  for (let i = 0; i < total; i += 1) {
    const due = start + i * intervalMs;
    const wait = due - performance.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    for (const t of tenants) inflight.push(send(t, size));
  }
  await Promise.all(inflight);
}

function pct(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function storedCount(pool, tenantId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await c.query(
      "SELECT count(*)::int AS n FROM events WHERE event = 'load_event'",
    );
    await c.query('COMMIT');
    return rows[0].n;
  } finally {
    c.release();
  }
}

// --- the run -------------------------------------------------------------------------

const report = { at: new Date().toISOString(), seconds: SECONDS, batch: BATCH };
let failed = false;
const fail = (why) => {
  console.error(`FAIL: ${why}`);
  failed = true;
};

console.log('loadtest: provisioning workspaces through the API');
const fleet = await provision('fleet', 4, 'business');
const [quiet] = await provision('quiet', 1, 'business');
const [noisy] = await provision('noisy', 1, 'free');

// Warm-up: connections, JIT, key caches. Not measured.
await drive(fleet, 100, 2);

// Idle baseline: one batch at a time, nothing else in flight. What a single
// request costs with no queueing, so the loaded numbers can be read against it.
{
  const probe = fleet[0];
  const before = probe.latencies.length;
  for (let i = 0; i < 100; i += 1) await send(probe);
  const idle = probe.latencies.slice(before);
  report.idle = { p50: +pct(idle, 50).toFixed(2), p99: +pct(idle, 99).toFixed(2) };
  console.log(`loadtest: idle, one batch at a time: ${JSON.stringify(report.idle)}`);
}
for (const t of fleet) Object.assign(t, { accepted: 0, latencies: [], refused: 0, errors: 0 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const warm = Object.fromEntries(
  await Promise.all(fleet.map(async (t) => [t.tenantId, await storedCount(pool, t.tenantId)])),
);

console.log(
  `loadtest: throughput, 4 workspaces x 500 events/s for ${String(SECONDS)}s (2,000 events/s)`,
);
const t0 = performance.now();
await drive(fleet, 500, SECONDS);
const elapsed = (performance.now() - t0) / 1000;
const all = fleet.flatMap((t) => t.latencies);
const accepted = fleet.reduce((s, t) => s + t.accepted, 0);
const offered = Math.round((500 / BATCH) * SECONDS) * BATCH * fleet.length;
report.throughput = {
  offeredEvents: offered,
  acceptedEvents: accepted,
  eventsPerSecond: Math.round(accepted / elapsed),
  p50: +pct(all, 50).toFixed(2),
  p99: +pct(all, 99).toFixed(2),
  max: +Math.max(...all).toFixed(2),
  refused: fleet.reduce((s, t) => s + t.refused, 0),
  errors: fleet.reduce((s, t) => s + t.errors, 0),
};
console.log(`  ${JSON.stringify(report.throughput)}`);
if (accepted !== offered)
  fail(
    `${String(offered - accepted)} events were not accepted (refused ${String(report.throughput.refused)}, errors ${String(report.throughput.errors)})`,
  );
if (!(report.throughput.p99 < P99_MS))
  fail(`accept p99 ${String(report.throughput.p99)} ms is not under ${String(P99_MS)} ms`);

let lost = 0;
for (const t of fleet) {
  const stored = (await storedCount(pool, t.tenantId)) - warm[t.tenantId];
  if (stored !== t.accepted) {
    lost += t.accepted - stored;
    fail(`workspace ${t.slug}: ${String(t.accepted)} accepted, ${String(stored)} stored`);
  }
}
report.throughput.lost = lost;
console.log(`  stored == accepted for every workspace: ${lost === 0 ? 'yes' : 'NO'}`);

console.log(
  `loadtest: noisy neighbour, quiet workspace at 300 events/s for ${String(NOISY_SECONDS)}s, alone then beside a 10x flood`,
);
// Batches of 5 for the quiet workspace: 60 requests/s, so each phase has
// hundreds of samples and its p99 is a percentile, not the second-worst request.
const QUIET_BATCH = 5;
await drive([quiet], 300, NOISY_SECONDS, QUIET_BATCH);
const alone = {
  p99: pct(quiet.latencies, 99),
  samples: quiet.latencies.length,
  accepted: quiet.accepted,
  refused: quiet.refused,
};
Object.assign(quiet, { accepted: 0, latencies: [], refused: 0, errors: 0 });
// The flood: a Free workspace (20 events/s) offered 200 events/s, alongside.
await Promise.all([
  drive([quiet], 300, NOISY_SECONDS, QUIET_BATCH),
  drive([noisy], 200, NOISY_SECONDS),
]);
const beside = {
  p99: pct(quiet.latencies, 99),
  samples: quiet.latencies.length,
  accepted: quiet.accepted,
  refused: quiet.refused,
};
const allowed = Math.max(alone.p99 * 1.2, alone.p99 + 2);
report.noisyNeighbour = {
  samplesPerPhase: Math.min(alone.samples, beside.samples),
  quietAloneP99: +alone.p99.toFixed(2),
  quietBesideFloodP99: +beside.p99.toFixed(2),
  allowedP99: +allowed.toFixed(2),
  quietRefused: alone.refused + beside.refused,
  floodAccepted: noisy.accepted,
  floodRefusedBatches: noisy.refused,
};
console.log(`  ${JSON.stringify(report.noisyNeighbour)}`);
if (alone.refused + beside.refused > 0)
  fail('the quiet workspace had batches refused while the flood ran');
if (noisy.refused === 0)
  fail('the flood was never refused: the per-workspace rate limit is not working');
if (!(beside.p99 <= allowed))
  fail(`quiet p99 beside the flood ${beside.p99.toFixed(2)} ms exceeds ${allowed.toFixed(2)} ms`);

await pool.end();

// Where the tail lives: ingest logs one line per accepted batch slower than
// 200 ms with every phase timed. Count them by their dominant phase, so a
// failed run says "commit" or "queued" instead of only a number.
{
  const { existsSync, readFileSync } = await import('node:fs');
  const log = join(OUT, 'ingest.log');
  const slow = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"event":"slow_batch"'))
        .map((l) => JSON.parse(l))
    : [];
  const byPhase = {};
  for (const b of slow) {
    const [phase] = Object.entries(b.phases).sort((x, y) => y[1] - x[1])[0];
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
  }
  report.slowBatches = {
    count: slow.length,
    dominantPhase: byPhase,
    worst: slow.sort((x, y) => y.ms - x.ms).slice(0, 5),
  };
  console.log(`loadtest: batches over 200 ms: ${String(slow.length)} ${JSON.stringify(byPhase)}`);
  for (const b of report.slowBatches.worst)
    console.log(`  ${JSON.stringify({ ms: b.ms, phases: b.phases, txRows: b.txRows })}`);
}

// Leave nothing behind: deleting a workspace through the API deletes its
// events and rollups too, so repeated runs reuse the same disk instead of
// growing the database (Docker's disk is small on the machine this runs on).
for (const t of [...fleet, quiet, noisy]) await api(t.token(), 'DELETE', `/workspaces/${t.slug}`);
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`loadtest: report written to ${join(OUT, 'report.json')}`);
if (failed) process.exit(1);
console.log(
  'PASS: 2,000 events/s accepted with zero loss under the p99 budget, and a flooding neighbour moved nobody else.',
);
