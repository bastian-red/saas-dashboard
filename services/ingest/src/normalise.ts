import { createHash, randomUUID } from 'node:crypto';

import { MAX_EVENT_BYTES, MAX_FUTURE_MS, MAX_PAST_MS, type IngestEvent } from '@saas/shared';

/**
 * One validated event to the row that is stored. Pure.
 *
 * - `user_hash`: 16 bytes of SHA-256(tenant | userId). The customer's own user
 *   id never reaches the database, and the tenant is in the hash so the same id
 *   in two workspaces is two different people (it is).
 * - `at`: the event's timestamp, or now; refused if more than 7 days old or 5
 *   minutes in the future. Old data would land in hours the dashboards already
 *   showed (and the aggregator already rolled up); far-future data is a clock
 *   bug on the client and would sit in tomorrow's chart.
 * - `id`: the client's id (a retried batch is stored once) or a fresh one.
 */

export interface Row {
  id: string;
  /**
   * The id came from the client, so a retry can carry it again. Only such rows
   * can conflict: a server-generated v4 UUID is never sent twice.
   */
  clientId: boolean;
  at: Date;
  event: string;
  userHash: Buffer;
  properties: Record<string, string | number | boolean>;
}

export type Normalised = { ok: true; row: Row } | { ok: false; index: number; reason: string };

export function userHash(tenantId: string, userId: string): Buffer {
  return createHash('sha256').update(`${tenantId}|${userId}`).digest().subarray(0, 16);
}

export function normalise(tenantId: string, e: IngestEvent, index: number, now: Date): Normalised {
  const at = e.timestamp === undefined ? now : new Date(e.timestamp);
  if (now.getTime() - at.getTime() > MAX_PAST_MS)
    return { ok: false, index, reason: 'timestamp is more than 7 days in the past' };
  if (at.getTime() - now.getTime() > MAX_FUTURE_MS)
    return { ok: false, index, reason: 'timestamp is more than 5 minutes in the future' };
  if (Buffer.byteLength(JSON.stringify(e), 'utf8') > MAX_EVENT_BYTES)
    return { ok: false, index, reason: 'event is larger than 32 KB' };
  return {
    ok: true,
    row: {
      id: e.id ?? randomUUID(),
      clientId: e.id !== undefined,
      at,
      event: e.event,
      userHash: userHash(tenantId, e.userId),
      properties: e.properties,
    },
  };
}

/** An API key's storage form: SHA-256 hex. Keys are random, so a plain hash suffices. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** `Authorization: Bearer sk_...` or `X-Api-Key: sk_...`; null if neither. */
export function readKey(
  authorization: string | undefined,
  apiKey: string | undefined,
): string | null {
  const bearer = /^bearer\s+(sk_[A-Za-z0-9_-]{20,})$/iu.exec(authorization?.trim() ?? '')?.[1];
  if (bearer !== undefined) return bearer;
  const header = apiKey?.trim();
  return header !== undefined && /^sk_[A-Za-z0-9_-]{20,}$/u.test(header) ? header : null;
}
