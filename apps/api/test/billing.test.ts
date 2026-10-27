/**
 * SPECS outcome 8: provider webhooks exactly once, out-of-order safe, and
 * signature-verified, through the real endpoint with signed bodies.
 */
import { MockBilling, signPayload } from '@saas/billing';
import type { Billing, SessionUser } from '@saas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { boot, call, newUser, newWorkspace, type Harness } from './support';

let harness: Harness;
let owner: SessionUser;
let mock: MockBilling;
const tenants: string[] = [];

beforeAll(async () => {
  harness = await boot();
  owner = await newUser(harness.db, 'bill-owner');
  mock = new MockBilling(process.env.BILLING_MOCK_SECRET ?? '', 'http://localhost:3000');
});

afterAll(async () => {
  await harness.db.tenant.deleteMany({ where: { id: { in: tenants } } });
  await harness.db.user.deleteMany({ where: { id: owner.id } });
  await harness.close();
});

/** POST a raw body with a signature header, as a provider does. */
async function deliver(
  body: string,
  signature: string,
): Promise<{ status: number; outcome: string }> {
  const r = await fetch(`${harness.base}/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body,
  });
  const json = (await r.json()) as { outcome?: string };
  return { status: r.status, outcome: json.outcome ?? '' };
}

async function workspaceWithCustomer(label: string) {
  const w = await newWorkspace(harness, owner, label);
  tenants.push(w.id);
  const customerId = `cus_test_${w.id.slice(0, 8)}`;
  await harness.db.tenant.update({ where: { id: w.id }, data: { providerCustomerId: customerId } });
  return { ...w, customerId };
}

const sub = (plan: string, status: string) => ({
  id: 'sub_1',
  plan,
  status,
  currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
});

describe('the billing webhook', () => {
  it('applies a subscription once, however many times it is delivered', async () => {
    const w = await workspaceWithCustomer('wh-dup');
    const e = mock.mockEvent({
      type: 'customer.subscription.updated',
      customerId: w.customerId,
      subscription: sub('team', 'active'),
      eventId: `evt_dup_${w.id}`,
    });
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => deliver(e.body, e.signature)),
    );
    expect(outcomes.map((o) => o.status)).toEqual([200, 200, 200, 200, 200]);
    expect(outcomes.filter((o) => o.outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'duplicate')).toHaveLength(4);
    const b = await call<Billing>(harness, 'GET', `/workspaces/${w.slug}/billing`, { user: owner });
    expect(b.body).toMatchObject({ plan: 'team', status: 'active', effectivePlan: 'team' });
    expect(await harness.db.webhookEvent.count({ where: { eventId: `evt_dup_${w.id}` } })).toBe(1);
  });

  it('ignores an older event that arrives after a newer one', async () => {
    const w = await workspaceWithCustomer('wh-order');
    const t0 = new Date(Date.now() - 60_000);
    const canceled = mock.mockEvent({
      type: 'customer.subscription.deleted',
      customerId: w.customerId,
      subscription: sub('team', 'canceled'),
      occurredAt: new Date(t0.getTime() + 30_000),
    });
    const active = mock.mockEvent({
      type: 'customer.subscription.updated',
      customerId: w.customerId,
      subscription: sub('team', 'active'),
      occurredAt: t0,
    });
    expect((await deliver(canceled.body, canceled.signature)).outcome).toBe('applied');
    expect((await deliver(active.body, active.signature)).outcome).toBe('stale');
    const b = await call<Billing>(harness, 'GET', `/workspaces/${w.slug}/billing`, { user: owner });
    expect(b.body).toMatchObject({ status: 'canceled', effectivePlan: 'free' });
  });

  it('refuses a bad signature with 400, and a replay outside the tolerance', async () => {
    const w = await workspaceWithCustomer('wh-sig');
    const e = mock.mockEvent({
      type: 'customer.subscription.updated',
      customerId: w.customerId,
      subscription: sub('business', 'active'),
    });
    expect((await deliver(e.body.replace('business', 'team'), e.signature)).status).toBe(400);
    expect((await deliver(e.body, signPayload(e.body, 'not-the-secret-at-all'))).status).toBe(400);
    expect(
      (
        await deliver(
          e.body,
          signPayload(
            e.body,
            process.env.BILLING_MOCK_SECRET ?? '',
            Math.floor(Date.now() / 1000) - 3600,
          ),
        )
      ).status,
    ).toBe(400);
    const b = await call<Billing>(harness, 'GET', `/workspaces/${w.slug}/billing`, { user: owner });
    expect(b.body.plan).toBe('free');
  });

  it("records and ignores an event for a customer that is nobody's", async () => {
    const e = mock.mockEvent({
      type: 'customer.subscription.updated',
      customerId: 'cus_nobody',
      subscription: sub('team', 'active'),
    });
    expect(await deliver(e.body, e.signature)).toEqual({ status: 200, outcome: 'ignored' });
  });

  it('publishes the plan change to the ingest service', async () => {
    const w = await workspaceWithCustomer('wh-pub');
    const sub2 = harness.redis.duplicate();
    const got: string[] = [];
    await sub2.subscribe('ingest:invalidate');
    sub2.on('message', (_c: string, m: string) => got.push(m));
    const e = mock.mockEvent({
      type: 'customer.subscription.updated',
      customerId: w.customerId,
      subscription: sub('team', 'active'),
    });
    await deliver(e.body, e.signature);
    await new Promise((r) => setTimeout(r, 200));
    sub2.disconnect();
    expect(got).toContain(w.id);
  });
});

describe('checkout and the portal', () => {
  it('sends the owner to the mock checkout with a customer recorded, and the portal after', async () => {
    const w = await newWorkspace(harness, owner, 'wh-checkout');
    tenants.push(w.id);
    const portalBefore = await call(harness, 'POST', `/workspaces/${w.slug}/billing/portal`, {
      user: owner,
    });
    expect(portalBefore.status).toBe(422);
    const c = await call<{ url: string }>(
      harness,
      'POST',
      `/workspaces/${w.slug}/billing/checkout`,
      { user: owner, body: { plan: 'team' } },
    );
    expect(c.status).toBe(201);
    expect(c.body.url).toContain('/billing/mock-checkout?customer=cus_mock_');
    const t = await harness.db.tenant.findUniqueOrThrow({ where: { id: w.id } });
    expect(t.providerCustomerId).toMatch(/^cus_mock_/u);
    expect(
      (await call(harness, 'POST', `/workspaces/${w.slug}/billing/portal`, { user: owner })).status,
    ).toBe(201);
  });
});
