/**
 * The database, as two narrow doors instead of one wide one.
 *
 * - `tenant(tenantId, fn)`: every tenant table, inside withTenant, so row-level
 *   security scopes every statement `fn` runs. The only way a feature reaches
 *   dashboards, members, keys or events.
 * - `global`: the tables that have no tenant (users, the webhook ledger) and the
 *   audited SECURITY DEFINER functions that answer a question before a tenant is
 *   known. Typed as exactly those, so a feature cannot reach `tenants` or
 *   `dashboards` through it.
 *
 * The client itself is private. A feature that wants to "just query" has no
 * handle to do it with; that is the point. It connects as saas_app
 * (boot.ts refuses anything else), so even a raw query that slipped through
 * would see no tenant's rows without a tenant context.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, withTenant, type PrismaClient, type TenantTx } from '@saas/db';

import { API_CONFIG, type ApiConfig } from '../config/config';

export interface WorkspaceRow {
  tenant_id: string;
  slug: string;
  name: string;
  role: string;
  plan: string;
  subscription_status: string | null;
  branding: unknown;
}

export interface GlobalDb {
  readonly user: PrismaClient['user'];
  readonly webhookEvent: PrismaClient['webhookEvent'];
  userWorkspaces(userId: string): Promise<WorkspaceRow[]>;
  inviteByToken(tokenHash: string): Promise<
    {
      tenant_id: string;
      invite_id: string;
      email: string;
      role: string;
      expires_at: Date;
      accepted_at: Date | null;
      workspace_name: string;
    }[]
  >;
  tenantForCustomer(customerId: string): Promise<string | null>;
  ping(): Promise<void>;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PrismaClient;
  readonly global: GlobalDb;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.client = createPrismaClient({ url: config.databaseUrl });
    const c = this.client;
    this.global = {
      user: c.user,
      webhookEvent: c.webhookEvent,
      userWorkspaces: (userId) =>
        c.$queryRaw<WorkspaceRow[]>`SELECT * FROM user_workspaces(${userId})`,
      inviteByToken: (tokenHash) => c.$queryRaw`SELECT * FROM invite_by_token(${tokenHash})`,
      tenantForCustomer: async (customerId) => {
        const rows = await c.$queryRaw<
          { t: string | null }[]
        >`SELECT tenant_for_customer(${customerId}) AS t`;
        return rows[0]?.t ?? null;
      },
      ping: async () => {
        await c.$queryRaw`SELECT 1`;
      },
    };
  }

  /** Run `fn` with row-level security scoped to `tenantId`. */
  tenant<T>(
    tenantId: string,
    fn: (tx: TenantTx) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return withTenant(this.client, tenantId, fn, options);
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
