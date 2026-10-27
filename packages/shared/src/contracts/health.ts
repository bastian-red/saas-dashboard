import { z } from 'zod';

/**
 * The health shape, shared by the api, ingest and aggregator services so the
 * `/status` page and the E2E suite parse what each one actually sends.
 */

export const healthCheckSchema = z
  .object({
    name: z.string(),
    status: z.enum(['ok', 'fail']),
    latencyMs: z.number().int().nonnegative(),
    /** An error MESSAGE when it failed, never a stack: this body is public. */
    detail: z.string().nullable(),
  })
  .strict();

export const SERVICE_NAMES = ['api', 'ingest', 'aggregator'] as const;

export const healthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    service: z.enum(SERVICE_NAMES),
    version: z.string(),
    uptimeSeconds: z.number().int().nonnegative(),
    checks: z.array(healthCheckSchema),
  })
  .strict();

export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type Health = z.infer<typeof healthSchema>;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** `GET /status`: every service's health, and a sibling that did not answer at all. */
export const unreachableSchema = z.object({
  service: z.enum(SERVICE_NAMES),
  status: z.literal('unreachable'),
  detail: z.string(),
});

export const statusSchema = z.object({
  checkedAt: z.string().datetime(),
  services: z.array(z.union([healthSchema, unreachableSchema])),
});

export type Status = z.infer<typeof statusSchema>;
