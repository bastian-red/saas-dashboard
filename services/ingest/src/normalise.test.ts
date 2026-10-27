import { describe, expect, it } from 'vitest';

import { monthTtlSeconds, quotaMonth } from './admission';
import { hashKey, normalise, readKey, userHash } from './normalise';

const T = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-26T12:00:00.000Z');

describe('normalise', () => {
  it('defaults the timestamp to now and hashes the user id with the tenant', () => {
    const r = normalise(
      T,
      { event: 'Signed up', userId: 'u1', properties: { plan: 'pro' } },
      0,
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.at).toEqual(NOW);
      expect(r.row.userHash).toHaveLength(16);
      expect(r.row.userHash.equals(userHash(T, 'u1'))).toBe(true);
      expect(JSON.stringify(r.row)).not.toContain('"u1"');
    }
  });

  it('treats the same user id in two workspaces as two people', () => {
    expect(userHash(T, 'u1').equals(userHash('22222222-2222-4222-8222-222222222222', 'u1'))).toBe(
      false,
    );
  });

  it('keeps a client id, so a retried batch is stored once', () => {
    const id = '3b241101-e2bb-4255-8caf-4136c566a962';
    const r = normalise(
      T,
      { event: 'x', userId: 'u', id, timestamp: NOW.toISOString(), properties: {} },
      0,
      NOW,
    );
    expect(r.ok && r.row.id).toBe(id);
  });

  it.each([
    ['8 days old', '2026-10-18T11:59:59.000Z', 'more than 7 days in the past'],
    ['6 minutes ahead', '2026-10-26T12:06:00.000Z', 'more than 5 minutes in the future'],
  ])('refuses a timestamp %s', (_n, timestamp, reason) => {
    expect(normalise(T, { event: 'x', userId: 'u', timestamp, properties: {} }, 3, NOW)).toEqual({
      ok: false,
      index: 3,
      reason: `timestamp is ${reason}`,
    });
  });
});

describe('API keys', () => {
  it('reads a bearer key or the X-Api-Key header, and nothing else', () => {
    const key = 'sk_fixture_abcdefghijklmnopq';
    expect(readKey(`Bearer ${key}`, undefined)).toBe(key);
    expect(readKey(undefined, key)).toBe(key);
    expect(readKey('Bearer nope', undefined)).toBeNull();
    expect(readKey('Basic abc', 'not-a-key')).toBeNull();
  });

  it('stores a key as its SHA-256', () => {
    expect(hashKey('sk_x')).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the quota month', () => {
  it('is the UTC month, and its counter lives until a day after it ends', () => {
    expect(quotaMonth(NOW)).toBe('202610');
    expect(quotaMonth(new Date('2026-10-31T23:59:59.999Z'))).toBe('202610');
    expect(quotaMonth(new Date('2026-11-01T00:00:00.000Z'))).toBe('202611');
    expect(monthTtlSeconds(NOW)).toBe(561600);
    expect(monthTtlSeconds(new Date('2026-12-31T23:59:59.000Z'))).toBe(86401);
  });
});
