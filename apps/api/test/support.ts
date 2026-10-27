/**
 * Shared plumbing for the API's integration lane.
 *
 * The Nest application is built from the real `AppModule` and listens on an
 * ephemeral port, so every request below travels the whole stack: the session
 * guard, the throttler, the pipes, the filter, Prisma, Postgres, Redis. Nothing
 * is mocked, because what this lane exists to catch -- a guard that is not
 * default-closed, an upsert that is not idempotent, a trigger that is missing --
 * is a failure of the wiring rather than of a pure function, and the pure
 * functions already have their own tests.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createPrismaClient, type PrismaClient } from '@saas/db';
import type { SessionUser } from '@saas/shared';
import pg from 'pg';
import { mintServiceToken } from '@saas/shared/server';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Redis } from 'ioredis';

import { AppModule } from '../src/app.module';

export const AUTH_SECRET = required('AUTH_SECRET', process.env.AUTH_SECRET);
export const DATABASE_URL = required('DATABASE_URL', process.env.DATABASE_URL);
export const REDIS_URL = required('REDIS_URL', process.env.REDIS_URL);
export const OWNER_URL = required('DIRECT_DATABASE_URL', process.env.DIRECT_DATABASE_URL);

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run this through ./scripts/integration.sh.`);
  }
  return value;
}

export interface Harness {
  readonly app: INestApplication;
  readonly base: string;
  /** The OWNER role's Prisma client: test setup and assertions only, never the code under test. */
  readonly db: PrismaClient;
  /** The APP role, for raw isolation probes. */
  readonly pg: pg.Pool;
  readonly redis: Redis;
  close(): Promise<void>;
}

export async function boot(): Promise<Harness> {
  // The same body parser and proxy trust main.ts sets up, so the harness runs
  // the program that ships.
  const app = await NestFactory.create<
    INestApplication & { set(key: string, value: unknown): void }
  >(AppModule, {
    logger: ['error'],
    // As main.ts: the billing webhook verifies a signature over the raw bytes.
    rawBody: true,
  });
  app.set('trust proxy', 1);
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const server = app.getHttpServer() as { address(): AddressInfo | string | null };
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the API did not bind a port');

  const db = createPrismaClient({ url: OWNER_URL });
  const appPool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const redis = new Redis(REDIS_URL);
  return {
    app,
    base: `http://127.0.0.1:${String(address.port)}`,
    db,
    pg: appPool,
    redis,
    close: async () => {
      await db.$disconnect();
      await appPool.end();
      redis.disconnect();
      await app.close();
    },
  };
}

/**
 * A fresh user for a test. Signed-in calls are rate-limited per user, so a user
 * per suite keeps this lane at the DOCUMENTED budgets without borrowing another
 * suite's minute.
 */
export async function newUser(db: PrismaClient, label: string): Promise<SessionUser> {
  const email = `${label}-${randomUUID().slice(0, 8)}@saas.test`;
  const row = await db.user.create({
    data: { email, name: label, passwordHash: 'not-a-real-hash' },
    select: { id: true },
  });
  return { id: row.id, email, name: label };
}

/** A workspace owned by `owner`, created through the API like a real one. */
export async function newWorkspace(
  harness: Harness,
  owner: SessionUser,
  label: string,
): Promise<{ id: string; slug: string }> {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const r = await call<{ id: string; slug: string }>(harness, 'POST', '/workspaces', {
    user: owner,
    body: { name: label, slug },
  });
  if (r.status !== 201) throw new Error(`create workspace: ${String(r.status)} ${r.text}`);
  return r.body;
}

/** Add `user` to a workspace with `role`, as the owner role would via invite + accept. */
export async function addMember(
  harness: Harness,
  owner: SessionUser,
  slug: string,
  user: SessionUser,
  role: string,
): Promise<void> {
  const inv = await call<{ token: string }>(harness, 'POST', `/workspaces/${slug}/invites`, {
    user: owner,
    body: { email: user.email, role },
  });
  if (inv.status !== 201) throw new Error(`invite: ${String(inv.status)} ${inv.text}`);
  const acc = await call(harness, 'POST', '/workspaces/invites/accept', {
    user,
    body: { token: inv.body.token },
  });
  if (acc.status !== 200) throw new Error(`accept: ${String(acc.status)} ${acc.text}`);
}

/** A query as the APP role with an explicit tenant context (or none). */
export async function asApp<T>(
  harness: Harness,
  tenantId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await harness.pg.connect();
  try {
    await c.query('BEGIN');
    if (tenantId !== null)
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r.rows as T[];
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

export interface Reply<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
  readonly text: string;
}

/** A private address, random per call, so per-address budgets never leak between tests. */
export function randomAddress(): string {
  const octet = () => String(1 + Math.floor(Math.random() * 254));
  return `10.${octet()}.${octet()}.${octet()}`;
}

/**
 * One request.
 *
 * The token is minted per call rather than cached: a cached one works for two
 * minutes and then fails for the rest of the run, and that looks like
 * flakiness. `user: null` sends no `Authorization` header, which is how the
 * default-closed guard and the public routes are exercised. Anonymous calls get
 * a fresh `x-forwarded-for` each unless `address` pins one, so per-address
 * budgets do not leak between tests.
 */
export async function call<T = unknown>(
  harness: Harness,
  method: string,
  path: string,
  options: { user?: SessionUser | null; body?: unknown; secret?: string; address?: string } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { 'x-forwarded-for': options.address ?? randomAddress() };
  if (options.user !== null && options.user !== undefined) {
    headers.authorization = `Bearer ${mintServiceToken(options.user, options.secret ?? AUTH_SECRET)}`;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${harness.base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T, headers: response.headers, text };
}

/** An Authorization header value for `user`, for the few calls that need raw fetch (binary bodies). */
export function bearer(user: SessionUser): string {
  return `Bearer ${mintServiceToken(user, AUTH_SECRET)}`;
}

/** Poll until `check` returns a value, or fail after `timeoutMs`. */
export async function eventually<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 10_000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
