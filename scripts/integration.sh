#!/usr/bin/env bash
#
# The integration lane: real Postgres (as the RLS-bound app role), real Redis,
# every service's integration suite.
#
#   ./scripts/integration.sh              # everything
#   ./scripts/integration.sh isolation    # only API suite files matching "isolation"
#
# Its own database (saas_it) and Redis database (1), so it never touches what
# `pnpm dev` is using. Every budget is the DOCUMENTED one from .env.example:
# the suites spread signed-in calls over fresh users and anonymous calls over
# random addresses, which is how real traffic is keyed, and a lane that lifts a
# limit hides that limit's bugs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

APP_BASE="${DATABASE_URL:-postgresql://saas_app:saas_app_dev_password@localhost:5443/saas?schema=public}"
OWNER_BASE="${DIRECT_DATABASE_URL:-postgresql://saas_owner:saas_owner@localhost:5443/saas?schema=public}"
export DATABASE_URL="${INTEGRATION_DATABASE_URL:-${APP_BASE/\/saas\?/\/saas_it?}}"
export DIRECT_DATABASE_URL="${INTEGRATION_DIRECT_DATABASE_URL:-${OWNER_BASE/\/saas\?/\/saas_it?}}"
BASE_REDIS="${REDIS_URL:-redis://localhost:6389}"
export REDIS_URL="${INTEGRATION_REDIS_URL:-${BASE_REDIS%/}/1}"
[[ -n "${AUTH_SECRET:-}" ]] || export AUTH_SECRET=integration-auth-secret-0123456789
[[ -n "${BILLING_MOCK_SECRET:-}" ]] || export BILLING_MOCK_SECRET=integration-billing-mock-secret
export BILLING_DRIVER=mock

echo "integration: build"
pnpm exec turbo run build --output-logs=errors-only >/dev/null

echo "integration: database ${DIRECT_DATABASE_URL%%\?*} (owner) / app role, redis ${REDIS_URL}"
node -e "
  const { Client } = require('./packages/db/node_modules/pg');
  const url = new URL(process.env.DIRECT_DATABASE_URL);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres'; url.search = '';
  const c = new Client({ connectionString: url.toString() });
  c.connect()
    .then(() => c.query('SELECT 1 FROM pg_database WHERE datname = \$1', [name]))
    .then((r) => (r.rowCount === 0 ? c.query('CREATE DATABASE \"' + name + '\"') : null))
    .finally(() => c.end());
"
node -e "
  const { Redis } = require('./services/ingest/node_modules/ioredis');
  const r = new Redis(process.env.REDIS_URL);
  r.flushdb().finally(() => r.disconnect());
"
pnpm --filter @saas/db exec prisma migrate deploy >/dev/null
node scripts/db-app-role.mjs
node scripts/db-drift.mjs

echo "integration: ingest"
pnpm --filter @saas/ingest exec vitest run --config vitest.integration.config.ts
echo "integration: aggregator"
pnpm --filter @saas/aggregator exec vitest run --config vitest.integration.config.ts
echo "integration: API"
if [[ $# -gt 0 ]]; then
  pnpm --filter @saas/api exec vitest run --config vitest.integration.config.ts "$@"
else
  pnpm --filter @saas/api exec vitest run --config vitest.integration.config.ts
fi
