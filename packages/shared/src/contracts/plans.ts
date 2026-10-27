import { z } from 'zod';

/**
 * The plan catalogue. A plan is a monthly event quota and a seat limit; the
 * prices are display-only (the payment provider owns the real ones, keyed by
 * `priceLookupKey`). Changing a quota here changes what the ingest service
 * enforces the moment a subscription moves to the plan.
 */
export const PLAN_IDS = ['free', 'team', 'business'] as const;
export const planIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof planIdSchema>;

export interface Plan {
  id: PlanId;
  name: string;
  /** Events accepted per calendar month (UTC). */
  monthlyEvents: number;
  seats: number;
  /** Ingest requests per second per workspace, the noisy-neighbour bound. */
  ingestRps: number;
  priceUsdMonthly: number;
  /** The provider's price lookup key; null for the free plan. */
  priceLookupKey: string | null;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = Object.freeze({
  free: {
    id: 'free',
    name: 'Free',
    monthlyEvents: 100_000,
    seats: 3,
    ingestRps: 20,
    priceUsdMonthly: 0,
    priceLookupKey: null,
  },
  team: {
    id: 'team',
    name: 'Team',
    monthlyEvents: 5_000_000,
    seats: 15,
    ingestRps: 200,
    priceUsdMonthly: 49,
    priceLookupKey: 'team_monthly',
  },
  business: {
    id: 'business',
    name: 'Business',
    monthlyEvents: 50_000_000,
    seats: 100,
    ingestRps: 1000,
    priceUsdMonthly: 299,
    priceLookupKey: 'business_monthly',
  },
});

export const SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/**
 * The plan a workspace actually gets. A subscription that is not paid for
 * (canceled, incomplete) falls back to free; past_due keeps the paid plan for
 * the provider's retry window, because cutting a paying customer's ingest over
 * a declined card retry is worse than a few days of grace.
 */
export function effectivePlan(plan: PlanId, status: SubscriptionStatus | null): PlanId {
  if (status === null) return 'free';
  return status === 'active' || status === 'trialing' || status === 'past_due' ? plan : 'free';
}
