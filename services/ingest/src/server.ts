import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import {
  ingestBatchSchema,
  MAX_BATCH,
  type Health,
  type HealthCheck,
  type IngestResult,
} from '@saas/shared';

import { type AdmissionControl } from './admission';
import { type KeyDirectory } from './directory';
import { hashKey, normalise, readKey, type Row } from './normalise';
import { type BatchWriter } from './writer';

/**
 * The HTTP surface: POST /v1/events and GET /health.
 *
 * Order of refusal, cheapest first: no key (401), malformed body (400), unknown
 * key (401), rate (429 + Retry-After), quota (402), invalid events (400, nothing
 * charged), then the write. A refused batch is never partially stored.
 */

export interface Deps {
  pool: Pool;
  redis: Redis;
  directory: KeyDirectory;
  admission: AdmissionControl;
  writer: BatchWriter;
  version: string;
  now?: () => Date;
}

const problem = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  code,
  message,
  ...extra,
});

export function buildServer(deps: Deps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  // 500 events x 32 KB is the theoretical worst; a megabyte is generous for
  // real batches and stops a client posting a gigabyte.
  const app = Fastify({ bodyLimit: 1_048_576, logger: false });

  app.post('/v1/events', async (request, reply) => {
    const key = readKey(
      request.headers.authorization,
      request.headers['x-api-key'] as string | undefined,
    );
    if (key === null)
      return reply
        .code(401)
        .send(problem('UNAUTHENTICATED', 'Send an API key: Authorization: Bearer sk_...'));

    const parsed = ingestBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      // Paths only, never the values: the values are the customer's data.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].slice(0, 20);
      return reply
        .code(400)
        .send(
          problem(
            'INVALID',
            `That batch is not valid (at most ${String(MAX_BATCH)} events, see fields).`,
            { fields },
          ),
        );
    }

    const owner = await deps.directory.lookup(hashKey(key));
    if (owner === null)
      return reply
        .code(401)
        .send(problem('UNAUTHENTICATED', 'That API key is not valid or has been revoked.'));

    const at = now();
    const rows: Row[] = [];
    const invalid: { index: number; reason: string }[] = [];
    parsed.data.events.forEach((e, i) => {
      const n = normalise(owner.tenantId, e, i, at);
      if (n.ok) rows.push(n.row);
      else invalid.push({ index: n.index, reason: n.reason });
    });
    if (invalid.length > 0)
      return reply.code(400).send(
        problem('INVALID', 'Some events were refused; nothing was stored.', {
          events: invalid.slice(0, 20),
        }),
      );

    const admission = await deps.admission.admit(owner.tenantId, owner.plan, rows.length, at);
    if (admission.outcome === 'rate') {
      return reply
        .code(429)
        .header('retry-after', String(Math.max(1, Math.ceil(admission.retryAfterMs / 1000))))
        .send(
          problem(
            'RATE_LIMITED',
            `This workspace sends more than ${String(owner.plan.ingestRps)} events per second on its plan.`,
          ),
        );
    }
    if (admission.outcome === 'quota') {
      return reply.code(402).send(
        problem(
          'QUOTA_EXCEEDED',
          `This batch would exceed the workspace's ${owner.plan.monthlyEvents.toLocaleString('en-US')} events this month. Upgrade the plan or wait for the month to roll over.`,
          {
            used: admission.used,
            limit: admission.limit,
          },
        ),
      );
    }

    let inserted: number;
    try {
      ({ inserted } = await deps.writer.write(owner.tenantId, rows));
    } catch (error) {
      // Charged but not stored: give the quota back, answer 503 so the client retries.
      await deps.admission.refund(owner.tenantId, rows.length, at).catch(() => undefined);
      request.log.error(error);
      return reply
        .code(503)
        .header('retry-after', '1')
        .send(problem('UNAVAILABLE', 'The events could not be stored; retry the batch.'));
    }
    const duplicates = rows.length - inserted;
    await deps.admission.refund(owner.tenantId, duplicates, at).catch(() => undefined);

    const body: IngestResult = {
      accepted: inserted,
      duplicates,
      remainingThisMonth: Math.max(
        0,
        owner.plan.monthlyEvents - (admission.usedAfter - duplicates),
      ),
    };
    return reply.code(202).send(body);
  });

  app.get('/health', async (_request, reply) => {
    const timed = async (name: string, probe: () => Promise<unknown>): Promise<HealthCheck> => {
      const started = Date.now();
      try {
        await Promise.race([
          probe(),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout after 1000ms')), 1000)),
        ]);
        return { name, status: 'ok', latencyMs: Date.now() - started, detail: null };
      } catch (error) {
        return {
          name,
          status: 'fail',
          latencyMs: Date.now() - started,
          detail: (error as Error).message,
        };
      }
    };
    const checks = await Promise.all([
      timed('postgres', () => deps.pool.query('SELECT 1')),
      timed('redis', () => deps.redis.ping()),
    ]);
    const body: Health = {
      status: checks.every((c) => c.status === 'ok') ? 'ok' : 'degraded',
      service: 'ingest',
      version: deps.version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    };
    return reply
      .code(body.status === 'ok' ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(body);
  });

  return app;
}
