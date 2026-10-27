/**
 * The tenancy contract, held at the source: the migrations and the Prisma
 * schema, with no database. The integration lane holds the same contract
 * against the live catalog (apps/api/test/isolation.test.ts); this half runs on
 * every commit and catches the mistake at the moment it is typed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFINER_FUNCTIONS, GLOBAL_TABLES, TENANT_TABLES } from './tenancy';

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const sql = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => readFileSync(join(MIGRATIONS, e.name, 'migration.sql'), 'utf8'))
  .join('\n')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

describe('every tenant table is isolated in the migrations', () => {
  it.each(TENANT_TABLES)(
    '%s: RLS enabled, FORCED, and a policy on app_current_tenant()',
    (table) => {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      const policy = new RegExp(
        `CREATE POLICY "${table}_isolation" ON "${table}"\\s+USING \\("(tenant_id|id)" = app_current_tenant\\(\\)\\) WITH CHECK \\("(tenant_id|id)" = app_current_tenant\\(\\)\\)`,
        'u',
      );
      expect(sql).toMatch(policy);
    },
  );
});

describe('every Prisma model is classified', () => {
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gmu)].map(([, name, body]) => ({
    name: name!,
    table: /@@map\("(\w+)"\)/u.exec(body!)?.[1] ?? name!,
    hasTenant: /\btenantId\b/u.test(body!),
  }));

  it('found the models, so the walk is real', () => {
    expect(models.length).toBeGreaterThanOrEqual(8);
  });

  it.each(models.map((m) => [m.table, m] as const))(
    '%s is a tenant table or an explained global one',
    (_t, m) => {
      const tenant = (TENANT_TABLES as readonly string[]).includes(m.table);
      const global = m.table in GLOBAL_TABLES;
      expect(tenant !== global, `${m.table} must be in exactly one list`).toBe(true);
      if (m.hasTenant)
        expect(tenant, `${m.table} has a tenantId, so it must be a tenant table`).toBe(true);
    },
  );
});

describe('the cross-tenant doors are the listed ones and no more', () => {
  it('every SECURITY DEFINER function is in DEFINER_FUNCTIONS, pins its search_path, and is revoked from PUBLIC', () => {
    const definers = [...sql.matchAll(/CREATE FUNCTION "(\w+)"\([^)]*\)[\s\S]*?(?=\$\$)/gu)]
      .filter(([text]) => text.includes('SECURITY DEFINER'))
      .map(([text, name]) => ({ name: name!, text }));
    expect(definers.map((d) => d.name).sort()).toEqual([...DEFINER_FUNCTIONS].sort());
    for (const d of definers) {
      expect(d.text, d.name).toContain('SET search_path = public');
      expect(sql, d.name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION "${d.name}"\\(`, 'u'));
    }
  });

  it('never grants the app role a way around RLS', () => {
    // BYPASSRLS may appear only as NOBYPASSRLS.
    expect(sql).toContain('NOBYPASSRLS');
    expect(sql.replaceAll('NOBYPASSRLS', '')).not.toContain('BYPASSRLS');
    expect(sql).not.toMatch(/ALTER TABLE "\w+" OWNER TO saas_app/u);
  });
});
