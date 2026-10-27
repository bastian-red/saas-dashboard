#!/usr/bin/env bash
#
# The ingest load lane: production builds of api, ingest and the aggregator,
# real Postgres (as the RLS-bound app role) and real Redis, driven by
# scripts/loadtest.mjs (read its header for the two measurements).
#
#   ./scripts/loadtest.sh                       # local budget: accept p99 < 50 ms
#   LOADTEST_P99_MS=150 ./scripts/loadtest.sh   # CI budget (shared runners are noisy)
#
# Its own database (saas_load) and Redis database (2), so it never touches
# what `pnpm dev` or the integration lane use. The per-workspace rate limits
# and quotas are the plan catalogue's real ones: the throughput phase uses
# Business workspaces at half their rate, the noisy phase a Free one at ten
# times its rate. Nothing is lifted.
set -euo pipefail
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

APP_BASE="${DATABASE_URL:-postgresql://saas_app:saas_app_dev_password@localhost:5443/saas?schema=public}"
OWNER_BASE="${DIRECT_DATABASE_URL:-postgresql://saas_owner:saas_owner@localhost:5443/saas?schema=public}"
export DATABASE_URL="${LOADTEST_DATABASE_URL:-${APP_BASE/\/saas\?/\/saas_load?}}"
export DIRECT_DATABASE_URL="${LOADTEST_DIRECT_DATABASE_URL:-${OWNER_BASE/\/saas\?/\/saas_load?}}"
BASE_REDIS="${REDIS_URL:-redis://localhost:6389}"
export REDIS_URL="${LOADTEST_REDIS_URL:-${BASE_REDIS%/}/2}"
[[ -n "${AUTH_SECRET:-}" ]] || export AUTH_SECRET=loadtest-auth-secret-0123456789xx
[[ -n "${BILLING_MOCK_SECRET:-}" ]] || export BILLING_MOCK_SECRET=loadtest-billing-mock-secret-xx
export BILLING_DRIVER=mock
export PORT=""
export NODE_ENV=production

OUT="${LOADTEST_OUT:-/tmp/saas-loadtest}"
export LOADTEST_OUT="$OUT"
mkdir -p "$OUT"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do
    kill -- -"$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

for url in "${API_BASE_URL}/health" "${INGEST_INTERNAL_URL}/health" "${AGGREGATOR_INTERNAL_URL}/health"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    echo "Something is already serving ${url}. Stop it first (pnpm dev?)." >&2
    exit 1
  fi
done

echo "loadtest: build"
pnpm exec turbo run build --filter=@saas/api --filter=@saas/ingest --filter=@saas/aggregator --output-logs=errors-only >/dev/null

echo "loadtest: database ${DIRECT_DATABASE_URL%%\?*}, redis ${REDIS_URL}"
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
node scripts/db-app-role.mjs >/dev/null

echo "loadtest: starting api, ingest, aggregator (logs in ${OUT})"
node apps/api/dist/main.js >"$OUT/api.log" 2>&1 &
PIDS+=($!)
node services/ingest/dist/main.js >"$OUT/ingest.log" 2>&1 &
PIDS+=($!)
node services/aggregator/dist/main.js >"$OUT/aggregator.log" 2>&1 &
PIDS+=($!)
for url in "${API_BASE_URL}/health" "${INGEST_INTERNAL_URL}/health" "${AGGREGATOR_INTERNAL_URL}/health"; do
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$url" 2>/dev/null && break
    sleep 1
  done
  curl -sf -o /dev/null "$url" || {
    echo "${url} never came up." >&2
    tail -30 "$OUT"/*.log >&2
    exit 1
  }
done

node scripts/loadtest.mjs
