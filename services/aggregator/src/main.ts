import { createServer } from 'node:http';

import { Pool } from 'pg';

import type { Health, HealthCheck } from '@saas/shared';

import { aggregateTenant, pendingTenants, safeUpto } from './aggregate';

/**
 * The aggregator process: every AGGREGATOR_INTERVAL_MS, find the workspaces
 * with new events and roll each up (a few at a time); daily, keep the event
 * partitions ahead of the clock. /health reports the database and how stale
 * the newest pass is.
 */

function int(name: string, value: string | undefined, fallback: number): number {
  const raw = value?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name}=${raw} must be a positive integer`);
  return n;
}

const log = (event: string, data: Record<string, unknown> = {}) =>
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), service: 'aggregator', event, ...data })}\n`,
  );

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
  if (databaseUrl === '') throw new Error('DATABASE_URL is required');
  const intervalMs = int('AGGREGATOR_INTERVAL_MS', process.env.AGGREGATOR_INTERVAL_MS, 2000);
  const port = int('AGGREGATOR_HEALTH_PORT', process.env.AGGREGATOR_HEALTH_PORT, 4300);
  const version = process.env.APP_VERSION?.trim() || 'dev';
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const startedAt = Date.now();
  let lastPassAt: number | null = null;
  let running = true;

  const partitions = async () => {
    await pool.query(
      `SELECT ensure_event_partitions(now() - INTERVAL '1 day', now() + INTERVAL '2 months')`,
    );
  };
  await partitions();
  const daily = setInterval(
    () => void partitions().catch((e: unknown) => log('partitions_failed', { error: String(e) })),
    86_400_000,
  );

  const pass = async () => {
    const upto = await safeUpto(pool);
    const tenants = await pendingTenants(pool, upto);
    let events = 0;
    for (let i = 0; i < tenants.length; i += 4) {
      const results = await Promise.all(
        tenants.slice(i, i + 4).map((t) => aggregateTenant(pool, t, upto)),
      );
      events += results.reduce((n, r) => n + r.events, 0);
    }
    lastPassAt = Date.now();
    if (events > 0) log('pass', { tenants: tenants.length, events });
  };
  const loop = async () => {
    while (running) {
      const started = Date.now();
      await pass().catch((e: unknown) => log('pass_failed', { error: String(e) }));
      await new Promise((r) => setTimeout(r, Math.max(0, intervalMs - (Date.now() - started))));
    }
  };
  const done = loop();

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      const started = Date.now();
      const db: HealthCheck = await pool.query('SELECT 1').then(
        () => ({ name: 'postgres', status: 'ok', latencyMs: Date.now() - started, detail: null }),
        (e: unknown) => ({
          name: 'postgres',
          status: 'fail',
          latencyMs: Date.now() - started,
          detail: (e as Error).message,
        }),
      );
      // A loop that stopped passing is a dead aggregator even if Postgres is fine.
      const stale =
        lastPassAt === null || Date.now() - lastPassAt > Math.max(30_000, intervalMs * 10);
      const loopCheck: HealthCheck = {
        name: 'aggregation',
        status: stale ? 'fail' : 'ok',
        latencyMs: lastPassAt === null ? 0 : Date.now() - lastPassAt,
        detail: stale ? 'no pass completed recently' : null,
      };
      const body: Health = {
        status: db.status === 'ok' && loopCheck.status === 'ok' ? 'ok' : 'degraded',
        service: 'aggregator',
        version,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        checks: [db, loopCheck],
      };
      res.writeHead(body.status === 'ok' ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    })();
  });
  server.listen(port);
  log('started', { port, intervalMs });

  const shutdown = async () => {
    running = false;
    clearInterval(daily);
    server.close();
    await done;
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  log('fatal', { error: String(error) });
  process.exit(1);
});
