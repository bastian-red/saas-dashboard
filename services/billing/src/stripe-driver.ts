/**
 * The Stripe driver: the only file that imports `stripe`.
 *
 * Plans map to prices by lookup key (`team_monthly`, `business_monthly`), so
 * the price ids differ per Stripe account and none is hard-coded. Statuses
 * map onto this app's five; a status this app has no word for is refused
 * rather than guessed.
 */
import Stripe from 'stripe';

import { PLANS, type PlanId, type SubscriptionStatus } from '@saas/shared';

import type { BillingEvent, BillingProvider, CheckoutParams } from './types';
import { BillingConfigError, WebhookSignatureError } from './types';

export const STRIPE_API_VERSION = '2025-02-24.acacia';

const STATUS: Record<Stripe.Subscription.Status, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  paused: 'canceled',
};

export function planForLookupKey(key: string | null | undefined): PlanId {
  const plan = Object.values(PLANS).find((p) => p.priceLookupKey === key);
  if (plan === undefined)
    throw new WebhookSignatureError(`unknown price lookup key ${String(key)}`);
  return plan.id;
}

/** Pure: a Stripe event to the normalised shape (no SDK call, no network). */
export function parseStripeEvent(event: Stripe.Event): BillingEvent | null {
  const occurredAt = new Date(event.created * 1000);
  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const sub = event.data.object;
    const item = sub.items.data[0];
    return {
      eventId: event.id,
      type: event.type,
      occurredAt,
      customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
      tenantId: sub.metadata.tenant_id ?? null,
      subscription: {
        id: sub.id,
        plan: planForLookupKey(item?.price.lookup_key),
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : STATUS[sub.status],
        // On the subscription in API version 2025-02-24 (later versions move it to the item).
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
      },
    };
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customer = session.customer;
    if (customer === null) return null;
    return {
      eventId: event.id,
      type: event.type,
      occurredAt,
      customerId: typeof customer === 'string' ? customer : customer.id,
      tenantId: session.metadata?.tenant_id ?? null,
      subscription: null,
    };
  }
  return null;
}

export class StripeBilling implements BillingProvider {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    if (!secretKey.startsWith('sk_test_') && !secretKey.startsWith('rk_test_')) {
      // This portfolio is never deployed; a live key here can only be a mistake.
      throw new BillingConfigError('STRIPE_SECRET_KEY must be a TEST key (sk_test_...).');
    }
    this.stripe = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    });
  }

  async createCheckout(p: CheckoutParams): Promise<{ url: string; customerId: string }> {
    const customerId =
      p.customerId ??
      (await this.stripe.customers.create({ email: p.email, metadata: { tenant_id: p.tenantId } }))
        .id;
    const prices = await this.stripe.prices.list({
      lookup_keys: [PLANS[p.plan].priceLookupKey!],
      limit: 1,
    });
    const price = prices.data[0];
    if (price === undefined)
      throw new BillingConfigError(
        `no Stripe price with lookup key ${String(PLANS[p.plan].priceLookupKey)}`,
      );
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
      metadata: { tenant_id: p.tenantId },
      subscription_data: { metadata: { tenant_id: p.tenantId } },
    });
    if (session.url === null)
      throw new BillingConfigError('Stripe returned a checkout session without a URL');
    return { url: session.url, customerId };
  }

  async createPortal(customerId: string, returnUrl: string): Promise<{ url: string }> {
    const portal = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: portal.url };
  }

  verifyWebhook(rawBody: Buffer | string, signature: string): BillingEvent {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (error) {
      throw new WebhookSignatureError((error as Error).message);
    }
    const parsed = parseStripeEvent(event);
    if (parsed === null) {
      // Verified but irrelevant: acknowledged, never acted on.
      return {
        eventId: event.id,
        type: event.type,
        occurredAt: new Date(event.created * 1000),
        customerId: '',
        subscription: null,
        tenantId: null,
      };
    }
    return parsed;
  }
}
