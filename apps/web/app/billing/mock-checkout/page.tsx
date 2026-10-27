import { PLANS } from '@saas/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, Submit } from '../../../components/action-form';
import { Brand } from '../../../components/brand';
import { appBaseUrl } from '../../../lib/config';
import { slugFromReturnUrl } from '../../../lib/mock-billing';
import { requireWorkspace } from '../../../lib/workspace';
import { mockBillingAction } from '../../w/actions';

export const metadata = { title: 'Test checkout' };

/**
 * The mock payment provider's checkout (BILLING_DRIVER=mock). Paying here
 * makes the API sign a `customer.subscription.updated` event and deliver it to
 * its own webhook endpoint, so the plan changes through exactly the path a
 * Stripe delivery takes: signature, dedupe, ordering, quota eviction.
 */
export default async function MockCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; success?: string; cancel?: string }>;
}) {
  const q = await searchParams;
  const slug = slugFromReturnUrl(q.success, appBaseUrl);
  const plan = q.plan === 'team' || q.plan === 'business' ? PLANS[q.plan] : null;
  if (slug === null || plan === null) notFound();
  const { workspace } = await requireWorkspace(slug, `/w/${slug}/settings/billing`);

  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Brand />
        <p className="form-ok">
          <span aria-hidden="true">i</span>
          <span>Test mode. No card is charged; this page stands in for the payment provider.</span>
        </p>
        <h1 className="auth-title">
          {plan.name} for {workspace.name}
        </h1>
        <p className="plan-price">${plan.priceUsdMonthly}/month</p>
        <ActionForm
          action={mockBillingAction}
          hidden={{ workspace: slug, plan: plan.id, status: 'active' }}
          className="auth-form"
        >
          <Submit pendingText="Paying">Pay ${plan.priceUsdMonthly}</Submit>
        </ActionForm>
        <Link href={`/w/${slug}/settings/billing?checkout=cancel`}>Cancel and go back</Link>
      </div>
    </main>
  );
}
