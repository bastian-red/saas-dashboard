import { billingSchema, PLANS } from '@saas/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, Submit } from '../../../components/action-form';
import { Brand } from '../../../components/brand';
import { apiFetch } from '../../../lib/api';
import { appBaseUrl } from '../../../lib/config';
import { slugFromReturnUrl } from '../../../lib/mock-billing';
import { requireWorkspace } from '../../../lib/workspace';
import { mockBillingAction } from '../../w/actions';

export const metadata = { title: 'Test subscription portal' };

/** The mock provider's customer portal: switch plan or cancel, delivered as signed webhooks. */
export default async function MockPortalPage({
  searchParams,
}: {
  searchParams: Promise<{ return?: string }>;
}) {
  const q = await searchParams;
  const slug = slugFromReturnUrl(q.return, appBaseUrl);
  if (slug === null) notFound();
  const { user, workspace } = await requireWorkspace(slug, `/w/${slug}/settings/billing`);
  const billing = await apiFetch(user, `/workspaces/${slug}/billing`, billingSchema);
  const paid = billing.plan === 'free' ? 'team' : billing.plan;

  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Brand />
        <p className="form-ok">
          <span aria-hidden="true">i</span>
          <span>Test mode. This page stands in for the payment provider&apos;s portal.</span>
        </p>
        <h1 className="auth-title">{workspace.name}&apos;s subscription</h1>
        <p>
          {PLANS[billing.plan].name}, {billing.status ?? 'no subscription'}.
        </p>
        {(['team', 'business'] as const)
          .filter((p) => p !== billing.plan || billing.status !== 'active')
          .map((p) => (
            <ActionForm
              key={p}
              action={mockBillingAction}
              hidden={{ workspace: slug, plan: p, status: 'active' }}
            >
              <Submit className="button" pendingText="Switching">
                Switch to {PLANS[p].name} (${PLANS[p].priceUsdMonthly}/mo)
              </Submit>
            </ActionForm>
          ))}
        {billing.status === 'active' ? (
          <ActionForm
            action={mockBillingAction}
            hidden={{ workspace: slug, plan: paid, status: 'canceled' }}
          >
            <Submit className="button button-danger" pendingText="Canceling">
              Cancel subscription
            </Submit>
          </ActionForm>
        ) : null}
        <Link href={`/w/${slug}/settings/billing`}>Back to the workspace</Link>
      </div>
    </main>
  );
}
