import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Redis } from 'ioredis';

import { MAX_BATCH, type Plan } from '@saas/shared';

/**
 * The Lua admission script, and the month arithmetic around it.
 *
 * The quota counter is the source of truth for "how many events this month";
 * Postgres agrees with it to within the batches in flight. A batch that was
 * charged and then failed to write is refunded (`refund`), and so are the
 * duplicates of a retried batch, so a retry never costs quota twice.
 */

// Next to this file in both layouts: `src/` under tsx, `dist/` after the build
// (which copies it there). Not read from `../src`, which a Docker image does not have.
const SOURCE = readFileSync(join(__dirname, 'admission.lua'), 'utf8');

export type Admission =
  | { outcome: 'ok'; usedAfter: number }
  | { outcome: 'rate'; retryAfterMs: number }
  | { outcome: 'quota'; used: number; limit: number };

/** `yyyymm` of `now` in UTC: the quota month. */
export function quotaMonth(now: Date): string {
  return `${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Seconds from `now` to one day after the end of its UTC month: the counter's lifetime. */
export function monthTtlSeconds(now: Date): number {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2);
  return Math.ceil((end - now.getTime()) / 1000);
}

export const quotaKey = (tenantId: string, now: Date): string =>
  `quota:${tenantId}:${quotaMonth(now)}`;

export class AdmissionControl {
  constructor(private readonly redis: Redis) {
    this.redis.defineCommand('admitBatch', { numberOfKeys: 2, lua: SOURCE });
  }

  async admit(tenantId: string, plan: Plan, events: number, now: Date): Promise<Admission> {
    // Per EVENT: `ingestRps` is the plan's events per second.
    const interval = 1000 / plan.ingestRps;
    // Burst: two seconds' worth, but never less than one maximal batch, or a
    // Free workspace (20/s, so 40 events of burst) could never send a batch of
    // 500 at all. A client flushing a backlog after a deploy is not an attack.
    const tolerance = interval * Math.max(plan.ingestRps * 2, MAX_BATCH);
    const reply = (await (
      this.redis as unknown as {
        admitBatch: (...args: (string | number)[]) => Promise<string[]>;
      }
    ).admitBatch(
      `rate:${tenantId}`,
      quotaKey(tenantId, now),
      now.getTime(),
      interval.toFixed(3),
      tolerance.toFixed(3),
      events,
      plan.monthlyEvents,
      monthTtlSeconds(now),
    )) as string[];
    if (reply[0] === 'ok') return { outcome: 'ok', usedAfter: Number(reply[1]) };
    if (reply[0] === 'rate') return { outcome: 'rate', retryAfterMs: Number(reply[1]) };
    if (reply[0] === 'quota')
      return { outcome: 'quota', used: Number(reply[1]), limit: Number(reply[2]) };
    throw new Error(`admission script: unknown reply ${String(reply[0])}`);
  }

  /** Give back quota for events charged but not stored (a failed write, duplicates). */
  async refund(tenantId: string, events: number, chargedAt: Date): Promise<void> {
    if (events > 0) await this.redis.decrby(quotaKey(tenantId, chargedAt), events);
  }
}
