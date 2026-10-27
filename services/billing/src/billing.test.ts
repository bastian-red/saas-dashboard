import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import {
  createBilling,
  MockBilling,
  signPayload,
  StripeBilling,
  WebhookSignatureError,
} from './index';

const SECRET = 'mock-secret-at-least-16';

describe('the mock driver', () => {
  const mock = new MockBilling(SECRET, 'http://localhost:3000');

  it('round-trips a signed subscription event', () => {
    const { body, signature } = mock.mockEvent({
      type: 'customer.subscription.updated',
      customerId: 'cus_1',
      subscription: {
        id: 'sub_1',
        plan: 'team',
        status: 'active',
        currentPeriodEnd: new Date('2026-11-26T00:00:00Z'),
      },
      occurredAt: new Date('2026-10-26T12:00:00Z'),
      eventId: 'evt_1',
    });
    expect(mock.verifyWebhook(body, signature)).toEqual({
      eventId: 'evt_1',
      type: 'customer.subscription.updated',
      occurredAt: new Date('2026-10-26T12:00:00Z'),
      customerId: 'cus_1',
      tenantId: null,
      subscription: {
        id: 'sub_1',
        plan: 'team',
        status: 'active',
        currentPeriodEnd: new Date('2026-11-26T00:00:00Z'),
      },
    });
  });

  it('refuses a tampered body, a wrong secret and a stale timestamp', () => {
    const { body, signature } = mock.mockEvent({
      type: 'customer.subscription.deleted',
      customerId: 'cus_1',
    });
    expect(() => mock.verifyWebhook(body.replace('cus_1', 'cus_2'), signature)).toThrow(
      WebhookSignatureError,
    );
    expect(() =>
      new MockBilling('another-secret-16chars', 'x').verifyWebhook(body, signature),
    ).toThrow(WebhookSignatureError);
    const stale = signPayload(body, SECRET, Math.floor(Date.now() / 1000) - 3600);
    expect(() => mock.verifyWebhook(body, stale)).toThrow(/tolerance/u);
  });

  it('sends checkout to the web app, carrying the plan and the tenant', async () => {
    const r = await mock.createCheckout({
      tenantId: 't1',
      customerId: null,
      email: 'a@b.co',
      plan: 'team',
      successUrl: 's',
      cancelUrl: 'c',
    });
    expect(r.url).toMatch(
      /^http:\/\/localhost:3000\/billing\/mock-checkout\?customer=cus_mock_[0-9a-f]+&plan=team&tenant=t1/u,
    );
  });
});

describe("the Stripe driver (offline: signatures are checked with Stripe's own library)", () => {
  const WEBHOOK_SECRET = 'whsec_test_secret';
  const billing = new StripeBilling('sk_test_offline', WEBHOOK_SECRET);
  const event = {
    id: 'evt_stripe_1',
    object: 'event',
    type: 'customer.subscription.updated',
    created: 1792584000,
    data: {
      object: {
        id: 'sub_9',
        object: 'subscription',
        customer: 'cus_9',
        status: 'past_due',
        current_period_end: 1795262400,
        metadata: { tenant_id: '11111111-1111-4111-8111-111111111111' },
        items: { data: [{ price: { lookup_key: 'business_monthly' } }] },
      },
    },
  };

  it('verifies a Stripe-signed payload and normalises it', () => {
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    expect(billing.verifyWebhook(payload, header)).toEqual({
      eventId: 'evt_stripe_1',
      type: 'customer.subscription.updated',
      occurredAt: new Date(1792584000 * 1000),
      customerId: 'cus_9',
      tenantId: '11111111-1111-4111-8111-111111111111',
      subscription: {
        id: 'sub_9',
        plan: 'business',
        status: 'past_due',
        currentPeriodEnd: new Date(1795262400 * 1000),
      },
    });
  });

  it('refuses a payload signed with another secret', () => {
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' });
    expect(() => billing.verifyWebhook(payload, header)).toThrow(WebhookSignatureError);
  });

  it('refuses a live key outright: nothing in this portfolio is deployed', () => {
    expect(() => new StripeBilling('sk_live_abc', WEBHOOK_SECRET)).toThrow(/TEST key/u);
  });
});

describe('createBilling', () => {
  it('fails at boot on a misconfigured driver instead of falling back', () => {
    expect(() =>
      createBilling({
        driver: 'stripe',
        stripeSecretKey: '',
        stripeWebhookSecret: '',
        mockSecret: '',
        appBaseUrl: 'x',
      }),
    ).toThrow(/STRIPE_SECRET_KEY/u);
    expect(() =>
      createBilling({
        driver: 'paypal',
        stripeSecretKey: '',
        stripeWebhookSecret: '',
        mockSecret: '',
        appBaseUrl: 'x',
      }),
    ).toThrow(/stripe or mock/u);
    expect(
      createBilling({
        driver: 'mock',
        stripeSecretKey: '',
        stripeWebhookSecret: '',
        mockSecret: SECRET,
        appBaseUrl: 'x',
      }).name,
    ).toBe('mock');
  });
});
