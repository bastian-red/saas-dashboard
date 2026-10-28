import { billingSchema, can, PLANS, type PlanId } from '@saas/shared';

import { ActionForm, Submit } from '../../../../../components/action-form';
import { apiFetch } from '../../../../../lib/api';
import { formatCompact, formatDate, formatWhole } from '../../../../../lib/format';
import { viewerTimeZone } from '../../../../../lib/viewer';
import { requireWorkspace } from '../../../../../lib/workspace';
import { checkoutAction, portalAction } from '../../../actions';

export const metadata = { title: 'Plan & billing' };

const ORDER: PlanId[] = ['free', 'team', 'business'];

function level(used: number, limit: number): 'ok' | 'warn' | 'danger' {
  const r = limit === 0 ? 1 : used / limit;
  return r >= 1 ? 'danger' : r >= 0.8 ? 'warn' : 'ok';
}

const LEVEL_WORD = {
  ok: '✓ Within plan',
  warn: '! Nearly full',
  danger: '✕ At the limit',
} as const;

function Meter({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number;
  limit: number;
  unit: string;
}) {
  const l = level(used, limit);
  const pct = Math.min(100, limit === 0 ? 100 : (used / limit) * 100);
  return (
    <div className="meter">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
        <span className="field-label">{label}</span>
        <span className="status-word" data-state={l}>
          {LEVEL_WORD[l]}
        </span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${formatWhole(used)} of ${formatWhole(limit)} ${unit}`}
      >
        <div
          className="meter-fill"
          data-level={l === 'ok' ? undefined : l}
          style={{ width: `${String(pct)}%` }}
        />
      </div>
      <span className="muted tabular">
        {formatWhole(used)} of {formatWhole(limit)} {unit}
      </span>
    </div>
  );
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { slug } = await params;
  const { checkout } = await searchParams;
  const { user, workspace } = await requireWorkspace(slug, `/w/${slug}/settings/billing`);
  const [billing, tz] = await Promise.all([
    apiFetch(user, `/workspaces/${slug}/billing`, billingSchema),
    viewerTimeZone(),
  ]);
  const plan = PLANS[billing.effectivePlan];
  const canPay = can(workspace.role, 'billing.write');
  const hidden = { workspace: slug };

  return (
    <>
      <header className="page-head">
        <div className="page-head-text">
          <span className="crumb">{workspace.name} / Settings</span>
          <h1>Plan &amp; billing</h1>
        </div>
      </header>

      {checkout === 'success' ? (
        <p className="form-ok" role="status" style={{ marginBottom: '1rem' }}>
          <span aria-hidden="true">✓</span> Payment received. The {plan.name} plan&apos;s limits
          apply from the next event batch.
        </p>
      ) : checkout === 'cancel' || checkout === 'canceled' ? (
        <p className="form-ok" role="status" style={{ marginBottom: '1rem' }}>
          Nothing was charged.
        </p>
      ) : null}

      <section className="section panel" aria-labelledby="usage-h" data-testid="usage">
        <h2 id="usage-h">
          {plan.name} plan
          {billing.status !== null && billing.status !== 'active' ? (
            <span className="muted"> ({billing.status})</span>
          ) : null}
        </h2>
        {billing.effectivePlan !== billing.plan ? (
          <p className="form-error" role="alert">
            <span aria-hidden="true">⚠</span>
            <span>
              The {PLANS[billing.plan].name} subscription is {billing.status ?? 'not active'}, so
              the Free plan&apos;s limits apply.
            </span>
          </p>
        ) : null}
        <Meter
          label="Events this month"
          used={billing.eventsThisMonth}
          limit={plan.monthlyEvents}
          unit="events"
        />
        <Meter label="Seats" used={billing.seatsUsed} limit={plan.seats} unit="seats" />
        {billing.currentPeriodEnd !== null ? (
          <p className="muted">Renews {formatDate(billing.currentPeriodEnd, tz)}.</p>
        ) : null}
        {canPay && billing.status !== null ? (
          <ActionForm action={portalAction} hidden={hidden} label="Manage subscription">
            <Submit className="button" pendingText="Opening">
              Manage subscription
            </Submit>
          </ActionForm>
        ) : null}
      </section>

      <section className="section" aria-labelledby="plans-h">
        <h2 id="plans-h">Plans</h2>
        <div className="plans">
          {ORDER.map((id) => {
            const p = PLANS[id];
            const current = id === billing.effectivePlan;
            // Moving down a plan is never the primary action on this page: it
            // takes seats and events away. An upgrade is primary; a downgrade
            // is a plain button that says what it is (e2e billing.spec.ts).
            const downgrade = p.priceUsdMonthly < PLANS[billing.effectivePlan].priceUsdMonthly;
            return (
              <div className="plan" key={id} data-current={current}>
                <h3>{p.name}</h3>
                <span className="plan-price">
                  {p.priceUsdMonthly === 0 ? 'Free' : `$${String(p.priceUsdMonthly)}/mo`}
                </span>
                <ul>
                  <li>{formatCompact(p.monthlyEvents)} events a month</li>
                  <li>{p.seats} seats</li>
                  <li>{p.ingestRps} events/s sustained</li>
                </ul>
                {current ? (
                  <span className="status-word" data-state="ok">
                    ✓ Current plan
                  </span>
                ) : canPay && id !== 'free' ? (
                  <ActionForm
                    action={checkoutAction}
                    hidden={{ ...hidden, plan: id }}
                    label={downgrade ? `Downgrade to ${p.name}` : `Upgrade to ${p.name}`}
                  >
                    <Submit
                      pendingText="Opening checkout"
                      className={downgrade ? 'button' : 'button button-primary'}
                    >
                      {downgrade ? `Downgrade to ${p.name}` : `Upgrade to ${p.name}`}
                    </Submit>
                    {downgrade ? (
                      <p className="field-hint">
                        Drops to {formatCompact(p.monthlyEvents)} events and {p.seats} seats at the
                        end of the period.
                      </p>
                    ) : null}
                  </ActionForm>
                ) : null}
              </div>
            );
          })}
        </div>
        {!canPay ? <p className="muted">Only the workspace owner changes the plan.</p> : null}
      </section>
    </>
  );
}
