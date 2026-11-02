import { describe, expect, it } from 'vitest';

import {
  CLIENT_ADDRESS_MAX_SKEW_SECONDS,
  signClientAddress,
  verifyClientAddress,
} from './client-address';

const SECRET = 'a-test-secret-of-sufficient-length';
const NOW = 1_793_660_000;

describe('client address', () => {
  it.each(['203.0.113.7', '2001:db8::1'])('round-trips %s', (address) => {
    expect(verifyClientAddress(signClientAddress(address, SECRET, NOW), SECRET, NOW)).toBe(address);
  });

  it('accepts a value up to the skew either side, and not one second past it', () => {
    const value = signClientAddress('203.0.113.7', SECRET, NOW);
    const edge = CLIENT_ADDRESS_MAX_SKEW_SECONDS;
    expect(verifyClientAddress(value, SECRET, NOW + edge)).toBe('203.0.113.7');
    expect(verifyClientAddress(value, SECRET, NOW - edge)).toBe('203.0.113.7');
    expect(verifyClientAddress(value, SECRET, NOW + edge + 1)).toBeNull();
    expect(verifyClientAddress(value, SECRET, NOW - edge - 1)).toBeNull();
  });

  it('refuses another secret', () => {
    const value = signClientAddress('203.0.113.7', SECRET, NOW);
    expect(verifyClientAddress(value, `${SECRET}-other`, NOW)).toBeNull();
  });

  it('refuses a swapped address or timestamp under a genuine signature', () => {
    const [v, , stamp, sig] = signClientAddress('203.0.113.7', SECRET, NOW).split(';');
    expect(verifyClientAddress(`${v!};203.0.113.8;${stamp!};${sig!}`, SECRET, NOW)).toBeNull();
    expect(
      verifyClientAddress(`${v!};203.0.113.7;${String(NOW + 1)};${sig!}`, SECRET, NOW),
    ).toBeNull();
  });

  it.each([
    undefined,
    null,
    '',
    '203.0.113.7',
    'v1;203.0.113.7;1793660000',
    'v2;203.0.113.7;1793660000;AAAA',
    'v1;not-an-ip;1793660000;AAAA',
    'v1;203.0.113.7;soon;AAAA',
    'v1;203.0.113.7;1793660000;AAAA',
    `v1;203.0.113.7;1793660000;${'A'.repeat(300)}`,
  ])('refuses %j without throwing', (value) => {
    expect(verifyClientAddress(value, SECRET, NOW)).toBeNull();
  });

  it('refuses to sign something that is not an IP address', () => {
    expect(() => signClientAddress('example.test', SECRET, NOW)).toThrow(/not an IP/u);
  });
});
