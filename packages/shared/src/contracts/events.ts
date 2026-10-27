import { z } from 'zod';

/**
 * The ingest contract: what a customer's backend POSTs to `/v1/events`.
 *
 * Deliberately small and strict. Event and property NAMES are identifiers the
 * query engine later puts into SQL (as bound values, but also as the keys of
 * the rollups), so they are restricted to a grammar that cannot carry anything
 * surprising; property VALUES are strings, numbers or booleans, flattened, with
 * a size cap, because an analytics store that accepts arbitrary JSON becomes a
 * second database nobody designed.
 */
export const EVENT_NAME = /^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/u;
export const PROPERTY_NAME = /^[a-z][a-z0-9_]{0,39}$/u;
export const MAX_BATCH = 500;
export const MAX_PROPERTIES = 25;
export const MAX_EVENT_BYTES = 32 * 1024;

const propertyValue = z.union([z.string().max(256), z.number().finite(), z.boolean()]);

export const ingestEventSchema = z
  .object({
    event: z
      .string()
      .regex(EVENT_NAME, 'an event name: a letter, then letters, digits, space, _ . -; at most 64'),
    /** The customer's own id for their user. Hashed before storage, never shown raw. */
    userId: z.string().min(1).max(128),
    /** ISO 8601. Defaults to the time of ingest; at most 7 days in the past, 5 minutes ahead. */
    timestamp: z.string().datetime({ offset: true }).optional(),
    properties: z
      .record(
        z.string().regex(PROPERTY_NAME, 'a property name: lowercase letters, digits and _'),
        propertyValue,
      )
      .refine(
        (p) => Object.keys(p).length <= MAX_PROPERTIES,
        `at most ${String(MAX_PROPERTIES)} properties`,
      )
      .default({}),
    /**
     * Optional client-generated id. A retried batch with the same ids AND
     * timestamps is stored once. The timestamp is part of the key because the
     * events table is partitioned by it, and a partitioned table's unique key
     * must include the partition column; an id sent without a timestamp would
     * get a fresh "now" on every retry and be stored twice, so that is refused.
     */
    id: z.string().uuid().optional(),
  })
  .strict()
  .refine((e) => e.id === undefined || e.timestamp !== undefined, {
    message: 'an event with an id must also carry its timestamp, so a retry is recognised',
    path: ['timestamp'],
  });

export const ingestBatchSchema = z
  .object({ events: z.array(ingestEventSchema).min(1).max(MAX_BATCH) })
  .strict();

export const ingestResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  /** Events left this month after this batch. */
  remainingThisMonth: z.number().int().nonnegative(),
});

export const MAX_PAST_MS = 7 * 24 * 3_600_000;
export const MAX_FUTURE_MS = 5 * 60_000;

export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type IngestBatch = z.infer<typeof ingestBatchSchema>;
export type IngestResult = z.infer<typeof ingestResultSchema>;
