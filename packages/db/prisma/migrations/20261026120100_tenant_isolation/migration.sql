-- Tenant isolation: the application role, row-level security on every tenant
-- table, and the few audited functions that are allowed to look across tenants.
--
-- Every object is NAMED, and the names are exported from src/tenancy.ts so the
-- catalog gate and scripts/db-drift.mjs check them by name.

-- --- The application role --------------------------------------------------
--
-- Created without LOGIN and without a password: scripts/db-app-role.mjs sets
-- both from APP_DATABASE_URL after migrating, so no credential is ever written
-- into a migration. NOBYPASSRLS and owning no table are the two properties that
-- make every policy below binding on it (a table OWNER skips RLS unless the
-- table is FORCED, and a BYPASSRLS role skips it always).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saas_app') THEN
    CREATE ROLE saas_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO saas_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO saas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO saas_app;
-- The migration ledger is the owner's business.
REVOKE ALL ON "_prisma_migrations" FROM saas_app;

-- --- The tenant context ---------------------------------------------------------
--
-- Set per transaction by the services: SELECT set_config('app.tenant_id', $1, true).
-- `true` means LOCAL: it dies with the transaction, so a pooled connection can
-- never carry one request's tenant into the next request. Unset, the setting
-- reads as '' (missing_ok), nullif turns that into NULL, and `tenant_id = NULL`
-- is never true: no tenant context means no rows, not all rows.

CREATE FUNCTION "app_current_tenant"() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- --- Row-level security ---------------------------------------------------------
--
-- USING filters what a statement can see; WITH CHECK refuses a row being
-- written into another tenant. FORCE applies both to the table owner too, so a
-- service that somehow connected as the owner would still be bound.

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenants_isolation" ON "tenants"
  USING ("id" = app_current_tenant()) WITH CHECK ("id" = app_current_tenant());

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memberships_isolation" ON "memberships"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invites" FORCE ROW LEVEL SECURITY;
CREATE POLICY "invites_isolation" ON "invites"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "api_keys_isolation" ON "api_keys"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

ALTER TABLE "dashboards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboards" FORCE ROW LEVEL SECURITY;
CREATE POLICY "dashboards_isolation" ON "dashboards"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

ALTER TABLE "lanes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lanes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lanes_isolation" ON "lanes"
  USING ("tenant_id" = app_current_tenant()) WITH CHECK ("tenant_id" = app_current_tenant());

-- --- Invariants Prisma cannot express ------------------------------------------

-- Deferrable, so a reorder can rewrite every position in one transaction.
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_dashboard_position_key"
  UNIQUE ("dashboard_id", "position") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_valid"
  CHECK ("role" IN ('owner', 'admin', 'analyst', 'viewer'));
ALTER TABLE "invites" ADD CONSTRAINT "invites_role_valid"
  CHECK ("role" IN ('owner', 'admin', 'analyst', 'viewer'));
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_valid"
  CHECK ("plan" IN ('free', 'team', 'business'));
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_range_valid"
  CHECK ("range" IN ('24h', '7d', '30d', '90d'));
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_spec_is_object"
  CHECK (jsonb_typeof("spec") = 'object');

-- A workspace always has exactly one owner at least: refuse deleting or
-- demoting the last one. A trigger rather than application code, because a
-- race between two admins demoting each other is exactly where code checks lie.
CREATE FUNCTION "memberships_keep_an_owner"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."role" = 'owner' AND (TG_OP = 'DELETE' OR NEW."role" <> 'owner') THEN
    -- Serialise owner changes per tenant so two concurrent demotions cannot
    -- each see the other's owner still in place.
    PERFORM pg_advisory_xact_lock(hashtext('owners:' || OLD."tenant_id"::text));
    IF NOT EXISTS (
      SELECT 1 FROM "memberships"
       WHERE "tenant_id" = OLD."tenant_id" AND "role" = 'owner' AND "user_id" <> OLD."user_id"
    ) AND EXISTS (SELECT 1 FROM "tenants" WHERE "id" = OLD."tenant_id") THEN
      RAISE EXCEPTION 'a workspace must keep at least one owner' USING ERRCODE = '23514', CONSTRAINT = 'memberships_keep_an_owner';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER "memberships_keep_an_owner"
  BEFORE UPDATE OR DELETE ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION memberships_keep_an_owner();

-- --- The audited doors across tenants --------------------------------------------
--
-- Four questions have to be answered before a tenant is known, and each gets
-- one SECURITY DEFINER function that answers exactly that question and nothing
-- else. They run as the owner (so RLS does not apply inside them), take only an
-- opaque key, and return only what the caller needs to then set a tenant
-- context. `search_path` is pinned so a malicious object in another schema
-- cannot be resolved inside them. EXECUTE goes to saas_app only.

-- Which workspaces does this signed-in user belong to (the switcher, and the
-- membership check on every request).
CREATE FUNCTION "user_workspaces"(p_user_id text)
RETURNS TABLE (tenant_id uuid, slug text, name text, role text, plan text, subscription_status text, branding jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT t."id", t."slug", t."name", m."role", t."plan", t."subscription_status", t."branding"
    FROM "memberships" m JOIN "tenants" t ON t."id" = m."tenant_id"
   WHERE m."user_id" = p_user_id
   ORDER BY t."name"
$$;

-- Which workspace does this API key belong to (every ingest request).
CREATE FUNCTION "tenant_for_api_key"(p_key_hash text)
RETURNS TABLE (tenant_id uuid, key_id text, plan text, subscription_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT k."tenant_id", k."id", t."plan", t."subscription_status"
    FROM "api_keys" k JOIN "tenants" t ON t."id" = k."tenant_id"
   WHERE k."key_hash" = p_key_hash AND k."revoked_at" IS NULL
$$;

-- Which invite is this link for (accepting an invite before being a member).
CREATE FUNCTION "invite_by_token"(p_token_hash text)
RETURNS TABLE (tenant_id uuid, invite_id text, email text, role text, expires_at timestamptz, accepted_at timestamptz, workspace_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT i."tenant_id", i."id", i."email", i."role", i."expires_at", i."accepted_at", t."name"
    FROM "invites" i JOIN "tenants" t ON t."id" = i."tenant_id"
   WHERE i."token_hash" = p_token_hash
$$;

-- Which workspace is this payment-provider customer (every billing webhook).
CREATE FUNCTION "tenant_for_customer"(p_customer_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT "id" FROM "tenants" WHERE "provider_customer_id" = p_customer_id $$;

REVOKE ALL ON FUNCTION "user_workspaces"(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "tenant_for_api_key"(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "invite_by_token"(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "tenant_for_customer"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "user_workspaces"(text) TO saas_app;
GRANT EXECUTE ON FUNCTION "tenant_for_api_key"(text) TO saas_app;
GRANT EXECUTE ON FUNCTION "invite_by_token"(text) TO saas_app;
GRANT EXECUTE ON FUNCTION "tenant_for_customer"(text) TO saas_app;
