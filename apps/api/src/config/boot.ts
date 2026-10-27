/**
 * What must be true before `NestFactory.create` is called.
 *
 * **Every reason this process will not work is discovered before it is
 * listening.** An API that binds :4000 and then fails on the first save looks
 * healthy to a container runtime, gets traffic, and produces a user-facing error
 * for an operational fact that was already true when the process started.
 *
 * Called from `main.ts` before the Nest application exists, so a failure here is
 * a plain sentence on stderr rather than a framework stack with the one useful
 * line buried in the middle of it.
 */
import type { ApiConfig } from './config';

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}

/**
 * The JSON body ceiling `main.ts` gives express. The largest body this API
 * accepts is a lane spec or a provider webhook; 256 KB is generous for both.
 */
export const JSON_BODY_LIMIT_BYTES = 262_144;

export function assertConsistent(config: ApiConfig): void {
  // Auth is the credential-stuffing surface, so its budget is deliberately far
  // below the general one. A configuration where auth is the looser of the two
  // is almost certainly a copy-paste, and it is the exact mistake that turns a
  // rate limit into decoration.
  if (config.rateLimitAuth >= config.rateLimitGlobal) {
    throw new BootError(
      `RATE_LIMIT_AUTH (${String(config.rateLimitAuth)}) must be below RATE_LIMIT_GLOBAL ` +
        `(${String(config.rateLimitGlobal)}). Auth is the credential-stuffing surface; a budget ` +
        'at or above the general one is not a limit.',
    );
  }

  // Invites send email to addresses the inviter chooses: the spam surface.
  if (config.rateLimitInvite >= config.rateLimitGlobal) {
    throw new BootError(
      `RATE_LIMIT_INVITE (${String(config.rateLimitInvite)}) must be below RATE_LIMIT_GLOBAL ` +
        `(${String(config.rateLimitGlobal)}).`,
    );
  }

  // The API must connect as the application role. As the table owner it would
  // read every tenant's rows wherever a policy is not FORCED; scripts/db-app-role.mjs
  // refuses the same thing at migration time.
  if (decodeURIComponent(new URL(config.databaseUrl).username) !== 'saas_app') {
    throw new BootError('DATABASE_URL must log in as saas_app, the role row-level security binds.');
  }

  if (config.billingDriver === 'mock' && config.billingMockSecret.length < 16) {
    throw new BootError('BILLING_DRIVER=mock needs BILLING_MOCK_SECRET of at least 16 characters.');
  }
  if (
    config.billingDriver === 'stripe' &&
    (config.stripeSecretKey === '' || config.stripeWebhookSecret === '')
  ) {
    throw new BootError('BILLING_DRIVER=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.');
  }
}

export function assertBootable(config: ApiConfig): void {
  assertConsistent(config);
}
