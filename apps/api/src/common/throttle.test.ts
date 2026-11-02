import { Controller, Get } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { CLIENT_ADDRESS_HEADER, signClientAddress } from '@saas/shared/server';

import type { ApiConfig } from '../config/config';
import { Budget, budgetOf, throttlers, trackerFor } from './throttle';

@Controller()
class Probe {
  @Budget('auth')
  @Get()
  signIn(): void {}

  @Budget('invite')
  @Get()
  create(): void {}

  @Get()
  list(): void {}
}

function contextFor(handler: keyof Probe): ExecutionContext {
  return {
    getHandler: () => Probe.prototype[handler],
    getClass: () => Probe,
  } as unknown as ExecutionContext;
}

const SECRET = 'a-test-secret-of-sufficient-length';
const CONFIG = {
  rateLimitGlobal: 240,
  rateLimitAuth: 5,
  rateLimitInvite: 20,
  authSecret: SECRET,
} as ApiConfig;

describe('throttlers', () => {
  const [general, auth, invite] = throttlers(CONFIG);

  it('applies the auth budget to auth routes ONLY', () => {
    // The bug this file exists to prevent: in @nestjs/throttler v6 every named
    // throttler applies to every route unless it skips. Without `skipIf`, the
    // five-per-minute auth budget would limit the dashboards too.
    expect(auth!.skipIf!(contextFor('signIn'))).toBe(false);
    expect(auth!.skipIf!(contextFor('list'))).toBe(true);
    expect(auth!.skipIf!(contextFor('create'))).toBe(true);
  });

  it('applies the invite budget to invites only', () => {
    expect(invite!.skipIf!(contextFor('create'))).toBe(false);
    expect(invite!.skipIf!(contextFor('list'))).toBe(true);
    expect(invite!.skipIf!(contextFor('signIn'))).toBe(true);
  });

  it('applies the general budget everywhere', () => {
    expect(general!.skipIf).toBeUndefined();
    expect(budgetOf(contextFor('list'))).toBeUndefined();
  });

  it('keys a counter by budget and caller, not by route', () => {
    // Per-route keys would let a flood split itself across sign-in and sign-up
    // and get twice the budget.
    const key = auth!.generateKey!(contextFor('signIn'), 'ip:1.2.3.4', 'auth');
    expect(key).toBe('throttle:auth:ip:1.2.3.4');
  });
});

describe('trackerFor', () => {
  const NOW = 1_793_660_000;
  const signed = (address: string, secret = SECRET) => ({
    [CLIENT_ADDRESS_HEADER]: signClientAddress(address, secret, NOW),
  });

  it('keys a signed-in call by its user (they all arrive from the web server), whatever the address', () => {
    const user = { id: 'u1', email: 'a@b.test', name: 'A' };
    expect(trackerFor({ user, ip: '10.0.0.1', headers: signed('203.0.113.7') }, SECRET, NOW)).toBe(
      'user:u1',
    );
  });

  it('keys an anonymous call by the address the web server vouches for', () => {
    expect(trackerFor({ ip: '10.0.0.1', headers: signed('203.0.113.7') }, SECRET, NOW)).toBe(
      'ip:203.0.113.7',
    );
  });

  it('falls back to the transport address for anything that does not verify', () => {
    // A direct caller cannot sign: it is limited by where it really connects from.
    const forged = { [CLIENT_ADDRESS_HEADER]: 'v1;203.0.113.7;1793660000;AAAA' };
    expect(trackerFor({ ip: '10.0.0.1', headers: forged }, SECRET, NOW)).toBe('ip:10.0.0.1');
    expect(
      trackerFor(
        { ip: '10.0.0.1', headers: signed('203.0.113.7', 'another-secret-entirely') },
        SECRET,
        NOW,
      ),
    ).toBe('ip:10.0.0.1');
    expect(trackerFor({ ip: '10.0.0.1', headers: {} }, SECRET, NOW)).toBe('ip:10.0.0.1');
    expect(trackerFor({ ip: undefined }, SECRET, NOW)).toBe('ip:unknown');
  });

  it('wires the shared secret into the throttlers', () => {
    const [general] = throttlers(CONFIG);
    const tracker = general!.getTracker!(
      {
        ip: '10.0.0.1',
        headers: { [CLIENT_ADDRESS_HEADER]: signClientAddress('203.0.113.9', SECRET) },
      },
      contextFor('list'),
    );
    return expect(Promise.resolve(tracker)).resolves.toBe('ip:203.0.113.9');
  });
});
