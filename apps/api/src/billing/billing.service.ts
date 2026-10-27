/**
 * Plans, checkout, the customer portal, the provider webhook, and branding.
 *
 * The webhook is the part with guarantees:
 *
 * - SIGNED: the provider's signature is verified before anything is read; a bad
 *   one is a 400 (never retryable, it will not become good).
 * - EXACTLY ONCE: the event id goes into `webhook_events` in the SAME
 *   transaction as the change it causes; a duplicate delivery inserts nothing
 *   and changes nothing.
 * - ORDERED: a subscription state is applied only if the event is newer than
 *   the one that produced the stored state (`subscription_updated_at`), so a
 *   delayed "active" cannot undo the "canceled" that came after it.
 * - IMMEDIATE: after commit the ingest service's key cache for the workspace is
 *   evicted, so the new plan's quota applies to the very next batch.
 */
import { Inject, Injectable } from '@nestjs/common';
import { checkAccent, suggestAccent } from '@saas/branding';
import {
  createBilling,
  WebhookSignatureError,
  type BillingEvent,
  type BillingProvider,
  type MockBilling,
} from '@saas/billing';
import { DomainError, PLANS, type Billing, type PlanId, type SessionUser } from '@saas/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import type { TenantContext } from '../tenancy/tenant.guard';
import { INGEST_INVALIDATE } from '../workspaces/workspaces.service';

export type WebhookOutcome = 'applied' | 'duplicate' | 'stale' | 'ignored';

@Injectable()
export class BillingService {
  readonly provider: BillingProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    this.provider = createBilling({
      driver: config.billingDriver,
      stripeSecretKey: config.stripeSecretKey,
      stripeWebhookSecret: config.stripeWebhookSecret,
      mockSecret: config.billingMockSecret,
      appBaseUrl: config.appBaseUrl,
    });
  }

  async summary(ctx: TenantContext, now = new Date()): Promise<Billing> {
    const month = `${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const [tenant, seats, used] = await Promise.all([
      this.prisma.tenant(ctx.tenantId, (tx) =>
        tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } }),
      ),
      this.prisma.tenant(ctx.tenantId, (tx) => tx.membership.count()),
      // The ingest service's counter is the authority for the month's usage.
      this.redis.client.get(`quota:${ctx.tenantId}:${month}`),
    ]);
    return {
      plan: ctx.plan,
      status: (tenant.subscriptionStatus as Billing['status']) ?? null,
      effectivePlan: ctx.effectivePlan,
      seatsUsed: seats,
      eventsThisMonth: Number(used ?? 0),
      currentPeriodEnd: tenant.currentPeriodEnd?.toISOString() ?? null,
    };
  }

  async checkout(
    ctx: TenantContext,
    user: SessionUser,
    plan: Exclude<PlanId, 'free'>,
  ): Promise<{ url: string }> {
    const tenant = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } }),
    );
    const base = `${this.config.appBaseUrl}/w/${ctx.slug}/settings/billing`;
    const { url, customerId } = await this.provider.createCheckout({
      tenantId: ctx.tenantId,
      customerId: tenant.providerCustomerId,
      email: user.email,
      plan,
      successUrl: `${base}?checkout=success`,
      cancelUrl: `${base}?checkout=cancel`,
    });
    if (tenant.providerCustomerId === null) {
      // Stored now, so a webhook arriving before the browser returns can be
      // routed to this workspace by customer id.
      await this.prisma.tenant(ctx.tenantId, (tx) =>
        tx.tenant.update({ where: { id: ctx.tenantId }, data: { providerCustomerId: customerId } }),
      );
    }
    return { url };
  }

  async portal(ctx: TenantContext): Promise<{ url: string }> {
    const tenant = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } }),
    );
    if (tenant.providerCustomerId === null)
      throw new DomainError(
        'UNPROCESSABLE',
        'This workspace has no billing account yet. Choose a plan first.',
      );
    return this.provider.createPortal(
      tenant.providerCustomerId,
      `${this.config.appBaseUrl}/w/${ctx.slug}/settings/billing`,
    );
  }

  /** The webhook endpoint's whole job, given the raw body and the signature header. */
  async webhook(rawBody: Buffer, signature: string): Promise<WebhookOutcome> {
    let event: BillingEvent;
    try {
      event = this.provider.verifyWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof WebhookSignatureError)
        throw new DomainError('INVALID', 'Webhook signature did not verify.');
      throw error;
    }
    return this.apply(event);
  }

  async apply(event: BillingEvent): Promise<WebhookOutcome> {
    const tenantId =
      event.tenantId ??
      (event.customerId === ''
        ? null
        : await this.prisma.global.tenantForCustomer(event.customerId));
    if (tenantId === null) {
      // Not ours to act on, but recorded, so a replay is recognised as one.
      await this.prisma.global.webhookEvent.createMany({
        data: [{ provider: this.provider.name, eventId: event.eventId, type: event.type }],
        skipDuplicates: true,
      });
      return 'ignored';
    }

    const outcome = await this.prisma.tenant(tenantId, async (tx): Promise<WebhookOutcome> => {
      // webhook_events is a global table; writing it inside the tenant
      // transaction is what makes "recorded" and "applied" one atomic fact.
      const inserted = await tx.$executeRaw`
        INSERT INTO webhook_events (provider, event_id, type) VALUES (${this.provider.name}, ${event.eventId}, ${event.type})
        ON CONFLICT DO NOTHING`;
      if (inserted === 0) return 'duplicate';

      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (tenant === null) return 'ignored';
      if (tenant.providerCustomerId === null) {
        await tx.tenant.update({
          where: { id: tenantId },
          data: { providerCustomerId: event.customerId },
        });
      }
      const sub = event.subscription;
      if (sub === null) return 'applied';
      if (
        tenant.subscriptionUpdatedAt !== null &&
        tenant.subscriptionUpdatedAt.getTime() > event.occurredAt.getTime()
      )
        return 'stale';
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          plan: sub.plan,
          subscriptionStatus: sub.status,
          providerSubscriptionId: sub.id,
          currentPeriodEnd: sub.currentPeriodEnd,
          subscriptionUpdatedAt: event.occurredAt,
        },
      });
      return 'applied';
    });
    if (outcome === 'applied') await this.redis.client.publish(INGEST_INVALIDATE, tenantId);
    return outcome;
  }

  /** Mock driver only: what "Pay" on the mock checkout page does. */
  async mockComplete(
    ctx: TenantContext,
    plan: Exclude<PlanId, 'free'>,
    status: 'active' | 'past_due' | 'canceled',
  ): Promise<WebhookOutcome> {
    if (this.provider.name !== 'mock')
      throw new DomainError('NOT_FOUND', 'Not available with this billing driver.');
    const tenant = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } }),
    );
    const customerId = tenant.providerCustomerId ?? `cus_mock_${ctx.tenantId.slice(0, 8)}`;
    const mock = this.provider as MockBilling;
    const { body, signature } = mock.mockEvent({
      type:
        status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
      customerId,
      tenantId: ctx.tenantId,
      subscription: {
        id: tenant.providerSubscriptionId ?? `sub_mock_${ctx.tenantId.slice(0, 8)}`,
        plan,
        status,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    // Through the real webhook path: signature, dedupe, ordering, eviction.
    return this.webhook(Buffer.from(body), signature);
  }

  // --- branding --------------------------------------------------------------

  async setBranding(
    ctx: TenantContext,
    accent: string | null,
  ): Promise<{ light: unknown; dark: unknown } | null> {
    if (accent === null) {
      // Raw SQL: Prisma's Json field needs Prisma.DbNull to write NULL, and the
      // policy scopes this UPDATE to the one tenant row visible here.
      await this.prisma.tenant(
        ctx.tenantId,
        (tx) => tx.$executeRaw`UPDATE tenants SET branding = NULL`,
      );
      return null;
    }
    const result = checkAccent(accent);
    if (!result.ok) {
      throw new DomainError(
        'UNPROCESSABLE',
        `${accent} would not be readable everywhere it is painted.`,
        {
          field: 'accent',
          issues: result.issues,
          suggestion: suggestAccent(accent),
        },
      );
    }
    const branding = {
      accent: accent.toLowerCase(),
      light: { ...result.light },
      dark: { ...result.dark },
    };
    await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.tenant.update({ where: { id: ctx.tenantId }, data: { branding } }),
    );
    return { light: result.light, dark: result.dark };
  }

  plans() {
    return Object.values(PLANS);
  }
}
