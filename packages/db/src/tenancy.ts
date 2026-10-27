/**
 * The tenancy contract of the database, by name.
 *
 * `TENANT_TABLES` is every table that holds tenant data and must therefore have
 * row-level security enabled, FORCED and a policy. `GLOBAL_TABLES` is the short,
 * explicit list of tables that legitimately have none. The catalog gate in the
 * integration lane (apps/api/test/isolation.test.ts) reads the live catalog and
 * fails if a table is in neither list, or if a table with a `tenant_id` column
 * lacks its policy: a new table is either isolated or deliberately global, never
 * global by accident.
 */

export const TENANT_TABLES = Object.freeze([
  'tenants',
  'memberships',
  'invites',
  'api_keys',
  'dashboards',
  'lanes',
  'events',
  'event_hours',
  'event_dim_hours',
  'event_sum_hours',
  'aggregation_watermarks',
] as const);

/** Each with the reason it carries no tenant. */
export const GLOBAL_TABLES: Readonly<Record<string, string>> = Object.freeze({
  users: 'a person can belong to several workspaces',
  webhook_events: 'provider deliveries are deduplicated before the tenant is known',
  _prisma_migrations: 'the migration ledger; saas_app has no grant on it',
});

/** Partitions of `events`: tenant data, checked like any tenant table. */
export const EVENT_PARTITION = /^events_(y\d{4}m\d{2}|default)$/u;

/** The audited cross-tenant functions, the only SECURITY DEFINER objects allowed. */
export const DEFINER_FUNCTIONS = Object.freeze([
  'user_workspaces',
  'tenant_for_api_key',
  'invite_by_token',
  'tenant_for_customer',
  'tenants_pending_aggregation',
  'ensure_event_partitions',
] as const);

export const APP_ROLE = 'saas_app';
export const TENANT_SETTING = 'app.tenant_id';
