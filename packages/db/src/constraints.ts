/**
 * The names Postgres will use when it refuses a write. Catch blocks match on
 * these, never on message text.
 */

export const PRISMA_UNIQUE_VIOLATION = 'P2002';
export const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';
export const PRISMA_NOT_FOUND = 'P2025';

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';
/** new row violates row-level security policy */
export const PG_INSUFFICIENT_PRIVILEGE = '42501';

export const USER_EMAIL_UNIQUE = 'users_email_key';
export const TENANT_SLUG_UNIQUE = 'tenants_slug_key';
export const INVITE_TOKEN_UNIQUE = 'invites_token_hash_key';
export const API_KEY_HASH_UNIQUE = 'api_keys_hash_key';
export const LANE_POSITION_UNIQUE = 'lanes_dashboard_position_key';
export const LAST_OWNER = 'memberships_keep_an_owner';

export const UNIQUE_INDEXES = Object.freeze({
  USER_EMAIL_UNIQUE,
  TENANT_SLUG_UNIQUE,
  INVITE_TOKEN_UNIQUE,
  API_KEY_HASH_UNIQUE,
});

export const UNIQUE_INDEX_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [USER_EMAIL_UNIQUE]: Object.freeze(['email']),
  [TENANT_SLUG_UNIQUE]: Object.freeze(['slug']),
  [INVITE_TOKEN_UNIQUE]: Object.freeze(['token_hash']),
  [API_KEY_HASH_UNIQUE]: Object.freeze(['key_hash']),
});
