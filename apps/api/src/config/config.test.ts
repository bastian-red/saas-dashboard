import { describe, expect, it } from 'vitest';

import { BootError, assertConsistent } from './boot';
import { ConfigError, loadConfig } from './config';

/** A complete environment, so every test changes exactly one thing. */
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_VERSION: '0.1.0',
    API_PORT: '4000',
    DATABASE_URL: 'postgresql://saas_app:pw@localhost:5443/saas',
    REDIS_URL: 'redis://localhost:6389',
    AUTH_SECRET: 'x'.repeat(32),
    APP_BASE_URL: 'http://localhost:3000',
    INGEST_PUBLIC_URL: 'http://localhost:4200',
    INGEST_INTERNAL_URL: 'http://localhost:4200',
    AGGREGATOR_INTERNAL_URL: 'http://localhost:4300',
    RATE_LIMIT_GLOBAL: '240',
    RATE_LIMIT_AUTH: '5',
    RATE_LIMIT_INVITE: '20',
    BILLING_DRIVER: 'mock',
    BILLING_MOCK_SECRET: 'm'.repeat(32),
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('reads the documented environment', () => {
    const config = loadConfig(env());
    expect(config.port).toBe(4000);
    expect(config.billingDriver).toBe('mock');
  });

  it('prefers PORT over API_PORT, and falls through an empty PORT', () => {
    expect(loadConfig(env({ PORT: '4200' })).port).toBe(4200);
    expect(loadConfig(env({ PORT: '' })).port).toBe(4000);
  });

  it('names every missing variable in one message', () => {
    expect(() => loadConfig(env({ DATABASE_URL: undefined, AUTH_SECRET: undefined }))).toThrow(
      /DATABASE_URL[\s\S]*AUTH_SECRET/u,
    );
  });

  it('refuses an unknown billing driver', () => {
    expect(() => loadConfig(env({ BILLING_DRIVER: 'paypal' }))).toThrow(ConfigError);
  });

  it('strips a trailing slash from service URLs', () => {
    expect(loadConfig(env({ INGEST_PUBLIC_URL: 'https://ingest.example/' })).ingestPublicUrl).toBe(
      'https://ingest.example',
    );
  });
});

describe('assertConsistent', () => {
  it('accepts the documented defaults', () => {
    expect(() => assertConsistent(loadConfig(env()))).not.toThrow();
  });

  it('refuses special budgets at or above the global one', () => {
    expect(() => assertConsistent(loadConfig(env({ RATE_LIMIT_AUTH: '240' })))).toThrow(
      /credential-stuffing/u,
    );
    expect(() => assertConsistent(loadConfig(env({ RATE_LIMIT_INVITE: '300' })))).toThrow(
      /RATE_LIMIT_INVITE/u,
    );
  });

  it('refuses to connect as anything but the RLS-bound application role', () => {
    expect(() =>
      assertConsistent(
        loadConfig(env({ DATABASE_URL: 'postgresql://saas_owner:pw@localhost:5443/saas' })),
      ),
    ).toThrow(BootError);
  });

  it('refuses a billing driver without its secrets', () => {
    expect(() => assertConsistent(loadConfig(env({ BILLING_MOCK_SECRET: 'short' })))).toThrow(
      /BILLING_MOCK_SECRET/u,
    );
    expect(() => assertConsistent(loadConfig(env({ BILLING_DRIVER: 'stripe' })))).toThrow(
      /STRIPE_SECRET_KEY/u,
    );
  });
});
