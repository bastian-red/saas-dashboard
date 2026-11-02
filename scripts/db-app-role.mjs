#!/usr/bin/env node
/**
 * Give the application role its login, from the environment.
 *
 * The tenant_isolation migration creates `saas_app` WITHOUT a password, so no
 * credential is ever committed in a migration. This sets LOGIN and the password
 * found in DATABASE_URL (the app's URL), connecting as the owner through
 * DIRECT_DATABASE_URL. Idempotent; `pnpm db:deploy` runs it after migrating.
 *
 * It also refuses to continue if DATABASE_URL logs in as anything but
 * saas_app: a service connected as the owner would read every tenant's rows
 * whenever a policy is not FORCED, which is precisely the mistake this whole
 * schema is arranged to make impossible.
 *
 * `node scripts/db-app-role.mjs --self-test` checks the URL rewrite below
 * without a database; the pre-commit gate and CI run it.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(ROOT, 'packages', 'db', 'package.json'));
const { Client } = require('pg');

/**
 * The owner URL, reduced to what node-postgres understands.
 *
 * DIRECT_DATABASE_URL is written for Prisma, so it can carry Prisma-only
 * parameters (`schema`, `connection_limit`, `pgbouncer`...) that `pg` would
 * send to the server as startup options and fail on. This used to clear the
 * whole query string, which also dropped `sslmode`: harmless against the local
 * container, fatal against a hosted Postgres that only accepts TLS (Neon
 * answered "connection is insecure (try using `sslmode=require`)" on the first
 * deploy). So the libpq parameters `pg` reads are kept and nothing else is.
 */
const PG_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'application_name', 'options'];

export function ownerConnectionUrl(raw) {
  const url = new URL(raw);
  for (const name of [...url.searchParams.keys()]) {
    if (!PG_PARAMS.includes(name)) url.searchParams.delete(name);
  }
  return url.toString();
}

function selfTest() {
  const cases = [
    // Local: the Prisma-only `schema` must go, or pg fails on it.
    ['postgresql://o:p@localhost:5443/saas?schema=public', 'postgresql://o:p@localhost:5443/saas'],
    // Hosted: TLS must survive. This is the case the old code broke.
    [
      'postgresql://o:p@ep-x.neon.tech/saas?sslmode=require&channel_binding=require&schema=public',
      'postgresql://o:p@ep-x.neon.tech/saas?sslmode=require',
    ],
    [
      'postgresql://o:p@h/db?connection_limit=1&pgbouncer=true&sslmode=verify-full&sslrootcert=%2Fca.pem',
      'postgresql://o:p@h/db?sslmode=verify-full&sslrootcert=%2Fca.pem',
    ],
    ['postgresql://o:p@h/db', 'postgresql://o:p@h/db'],
  ];
  let failed = 0;
  for (const [input, expected] of cases) {
    const actual = ownerConnectionUrl(input);
    if (actual !== expected) {
      failed += 1;
      console.error(
        `db-app-role self-test: ${input}\n  expected ${expected}\n  got      ${actual}`,
      );
    }
  }
  if (failed) process.exit(1);
  console.log(`db-app-role self-test: ${cases.length} cases pass.`);
}

async function main() {
  const app = new URL(process.env.DATABASE_URL ?? '');
  const ownerUrl = process.env.DIRECT_DATABASE_URL ?? '';
  if (decodeURIComponent(app.username) !== 'saas_app') {
    console.error(
      `db-app-role: DATABASE_URL must log in as saas_app, not "${app.username}". The services must never connect as the table owner.`,
    );
    process.exit(1);
  }
  const password = decodeURIComponent(app.password);
  if (password.length < 8) {
    console.error(
      'db-app-role: the saas_app password in DATABASE_URL must be at least 8 characters.',
    );
    process.exit(1);
  }
  const client = new Client({ connectionString: ownerConnectionUrl(ownerUrl) });
  await client.connect();
  try {
    // A parameter cannot be bound in ALTER ROLE; format the literal with the
    // server's own quoting so a quote in the password cannot break out.
    const { rows } = await client.query('SELECT quote_literal($1) AS pw', [password]);
    await client.query(`ALTER ROLE saas_app LOGIN PASSWORD ${rows[0].pw}`);
    console.log('db-app-role: saas_app can log in; it owns no table and cannot bypass RLS.');
  } finally {
    await client.end();
  }
}

if (process.argv.includes('--self-test')) selfTest();
else await main();
