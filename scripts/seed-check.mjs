#!/usr/bin/env node
/**
 * The work behind scripts/seed-check.sh (read its header for the three
 * properties). Node and `pg` rather than psql, so it runs wherever the repo's
 * dependencies are installed, with nothing extra on the machine.
 *
 * It connects as saas_app, like the seed and every service, so each digest is
 * read inside the workspace's own tenant context. With no context set it would
 * read nothing at all, which is the isolation working.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(ROOT, 'services', 'aggregator', 'package.json'));
const pg = require('pg');
const { rollupDrift } = require(join(ROOT, 'services', 'aggregator', 'dist', 'index.js'));

const SEED = readFileSync(join(ROOT, 'packages', 'db', 'prisma', 'seed.mts'), 'utf8');
const constant = (name) => new RegExp(`^const ${name} = '([^']+)';`, 'mu').exec(SEED)?.[1];
const TENANTS = [constant('MAIN_TENANT'), constant('SECOND_TENANT')];
if (TENANTS.some((t) => t === undefined)) {
  console.error('seed-check: could not read MAIN_TENANT / SECOND_TENANT out of seed.mts.');
  process.exit(2);
}

// Everything the seed writes for a workspace, timestamps relative to the
// workspace's creation (the seed's anchor minus its window), ids included: the
// event ids come from the seeded PRNG, so they are part of what must repeat.
const DIGEST_SQL = `
WITH t AS (SELECT created_at AS anchor FROM tenants), x AS (
  SELECT 'tenant ' || slug || ' ' || name || ' ' || plan || ' ' || coalesce(branding::text, '-') AS x FROM tenants
  UNION ALL SELECT 'member ' || user_id || ' ' || role FROM memberships
  UNION ALL SELECT 'key ' || id || ' ' || prefix || ' ' || key_hash FROM api_keys
  UNION ALL SELECT 'dashboard ' || id || ' ' || name || ' ' || range FROM dashboards
  UNION ALL SELECT 'lane ' || id || ' ' || position || ' ' || coalesce(title, '-') || ' ' || spec::text FROM lanes
  UNION ALL SELECT 'event ' || e.id || ' ' || extract(epoch FROM e.at - t.anchor)::text || ' ' || e.event || ' ' ||
                   encode(e.user_hash, 'hex') || ' ' || e.properties::text
              FROM events e, t
)
SELECT count(*)::int AS n, md5(string_agg(x, '|' ORDER BY x)) AS digest,
       (SELECT count(*)::int FROM events) AS events FROM x`;

function seed() {
  execFileSync('pnpm', ['--filter', '@saas/db', 'exec', 'tsx', 'prisma/seed.mts'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

async function digests() {
  const out = [];
  for (const tenant of TENANTS) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      out.push((await c.query(DIGEST_SQL)).rows[0]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
  return out;
}

try {
  console.log('seed-check: first run');
  seed();
  const first = await digests();
  for (const d of first) console.log(`  ${d.n} rows (${d.events} events) ${d.digest}`);

  console.log('seed-check: second run');
  seed();
  const second = await digests();
  for (const d of second) console.log(`  ${d.n} rows (${d.events} events) ${d.digest}`);

  let failed = false;
  for (const [i, tenant] of TENANTS.entries()) {
    if (first[i].digest !== second[i].digest || first[i].n !== second[i].n) {
      console.error(`FAIL: workspace ${tenant}: the seed is not deterministic or not idempotent.`);
      console.error(
        'A changed row count means the teardown left rows behind; the same count with a',
      );
      console.error('changed digest means the generator read the clock or Math.random.');
      failed = true;
    }
    if (first[i].events === 0) {
      console.error(
        `FAIL: workspace ${tenant} has no events: the digest ran outside its tenant context?`,
      );
      failed = true;
    }
    const drift = await rollupDrift(pool, tenant);
    if (drift.length > 0) {
      console.error(
        `FAIL: workspace ${tenant}: ${drift.length} rollup row(s) disagree with a recount of the raw events:`,
      );
      for (const d of drift.slice(0, 10))
        console.error(`  ${d.table} ${d.key} stored ${d.stored}, recounted ${d.recounted}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  const total = first.reduce((sum, d) => sum + d.events, 0);
  console.log(
    `PASS: two runs, identical digests over ${TENANTS.length} workspaces and ${total} events; rollups equal a recount.`,
  );
} finally {
  await pool.end();
}
