/**
 * The billing contract. Everything upstream talks to a `BillingProvider`;
 * nothing upstream imports `stripe`.
 *
 * Two drivers implement it: `stripe` (test mode with test keys) and `mock`, a
 * self-hosted fake whose webhooks carry Stripe's signature header format
 * (`t=<unix>,v1=<hmac of "t.body">`), so the API's verification, dedupe and
 * ordering code is the same code under both, and CI can force duplicates,
 * replays and out-of-order delivery without an account or a network.
 */
import type { PlanId, SubscriptionStatus } from '@saas/shared';

export type DriverName = 'stripe' | 'mock';

export interface CheckoutParams {
  tenantId: string;
  /** Existing provider customer, or null to create one at checkout. */
  customerId: string | null;
  email: string;
  plan: Exclude<PlanId, 'free'>;
  successUrl: string;
  cancelUrl: string;
}

/**
 * A provider event, normalised. The API only ever sees this.
 *
 * `occurredAt` orders events: a subscription state is applied only if it is
 * newer than the one already stored, because providers retry and do not
 * promise order, and "canceled" arriving before the "active" it superseded
 * would otherwise leave a paying customer on the free plan.
 */
export interface BillingEvent {
  eventId: string;
  type: string;
  occurredAt: Date;
  customerId: string;
  /** Present on the subscription events this app acts on. */
  subscription: {
    id: string;
    plan: PlanId;
    status: SubscriptionStatus;
    currentPeriodEnd: Date | null;
  } | null;
  /** Set on checkout completion: the tenant the customer was created for. */
  tenantId: string | null;
}

export interface BillingProvider {
  readonly name: DriverName;
  /** Returns the hosted checkout URL and the customer id it will bill. */
  createCheckout(params: CheckoutParams): Promise<{ url: string; customerId: string }>;
  createPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;
  /** Throws WebhookSignatureError (answered 400, never retried) on a bad signature. */
  verifyWebhook(rawBody: Buffer | string, signature: string): BillingEvent;
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export class BillingConfigError extends Error {}
