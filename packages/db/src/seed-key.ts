/**
 * Which ingest key the seed gives the demo workspace.
 *
 * The repo publishes one key (`DEMO_API_KEY` in `prisma/seed.mts`) so the README's
 * curl example and `scripts/dev-smoke.sh` work on a fresh clone. That is fine
 * for a database on the developer's own machine and wrong anywhere else: on the
 * hosted demo it would let anyone who reads the repo write events into it.
 *
 * So the rule fails closed. `SEED_API_KEY`, when set, replaces the published
 * key. When it is not set, the published key is used only if DATABASE_URL points
 * at this machine or the compose network; any other host is refused, so a
 * hosted database cannot receive the published key by forgetting a variable.
 */

/** Hosts that mean "this machine" (or the compose service name for Postgres). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

export interface SeedKey {
  key: string;
  /** What the workspace's key list shows, so nobody mistakes one for the other. */
  name: string;
}

export function isLocalDatabase(databaseUrl: string): boolean {
  return LOCAL_HOSTS.has(new URL(databaseUrl).hostname);
}

export function seedApiKey(
  env: { SEED_API_KEY?: string | undefined; DATABASE_URL: string },
  publishedKey: string,
): SeedKey {
  const chosen = env.SEED_API_KEY?.trim() ?? '';
  if (chosen === '') {
    if (!isLocalDatabase(env.DATABASE_URL)) {
      throw new Error(
        `seed: DATABASE_URL points at ${new URL(env.DATABASE_URL).hostname}, not this machine. ` +
          'Set SEED_API_KEY (sk_..., at least 32 characters) so the published demo key never reaches a hosted database.',
      );
    }
    return { key: publishedKey, name: 'Demo key (local only)' };
  }
  if (chosen === publishedKey) {
    throw new Error('seed: SEED_API_KEY is the key published in the repo. Generate a new one.');
  }
  if (!/^sk_[A-Za-z0-9_]{29,}$/u.test(chosen)) {
    throw new Error(
      'seed: SEED_API_KEY must be sk_ followed by at least 29 letters, digits or underscores.',
    );
  }
  return { key: chosen, name: 'Demo key' };
}

/**
 * The password the seed gives the accounts that OWN a workspace.
 *
 * Same rule, same reason as the key: the repo publishes the owners' passwords so
 * a fresh clone signs straight in, and on a hosted demo those would let any
 * reader delete the workspace, rotate its key or remove its members. The
 * read-only viewer keeps its published password everywhere; that login is the
 * one the hosted sign-in page prints.
 *
 * `null` means "use each account's published password" (local only).
 */
export function seedOwnerPassword(
  env: { SEED_OWNER_PASSWORD?: string | undefined; DATABASE_URL: string },
  publishedPasswords: readonly string[],
): string | null {
  const chosen = env.SEED_OWNER_PASSWORD ?? '';
  if (chosen.trim() === '') {
    if (!isLocalDatabase(env.DATABASE_URL)) {
      throw new Error(
        `seed: DATABASE_URL points at ${new URL(env.DATABASE_URL).hostname}, not this machine. ` +
          'Set SEED_OWNER_PASSWORD so the published owner passwords never reach a hosted database.',
      );
    }
    return null;
  }
  if (publishedPasswords.includes(chosen)) {
    throw new Error('seed: SEED_OWNER_PASSWORD is a password published in the repo. Pick another.');
  }
  if (chosen.length < 16 || chosen !== chosen.trim()) {
    throw new Error(
      'seed: SEED_OWNER_PASSWORD must be at least 16 characters, without surrounding spaces.',
    );
  }
  return chosen;
}
