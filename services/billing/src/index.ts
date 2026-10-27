import { MockBilling } from './mock-driver';
import { StripeBilling } from './stripe-driver';
import { BillingConfigError, type BillingProvider } from './types';

export * from './mock-driver';
export * from './signature';
export * from './stripe-driver';
export * from './types';

/**
 * The driver for this environment: Stripe when test keys are configured, the
 * mock otherwise. The choice is explicit in BILLING_DRIVER so a missing key
 * fails at boot instead of silently falling back.
 */
export function createBilling(env: {
  driver: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  mockSecret: string;
  appBaseUrl: string;
}): BillingProvider {
  if (env.driver === 'stripe') {
    if (env.stripeSecretKey === '' || env.stripeWebhookSecret === '') {
      throw new BillingConfigError(
        'BILLING_DRIVER=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.',
      );
    }
    return new StripeBilling(env.stripeSecretKey, env.stripeWebhookSecret);
  }
  if (env.driver === 'mock') {
    if (env.mockSecret.length < 16)
      throw new BillingConfigError(
        'BILLING_DRIVER=mock needs BILLING_MOCK_SECRET (16+ characters).',
      );
    return new MockBilling(env.mockSecret, env.appBaseUrl);
  }
  throw new BillingConfigError(`BILLING_DRIVER must be stripe or mock, not "${env.driver}".`);
}
