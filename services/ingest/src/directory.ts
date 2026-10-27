import type { Pool } from 'pg';

import {
  effectivePlan,
  PLANS,
  planIdSchema,
  subscriptionStatusSchema,
  type Plan,
} from '@saas/shared';

/**
 * API key -> workspace and plan, through the audited `tenant_for_api_key`
 * function (the only way to ask that question before a tenant is known).
 *
 * Cached for `ttlMs`, because every ingest request asks it. Two events make a
 * cached answer wrong, and both evict at once rather than waiting for the TTL:
 * a revoked key, and a plan change (the API publishes `ingest:invalidate` with
 * the tenant id; main.ts subscribes). "An upgrade lifts the quota immediately"
 * depends on that eviction, and the integration lane asserts it.
 */
/** The channel the API publishes a tenant id on when its plan or its keys change. */
export const INVALIDATE_CHANNEL = 'ingest:invalidate';

export interface KeyOwner {
  tenantId: string;
  keyId: string;
  plan: Plan;
}

export class KeyDirectory {
  private readonly cache = new Map<string, { owner: KeyOwner | null; until: number }>();

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 30_000,
  ) {}

  async lookup(keyHash: string, now = Date.now()): Promise<KeyOwner | null> {
    const hit = this.cache.get(keyHash);
    if (hit !== undefined && hit.until > now) return hit.owner;
    const { rows } = await this.pool.query<{
      tenant_id: string;
      key_id: string;
      plan: string;
      subscription_status: string | null;
    }>('SELECT tenant_id, key_id, plan, subscription_status FROM tenant_for_api_key($1)', [
      keyHash,
    ]);
    const row = rows[0];
    const owner =
      row === undefined
        ? null
        : {
            tenantId: row.tenant_id,
            keyId: row.key_id,
            plan: PLANS[
              effectivePlan(
                planIdSchema.parse(row.plan),
                row.subscription_status === null
                  ? null
                  : subscriptionStatusSchema.parse(row.subscription_status),
              )
            ],
          };
    // Unknown keys are cached too, briefly, so a client hammering with a bad
    // key costs one query per few seconds, not one per request.
    this.cache.set(keyHash, { owner, until: now + (owner === null ? 5_000 : this.ttlMs) });
    return owner;
  }

  /** Drop every cached key of `tenantId`: its plan or its keys changed. */
  invalidateTenant(tenantId: string): void {
    for (const [hash, entry] of this.cache)
      if (entry.owner?.tenantId === tenantId || entry.owner === null) this.cache.delete(hash);
  }
}
