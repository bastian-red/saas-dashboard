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
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(ROOT, 'packages', 'db', 'package.json'));
const { Client } = require('pg');

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
const owner = new URL(ownerUrl);
owner.search = '';
const client = new Client({ connectionString: owner.toString() });
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
