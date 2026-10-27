-- Raw events, the hourly rollups the dashboards read, and the aggregator's
-- watermarks. All tenant data, all under FORCED row-level security.

-- --- events: the raw log, range-partitioned by month -----------------------------
--
-- `id` is the client's event id when it sent one (a retried batch is stored
-- once) or one the ingest service generated. The primary key must include the
-- partition key, so it is (tenant_id, id, at); `at` comes from the event, so a
-- retry carries the same value and hits the same key.
--
-- `user_hash` is 16 bytes of SHA-256(tenant_id | user id): unique users are
-- counted from it and the customer's raw user id is never stored.

CREATE TABLE "events" (
  "tenant_id"   UUID           NOT NULL,
  "id"          UUID           NOT NULL,
  "at"          TIMESTAMPTZ(3) NOT NULL,
  "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "event"       TEXT           NOT NULL,
  "user_hash"   BYTEA          NOT NULL,
  "properties"  JSONB          NOT NULL DEFAULT '{}',
  CONSTRAINT "events_pkey" PRIMARY KEY ("tenant_id", "id", "at"),
  CONSTRAINT "events_user_hash_length" CHECK (octet_length("user_hash") = 16),
  CONSTRAINT "events_properties_is_object" CHECK (jsonb_typeof("properties") = 'object')
) PARTITION BY RANGE ("at");

-- Filtered lanes scan raw events by tenant, event and time.
CREATE INDEX "events_tenant_event_at_idx" ON "events" ("tenant_id", "event", "at");
-- The aggregator reads what arrived since its watermark.
CREATE INDEX "events_ingested_at_idx" ON "events" ("ingested_at");

ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "events_isolation" ON "events"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

-- Row-level security is NOT inherited by partitions. A query through the
-- parent applies the parent's policy, but the partitions are tables in their
-- own right, and the default privileges would let saas_app SELECT from
-- `events_y2026m10` directly with no policy at all. So every partition is
-- created here with RLS forced, its own policy, and no grant to saas_app: the
-- parent is the only door. The catalog gate checks partitions like any table.
CREATE FUNCTION "ensure_event_partitions"(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  month_start TIMESTAMPTZ := date_trunc('month', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  last_month  TIMESTAMPTZ := date_trunc('month', p_to AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  part_name   TEXT;
  created     INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ensure_event_partitions'));
  WHILE month_start <= last_month LOOP
    part_name := 'events_' || to_char(month_start AT TIME ZONE 'UTC', '"y"YYYY"m"MM');
    IF to_regclass(format('%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF "events" FOR VALUES FROM (%L) TO (%L)',
        part_name, month_start, (month_start AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC');
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part_name);
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
        part_name || '_isolation', part_name);
      EXECUTE format('REVOKE ALL ON %I FROM saas_app', part_name);
      created := created + 1;
    END IF;
    month_start := (month_start AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC';
  END LOOP;
  RETURN created;
END;
$$;
REVOKE ALL ON FUNCTION "ensure_event_partitions"(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "ensure_event_partitions"(timestamptz, timestamptz) TO saas_app;

-- The default partition, under the same rules, so an event for a month nobody
-- created a partition for is stored rather than refused.
CREATE TABLE "events_default" PARTITION OF "events" DEFAULT;
ALTER TABLE "events_default" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "events_default" FORCE ROW LEVEL SECURITY;
CREATE POLICY "events_default_isolation" ON "events_default"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());
REVOKE ALL ON "events_default" FROM saas_app;

-- Three months back (seeds and late data) and two months ahead; the aggregator
-- calls the function daily, so the ahead-window keeps moving.
SELECT "ensure_event_partitions"(now() - INTERVAL '3 months', now() + INTERVAL '2 months');

-- --- Rollups --------------------------------------------------------------------
--
-- Maintained by services/aggregator, read by the query engine. `users_hll` is a
-- HyperLogLog sketch (precision 11: 2,048 one-byte registers, ~2.3% relative
-- standard error) of the hour's user hashes, merged across hours at query time.

CREATE TABLE "event_hours" (
  "tenant_id" UUID           NOT NULL,
  "hour"      TIMESTAMPTZ(3) NOT NULL,
  "event"     TEXT           NOT NULL,
  "count"     BIGINT         NOT NULL,
  "users_hll" BYTEA          NOT NULL,
  CONSTRAINT "event_hours_pkey" PRIMARY KEY ("tenant_id", "event", "hour"),
  CONSTRAINT "event_hours_count_positive" CHECK ("count" > 0),
  CONSTRAINT "event_hours_hll_length" CHECK (octet_length("users_hll") = 2048)
);

-- One row per (hour, event, property, string value): the breakdowns. Numbers
-- are not values to break down by; booleans are, as 'true'/'false'.
CREATE TABLE "event_dim_hours" (
  "tenant_id" UUID           NOT NULL,
  "hour"      TIMESTAMPTZ(3) NOT NULL,
  "event"     TEXT           NOT NULL,
  "property"  TEXT           NOT NULL,
  "value"     TEXT           NOT NULL,
  "count"     BIGINT         NOT NULL,
  CONSTRAINT "event_dim_hours_pkey" PRIMARY KEY ("tenant_id", "event", "property", "hour", "value"),
  CONSTRAINT "event_dim_hours_count_positive" CHECK ("count" > 0)
);

-- Sums of numeric properties, for the `sum` metric.
CREATE TABLE "event_sum_hours" (
  "tenant_id" UUID             NOT NULL,
  "hour"      TIMESTAMPTZ(3)   NOT NULL,
  "event"     TEXT             NOT NULL,
  "property"  TEXT             NOT NULL,
  "sum"       DOUBLE PRECISION NOT NULL,
  CONSTRAINT "event_sum_hours_pkey" PRIMARY KEY ("tenant_id", "event", "property", "hour")
);

-- How far each tenant's rollups are complete: every event with
-- ingested_at <= through is in them, and none after it is.
CREATE TABLE "aggregation_watermarks" (
  "tenant_id" UUID           NOT NULL,
  "through"   TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "aggregation_watermarks_pkey" PRIMARY KEY ("tenant_id")
);

ALTER TABLE "event_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_hours" FORCE ROW LEVEL SECURITY;
CREATE POLICY "event_hours_isolation" ON "event_hours"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

ALTER TABLE "event_dim_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_dim_hours" FORCE ROW LEVEL SECURITY;
CREATE POLICY "event_dim_hours_isolation" ON "event_dim_hours"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

ALTER TABLE "event_sum_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_sum_hours" FORCE ROW LEVEL SECURITY;
CREATE POLICY "event_sum_hours_isolation" ON "event_sum_hours"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

ALTER TABLE "aggregation_watermarks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "aggregation_watermarks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "aggregation_watermarks_isolation" ON "aggregation_watermarks"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

-- The aggregator's one cross-tenant question: which tenants have events newer
-- than their watermark, up to `p_upto`. Tenant ids only; the aggregation itself
-- then runs inside each tenant's context like everything else.
CREATE FUNCTION "tenants_pending_aggregation"(p_upto TIMESTAMPTZ)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT DISTINCT e."tenant_id"
    FROM "events" e
    LEFT JOIN "aggregation_watermarks" w ON w."tenant_id" = e."tenant_id"
   WHERE e."ingested_at" <= p_upto
     AND e."ingested_at" > coalesce(w."through", '-infinity'::timestamptz)
$$;
REVOKE ALL ON FUNCTION "tenants_pending_aggregation"(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "tenants_pending_aggregation"(timestamptz) TO saas_app;
