import { describe, expect, it } from 'vitest';

import { isLocalDatabase, seedApiKey } from './seed-key';

const PUBLISHED = 'sk_demo_fieldnote_local_dev_only_0000';
const LOCAL = 'postgresql://saas_app:pw@localhost:5443/saas?schema=public';
const HOSTED = 'postgresql://saas_app:pw@ep-x-pooler.us-east-2.aws.neon.tech/saas?sslmode=require';
const SECRET = 'sk_live_demo_0123456789abcdef0123456789';

describe('isLocalDatabase', () => {
  it.each([
    ['postgresql://u:p@localhost:5443/saas', true],
    ['postgresql://u:p@127.0.0.1:5443/saas', true],
    ['postgresql://u:p@[::1]:5443/saas', true],
    ['postgresql://u:p@postgres:5432/saas', true],
    [HOSTED, false],
    ['postgresql://u:p@localhost.evil.example/saas', false],
  ])('%s -> %s', (url, local) => {
    expect(isLocalDatabase(url)).toBe(local);
  });
});

describe('seedApiKey', () => {
  it('uses the published key on a local database when nothing is set', () => {
    expect(seedApiKey({ DATABASE_URL: LOCAL }, PUBLISHED)).toEqual({
      key: PUBLISHED,
      name: 'Demo key (local only)',
    });
  });

  it('refuses a hosted database without SEED_API_KEY, naming the host and the fix', () => {
    expect(() => seedApiKey({ DATABASE_URL: HOSTED }, PUBLISHED)).toThrow(
      /ep-x-pooler\.us-east-2\.aws\.neon\.tech.*SEED_API_KEY/u,
    );
    expect(() => seedApiKey({ DATABASE_URL: HOSTED, SEED_API_KEY: '  ' }, PUBLISHED)).toThrow(
      /SEED_API_KEY/u,
    );
  });

  it('uses SEED_API_KEY wherever it is set', () => {
    expect(seedApiKey({ DATABASE_URL: HOSTED, SEED_API_KEY: SECRET }, PUBLISHED)).toEqual({
      key: SECRET,
      name: 'Demo key',
    });
    expect(seedApiKey({ DATABASE_URL: LOCAL, SEED_API_KEY: SECRET }, PUBLISHED).key).toBe(SECRET);
  });

  it('refuses the published key passed back in as SEED_API_KEY', () => {
    expect(() => seedApiKey({ DATABASE_URL: HOSTED, SEED_API_KEY: PUBLISHED }, PUBLISHED)).toThrow(
      /published/u,
    );
  });

  it('refuses a short or malformed key', () => {
    for (const bad of [
      'sk_short',
      'pk_0123456789abcdef0123456789abcdef',
      'sk_has spaces in it 0123456789',
    ]) {
      expect(() => seedApiKey({ DATABASE_URL: HOSTED, SEED_API_KEY: bad }, PUBLISHED)).toThrow(
        /at least 29/u,
      );
    }
  });
});
