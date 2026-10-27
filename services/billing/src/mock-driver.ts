import { randomBytes } from 'node:crypto';

import { planIdSchema, subscriptionStatusSchema } from '@saas/shared';

import { signPayload, verifySignature } from './signature';
import type { BillingEvent, BillingProvider, CheckoutParams } from './types';
import { WebhookSignatureError } from './types';

/**
 * The mock provider. Checkout and the portal are pages of the web app
 * (`/billing/mock-checkout`, `/billing/mock-portal`), and paying or canceling
 * there makes the API emit a signed event through `mockEvent` into its own
 * webhook endpoint, exactly as Stripe would POST one.
 */

export interface MockEventInput {
  customerId: string;
  tenantId?: string;
  type:
    | 'checkout.session.completed'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted';
  subscription?: { id: string; plan: string; status: string; currentPeriodEnd: Date | null };
  occurredAt?: Date;
  eventId?: string;
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

export class MockBilling implements BillingProvider {
  readonly name = 'mock' as const;

  constructor(
    private readonly secret: string,
    private readonly appBaseUrl: string,
  ) {}

  async createCheckout(p: CheckoutParams): Promise<{ url: string; customerId: string }> {
    const customerId = p.customerId ?? id('cus_mock');
    const q = new URLSearchParams({
      customer: customerId,
      plan: p.plan,
      tenant: p.tenantId,
      success: p.successUrl,
      cancel: p.cancelUrl,
    });
    return { url: `${this.appBaseUrl}/billing/mock-checkout?${q.toString()}`, customerId };
  }

  async createPortal(customerId: string, returnUrl: string): Promise<{ url: string }> {
    const q = new URLSearchParams({ customer: customerId, return: returnUrl });
    return { url: `${this.appBaseUrl}/billing/mock-portal?${q.toString()}` };
  }

  /** Build a signed delivery: the raw body and the header, as a provider would send them. */
  mockEvent(input: MockEventInput): { body: string; signature: string } {
    const body = JSON.stringify({
      id: input.eventId ?? id('evt_mock'),
      type: input.type,
      created: Math.floor((input.occurredAt ?? new Date()).getTime() / 1000),
      data: {
        customer: input.customerId,
        tenant: input.tenantId ?? null,
        subscription:
          input.subscription === undefined
            ? null
            : {
                ...input.subscription,
                current_period_end: input.subscription.currentPeriodEnd?.toISOString() ?? null,
              },
      },
    });
    return { body, signature: signPayload(body, this.secret) };
  }

  verifyWebhook(rawBody: Buffer | string, signature: string): BillingEvent {
    verifySignature(rawBody, signature, this.secret);
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    let e: {
      id: string;
      type: string;
      created: number;
      data: {
        customer: string;
        tenant: string | null;
        subscription: {
          id: string;
          plan: string;
          status: string;
          current_period_end: string | null;
        } | null;
      };
    };
    try {
      e = JSON.parse(text) as typeof e;
    } catch {
      throw new WebhookSignatureError('Body is not JSON');
    }
    const s = e.data.subscription;
    return {
      eventId: e.id,
      type: e.type,
      occurredAt: new Date(e.created * 1000),
      customerId: e.data.customer,
      tenantId: e.data.tenant,
      subscription:
        s === null
          ? null
          : {
              id: s.id,
              plan: planIdSchema.parse(s.plan),
              status: subscriptionStatusSchema.parse(s.status),
              currentPeriodEnd:
                s.current_period_end === null ? null : new Date(s.current_period_end),
            },
    };
  }
}
