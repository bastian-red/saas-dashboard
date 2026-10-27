#!/usr/bin/env bash
#
# Prove the DOCUMENTED `pnpm dev` serves a working app from a cold start.
#
# Every other lane supplies its own environment (e2e.sh and integration.sh source
# .env and start the apps directly, bypassing turbo), so none of them can see the
# failure that sank three sibling projects for months: turbo in strict env mode
# stripping names the app needs, and `pnpm dev` booting an API with no
# AUTH_SECRET. This script strips every .env name from its own environment with
# `env -u` and runs `pnpm dev` exactly as the README says, so the only way the
# configuration can reach the processes is the path a reader's machine uses:
# scripts/dev.sh sourcing .env, turbo passing declared names through.
#
# Assert on content, never on a status code. A broken app answers 200 with an
# error page. So this requires, across all four processes: every /health ok
# (api, ingest, aggregator); a sign-in through Auth.js; the seeded hero
# dashboard rendering lanes with a unique-users estimate; and one event, sent
# with the seeded demo key to the ingest service, travelling ingest -> Postgres
# -> aggregator -> rollups until the web app's sentence editor offers it.
#
# Negative check: point "dev" in package.json back at
# `turbo run dev` and this fails, because nothing then loads .env.
#
# Usage: ./scripts/dev-smoke.sh      (datastores up, migrated, seeded)
set -euo pipefail
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG="${LOG:-/tmp/saas-dev-smoke.log}"
COOKIES="$(mktemp -t saas-dev-smoke-cookies.XXXXXX)"
DEV_PID=""
WAIT_SECONDS="${WAIT_SECONDS:-120}"

cleanup() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill -- -"$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

die() {
  echo >&2
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f .env ]] || die "no .env in the repo root. See README.md, 'Running it'."

env_value() { sed -n "s/^[[:space:]]*$1=//p" .env | tail -1; }
API_PORT="$(env_value API_PORT)"
WEB_PORT="$(env_value WEB_PORT)"
INGEST_PORT="$(env_value INGEST_PORT)"
AGGREGATOR_HEALTH_PORT="$(env_value AGGREGATOR_HEALTH_PORT)"
API_BASE_URL="http://localhost:${API_PORT:-4000}"
APP_BASE_URL="http://localhost:${WEB_PORT:-3000}"
INGEST_BASE_URL="http://localhost:${INGEST_PORT:-4200}"
AGGREGATOR_BASE_URL="http://localhost:${AGGREGATOR_HEALTH_PORT:-4300}"

# The seeded facts, read out of the seed rather than retyped.
SEED=packages/db/prisma/seed.mts
seed_const() { sed -n "s/^const $1 = '\([^']*\)';.*/\1/p" "$SEED"; }
DEMO_EMAIL="$(seed_const DEMO_EMAIL)"
DEMO_PASSWORD="$(seed_const DEMO_PASSWORD)"
MAIN_SLUG="$(seed_const MAIN_SLUG)"
HERO_DASHBOARD="$(seed_const HERO_DASHBOARD)"
DEMO_API_KEY="$(seed_const DEMO_API_KEY)"
for pair in "DEMO_EMAIL:$DEMO_EMAIL" "DEMO_PASSWORD:$DEMO_PASSWORD" "MAIN_SLUG:$MAIN_SLUG" \
  "HERO_DASHBOARD:$HERO_DASHBOARD" "DEMO_API_KEY:$DEMO_API_KEY"; do
  [[ -n "${pair#*:}" ]] || die "could not read ${pair%%:*} out of ${SEED}."
done

for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/sign-in" "${INGEST_BASE_URL}/health" "${AGGREGATOR_BASE_URL}/health"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    die "something is already serving ${url}. Stop it first."
  fi
done

# Cold, like a fresh clone: no app build output for `dev` to lean on. The
# workspace packages' dist/ is left alone deliberately -- `dev` dependsOn ^build,
# and whether that rebuild happens is part of what is being tested; CI runs this
# on a checkout that has none at all.
echo "==> Removing app build outputs"
for stale in apps/*/dist apps/*/.next; do
  [[ -e "$stale" ]] || continue
  rm -rf "${ROOT:?}/${stale}"
  echo "    removed ${stale}"
done

mapfile -t ENV_KEYS < <(
  sed -n 's/^[[:space:]]*#\?[[:space:]]*\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\1/p' .env.example .env | sort -u
)
[[ ${#ENV_KEYS[@]} -gt 0 ]] || die "parsed no variable names out of .env.example."
UNSET_ARGS=()
for key in "${ENV_KEYS[@]}"; do UNSET_ARGS+=(-u "$key"); done

echo "==> Starting: pnpm dev (${#ENV_KEYS[@]} .env names stripped from the child environment)"
echo "    log: ${LOG}"
env "${UNSET_ARGS[@]}" pnpm dev >"$LOG" 2>&1 &
DEV_PID=$!

wait_for() {
  local url="$1" name="$2"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    curl -sf -o /dev/null "$url" 2>/dev/null && return 0
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "pnpm dev exited before ${name} came up. Last 150 lines of ${LOG}:" >&2
      tail -150 "$LOG" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 150 lines of ${LOG}:" >&2
  tail -150 "$LOG" >&2
  exit 1
}
echo "==> Waiting for api, web, ingest and aggregator"
wait_for "${API_BASE_URL}/health" api
wait_for "${APP_BASE_URL}/sign-in" web
wait_for "${INGEST_BASE_URL}/health" ingest
wait_for "${AGGREGATOR_BASE_URL}/health" aggregator

json_field() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw)[process.argv[1]] ?? "")); } catch {}
    });' "$1"
}

echo "==> Checking /health reports every dependency ok"
for pair in "api:${API_BASE_URL}" "ingest:${INGEST_BASE_URL}" "aggregator:${AGGREGATOR_BASE_URL}"; do
  body="$(curl -s "${pair#*:}/health")"
  [[ "$(json_field status <<<"$body")" == "ok" ]] ||
    die "${pair%%:*} /health is not ok: ${body}"
done

echo "==> Signing in as ${DEMO_EMAIL} through Auth.js"
csrf="$(curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/csrf" | json_field csrfToken)"
[[ -n "$csrf" ]] || die "GET /api/auth/csrf returned no csrfToken. Auth.js is not mounted."
curl -s -o /dev/null -L -c "$COOKIES" -b "$COOKIES" \
  --data-urlencode "csrfToken=${csrf}" \
  --data-urlencode "email=${DEMO_EMAIL}" \
  --data-urlencode "password=${DEMO_PASSWORD}" \
  "${APP_BASE_URL}/api/auth/callback/credentials"
session="$(curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/session")"
grep -qF "$DEMO_EMAIL" <<<"$session" || {
  tail -150 "$LOG" >&2
  die "sign-in produced no session (${session}). AUTH_SECRET never reached a process, or the seed did not run."
}

echo "==> Checking /w/${MAIN_SLUG} lists the seeded dashboard"
list="$(curl -s -L -b "$COOKIES" -c "$COOKIES" "${APP_BASE_URL}/w/${MAIN_SLUG}")"
DASH_PATH="$(grep -o "href=\"/w/${MAIN_SLUG}/d/[a-z0-9]*\"><span class=\"dash-name\">${HERO_DASHBOARD}<" <<<"$list" | head -1 | sed 's|href="||; s|".*||')"
[[ -n "$DASH_PATH" ]] || {
  tail -150 "$LOG" >&2
  die "/w/${MAIN_SLUG} has no link to '${HERO_DASHBOARD}'. It is an error page or an empty shell."
}

echo "==> Checking ${DASH_PATH} renders lanes read from the rollups"
dash="$(curl -s -L -b "$COOKIES" "${APP_BASE_URL}${DASH_PATH}")"
# The unique-users lane states its estimate's error only when the API returned
# a real HyperLogLog result for it; an error page has no such text.
grep -qF "estimate ±2.3%" <<<"$dash" || {
  tail -150 "$LOG" >&2
  die "the dashboard has no unique-users estimate. The query path (api -> RLS -> rollups) is broken."
}
[[ "$(grep -o 'data-testid="lane"' <<<"$dash" | wc -l)" -ge 6 ]] || die "the dashboard rendered fewer than 6 lanes."

EVENT="dev_smoke_$(date +%s)"
echo "==> Sending '${EVENT}' to ingest with the demo key"
code="$(curl -s -o /tmp/saas-dev-smoke-ingest.json -w '%{http_code}' -X POST "${INGEST_BASE_URL}/v1/events" \
  -H "Authorization: Bearer ${DEMO_API_KEY}" -H 'Content-Type: application/json' \
  -d "{\"events\":[{\"event\":\"${EVENT}\",\"userId\":\"dev-smoke\",\"properties\":{\"source\":\"dev-smoke\"}}]}")"
[[ "$code" == "202" ]] || die "ingest answered ${code}: $(cat /tmp/saas-dev-smoke-ingest.json)"

echo "==> Waiting for the aggregator to roll it up (the editor offers only rolled-up events)"
found=0
for _ in $(seq 1 40); do
  if curl -s -L -b "$COOKIES" "${APP_BASE_URL}${DASH_PATH}?edit=new" | grep -qF "$EVENT"; then
    found=1
    break
  fi
  sleep 1
done
[[ $found -eq 1 ]] || {
  tail -60 "$LOG" >&2
  die "'${EVENT}' never reached the rollups (ingest -> Postgres -> aggregator)."
}

echo
echo "PASS: pnpm dev serves all four processes, configured by .env alone, and an event travels ingest -> Postgres -> aggregator -> dashboard."
