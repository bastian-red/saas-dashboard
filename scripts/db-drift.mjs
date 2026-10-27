#!/usr/bin/env node
/**
 * Prove the live database matches the Prisma schema.
 *
 * `prisma migrate status` reads the migration LEDGER and never compares a
 * column, so an applied migration edited afterwards is invisible to it. This
 * runs `prisma migrate diff` from the live database to the datamodel instead.
 *
 * What the diff cannot see is the hand-written half: the raw events and rollup
 * tables, their partitions, the deferrable lane-position constraint. Prisma
 * proposes dropping those, so those statements are expected and filtered; every
 * other difference is real drift. The isolation half (RLS enabled, FORCED and a
 * policy on every tenant table, no stray SECURITY DEFINER) is checked against
 * the live catalog by apps/api/test/isolation.test.ts, which runs in the same
 * lane.
 *
 *   node scripts/db-drift.mjs     (connects as the OWNER: DIRECT_DATABASE_URL)
 *
 * 0 = matches. 1 = drift, with the SQL that would close it. 2 = could not run.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbPackage = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'db');
const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error('db-drift: DIRECT_DATABASE_URL is not set.');
  process.exit(2);
}

let diff;
try {
  diff = execFileSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-url',
      url,
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    {
      cwd: dbPackage,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
} catch (error) {
  console.error('db-drift: prisma migrate diff failed to run.');
  console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`);
  process.exit(2);
}

const RAW =
  /"(events(_[a-z0-9]+)?|event_hours|event_dim_hours|event_sum_hours|aggregation_watermarks|lanes_dashboard_position_key)"/u;
const real = diff
  .split(/\n(?=-- )/u)
  .filter((block) => !RAW.test(block))
  .join('\n')
  .trim();
if (real !== '' && !/this is an empty migration/iu.test(real)) {
  console.error(
    'db-drift: the database does NOT match packages/db/prisma/schema.prisma. Prisma would need:\n',
  );
  console.error(real);
  process.exit(1);
}
console.log(
  'db-drift: the database matches the schema (raw tables and constraints are checked by the isolation suite).',
);
