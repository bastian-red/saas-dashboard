import { z } from 'zod';

import { EVENT_NAME, PROPERTY_NAME } from './events';
import { idSchema } from './primitives';

/**
 * A lane: one row of a dashboard, and one query.
 *
 * The web app renders it as a sentence ("**Unique users** who did **Signed up**,
 * by **plan**") and every token is one field below. The query engine compiles it
 * to SQL over the rollups, so every field is closed: a metric from a list, an
 * event and a property from the event grammar, filter operators from a list.
 * Nothing here is ever concatenated into SQL as text.
 *
 * All lanes of a dashboard share ONE time range, which is the dashboard's, not
 * the lane's: that is what lets one crosshair read every lane at one instant.
 */
export const METRICS = ['count', 'unique_users', 'sum'] as const;
export const metricSchema = z.enum(METRICS);

export const VIZ = ['line', 'stacked', 'number', 'table'] as const;
export const vizSchema = z.enum(VIZ);

export const FILTER_OPS = ['eq', 'neq'] as const;

export const eventNameSchema = z.string().regex(EVENT_NAME);
export const propertyNameSchema = z.string().regex(PROPERTY_NAME);

export const laneFilterSchema = z
  .object({
    property: propertyNameSchema,
    op: z.enum(FILTER_OPS),
    value: z.string().max(256),
  })
  .strict();

/** At most three series per breakdown lane; the rest fold into "Other" (dataviz: categorical cap). */
export const MAX_SERIES = 3;

export const laneSpecSchema = z
  .object({
    metric: metricSchema,
    event: eventNameSchema,
    /** Required for `sum`, refused otherwise. */
    sumProperty: propertyNameSchema.nullable().default(null),
    breakdown: propertyNameSchema.nullable().default(null),
    filters: z.array(laneFilterSchema).max(3).default([]),
    viz: vizSchema.default('line'),
  })
  .strict()
  .refine((s) => (s.metric === 'sum') === (s.sumProperty !== null), {
    message: 'sum needs a numeric property, and only sum takes one',
    path: ['sumProperty'],
  })
  .refine((s) => s.viz !== 'stacked' || s.breakdown !== null, {
    message: 'a stacked lane needs a breakdown',
    path: ['breakdown'],
  });

export const laneSchema = z.object({
  id: idSchema,
  title: z.string().max(80).nullable(),
  position: z.number().int().nonnegative(),
  /** Lane height in px rows of 8, so resizing is coarse and keyboard-friendly. */
  height: z.number().int().min(10).max(60),
  spec: laneSpecSchema,
});

export const RANGES = ['24h', '7d', '30d', '90d'] as const;
export const rangeSchema = z.enum(RANGES);

export const dashboardSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  range: rangeSchema,
  lanes: z.array(laneSchema),
  updatedAt: z.string().datetime(),
});

export const dashboardSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  lanes: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

export const createDashboardSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const updateDashboardSchema = z
  .object({ name: z.string().trim().min(1).max(80).optional(), range: rangeSchema.optional() })
  .strict();
export const createLaneSchema = z
  .object({
    title: z.string().trim().max(80).nullable().default(null),
    spec: laneSpecSchema,
    height: z.number().int().min(10).max(60).default(20),
  })
  .strict();
export const updateLaneSchema = z
  .object({
    title: z.string().trim().max(80).nullable().optional(),
    spec: laneSpecSchema.optional(),
    height: z.number().int().min(10).max(60).optional(),
  })
  .strict();
/** Reorder: the full list of lane ids in their new order (must be a permutation). */
export const reorderLanesSchema = z.object({ order: z.array(idSchema).min(1).max(30) }).strict();

/** One lane's result, bucketed on the dashboard's shared axis. */
export const laneResultSchema = z.object({
  laneId: idSchema,
  /** Series keys: the breakdown values (top 3 + "Other"), or ["value"]. */
  series: z.array(z.string()),
  /** points[i] is the bucket at `buckets[i]`; values[j] belongs to series[j]. */
  points: z.array(z.array(z.number().nonnegative())),
  /** For `unique_users`: the estimate's relative standard error, shown with the number. */
  error: z.number().nonnegative().nullable(),
  total: z.number().nonnegative(),
});

export const dashboardDataSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  bucket: z.enum(['hour', 'day']),
  tz: z.string(),
  buckets: z.array(z.string().datetime()),
  lanes: z.array(laneResultSchema),
});

export type LaneSpec = z.infer<typeof laneSpecSchema>;
export type Lane = z.infer<typeof laneSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
export type LaneResult = z.infer<typeof laneResultSchema>;
export type DashboardData = z.infer<typeof dashboardDataSchema>;
export type RangeKey = z.infer<typeof rangeSchema>;
