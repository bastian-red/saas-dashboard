import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { addHash, emptySketch, estimate, mergeInto, STANDARD_ERROR } from './hll';

const userHash = (tenant: string, user: string) =>
  createHash('sha256').update(`${tenant}|${user}`).digest().subarray(0, 16);

function sketchOf(users: string[]): Uint8Array {
  const s = emptySketch();
  for (const u of users) addHash(s, userHash('t', u));
  return s;
}

describe('HyperLogLog', () => {
  it('counts an empty set as 0 and a single user as 1', () => {
    expect(estimate(emptySketch())).toBe(0);
    expect(estimate(sketchOf(['ada']))).toBe(1);
  });

  it('ignores duplicates: 500 events from 50 users make the same sketch as the 50 users', () => {
    // Not `toBe(50)`: HLL is an estimate even at small counts (this one reads
    // 51, a register collision). The property is that repeats add nothing.
    const events = Array.from({ length: 500 }, (_, i) => `u${String(i % 50)}`);
    const distinct = Array.from({ length: 50 }, (_, i) => `u${String(i)}`);
    expect(Buffer.from(sketchOf(events)).equals(Buffer.from(sketchOf(distinct)))).toBe(true);
    expect(Math.abs(estimate(sketchOf(events)) - 50)).toBeLessThanOrEqual(2);
  });

  it.each([1_000, 10_000, 100_000])('estimates %d distinct users within 3 standard errors', (n) => {
    const est = estimate(sketchOf(Array.from({ length: n }, (_, i) => `user-${String(i)}`)));
    expect(Math.abs(est - n) / n).toBeLessThan(3 * STANDARD_ERROR);
  });

  it('merges as a set union: overlapping halves count once', () => {
    const a = sketchOf(Array.from({ length: 6000 }, (_, i) => `u${String(i)}`));
    const b = sketchOf(Array.from({ length: 6000 }, (_, i) => `u${String(i + 3000)}`));
    mergeInto(a, b);
    expect(Math.abs(estimate(a) - 9000) / 9000).toBeLessThan(3 * STANDARD_ERROR);
  });

  it('is the same sketch however the stream is split, which is what lets hours be merged', () => {
    const users = Array.from({ length: 3000 }, (_, i) => `u${String(i)}`);
    const whole = sketchOf(users);
    const left = sketchOf(users.slice(0, 1700));
    mergeInto(left, sketchOf(users.slice(1700)));
    expect(Buffer.from(left).equals(Buffer.from(whole))).toBe(true);
  });
});
