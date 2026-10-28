# saas-dashboard: multi-tenant product analytics, isolated by the database itself

[![CI](https://github.com/bastian-red/saas-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/bastian-red/saas-dashboard/actions/workflows/ci.yml)

A product team sends its events with an API key, lines them up on dashboards, and reads every
chart at the same instant with one crosshair. Workspaces have teams with four roles, monthly event
quotas, Stripe billing (test mode, or a signature-compatible mock that needs no network), and their
own accent colour, which the API refuses unless it stays readable everywhere it is painted.

The hard requirement is **tenant isolation**, and it is enforced by PostgreSQL rather than by
remembering a `WHERE` clause: every tenant table has row-level security enabled and forced, every
service logs in as a role that owns nothing and cannot bypass it, and the tenant is set per
transaction. A query that forgets to filter returns this workspace's rows or none, never another's.
Next.js 16, NestJS, Fastify, PostgreSQL 16, Redis.

![The roll call naming what moved, the crosshair reading every lane, the sentence editor, a branded tenant, an unreadable accent refused as a table, plan and usage, the dashboard by night](assets/demo.gif)

```mermaid
flowchart LR
  customer([Customer backend]) -->|"POST /v1/events<br/>API key"| ingest
  member([Team member]) --> web

  subgraph app ["App"]
    web["apps/web<br/>Next.js 16"] -->|service token| api["apps/api<br/>NestJS"]
  end
  subgraph data ["Event pipeline"]
    ingest["services/ingest<br/>Fastify"]
    aggregator["services/aggregator<br/>Node"]
  end

  ingest -->|"1 Lua script: event rate<br/>+ monthly quota, atomic"| redis[(Redis)]
  ingest -->|"group commit, one tx per<br/>workspace, 202 after COMMIT"| pg[(Postgres<br/>FORCED RLS)]
  aggregator -->|"watermarked hourly rollups<br/>+ HyperLogLog sketches"| pg
  api -->|"every query inside<br/>set_config(app.tenant_id)"| pg
  api -->|"plan change: evict<br/>ingest:invalidate"| redis
  stripe([Stripe or mock]) -->|"signed webhook"| api
```

Every arrow into Postgres is the role `saas_app`: `NOBYPASSRLS`, not a superuser, owner of
nothing. Migrations run as `saas_owner`. `FORCE ROW LEVEL SECURITY` binds a table's owner too, but
not a superuser, and in the local Docker image `saas_owner` is the superuser the image creates; the
guarantee is that no service ever connects as it (`apps/api` refuses to boot on a `DATABASE_URL`
that is not `saas_app`).

## The hard part: isolation you cannot forget

Application-level tenancy (`WHERE tenant_id = ?` in every query) fails the first time somebody
writes a query in a hurry. Here the database refuses instead:

- **Policies on every tenant table, forced.** `tenant_id = app_current_tenant()`, where the
  function reads `current_setting('app.tenant_id', true)`. Unset, it is `NULL`, and `= NULL` is
  never true: no context means no rows, not all rows. `WITH CHECK` refuses writing a row into
  another workspace from inside one.
- **The context dies with the transaction.** `set_config(..., true)` is `LOCAL`, so a pooled
  connection can never carry one request's workspace into the next. `withTenant()` and the
  ingest writer are the only ways code reaches tenant data.
- **Partitions are tables too.** RLS is not inherited by partitions, and default privileges would
  let the app role read `events_y2026m10` directly with no policy. Every partition is created with
  its own forced policy and no grant: the parent is the only door.
- **The cross-tenant questions are six audited functions.** "Which workspaces is this user in",
  "whose API key is this", "which invite is this link", "whose Stripe customer is this", "which
  tenants have unaggregated events", "create next month's partitions". Each is `SECURITY DEFINER`
  with a pinned `search_path`, revoked from `PUBLIC`, and listed by name in
  `packages/db/src/tenancy.ts`; a seventh fails the gate.
- **Even foreign keys carry the tenant.** A lane references `(dashboard_id, tenant_id)`, so a lane
  can never be attached to another workspace's dashboard, whatever the API does.

### Proven, not asserted

| What | Test | Shape |
|---|---|---|
| Every table is classified: tenant (RLS + FORCE + policy) or deliberately global | `packages/db/src/tenancy.test.ts` (gate), `apps/api/test/isolation.test.ts` §1 (live catalog) | a new table with a `tenant_id` and no policy fails the commit |
| Raw SQL as `saas_app` with tenant A set returns zero rows of B, for every table; with no tenant set, zero rows | `isolation.test.ts` §2 | each table seeded for two tenants |
| Every workspace route answers **404** to a member of another workspace, with this workspace's real ids | `isolation.test.ts` §3 | 28 routes discovered from the running Nest app, not listed by hand |
| Every role gets **403** exactly where the role matrix says no | `isolation.test.ts` §3 | 4 roles x 28 routes |
| The API refuses to boot if a workspace route has no `@Requires` | `tenancy/route-audit.ts` | boot-time audit |
| In the browser, another workspace is "Nothing here" on every page | `e2e/tests/tenancy.spec.ts` | Chromium and Firefox |

Each of these was proven able to fail: the policy, the guard and the foreign key were removed in
turn, the test went red, and the fix was restored. Doing that for the foreign key found its test
passing for the wrong reason (row-level security refused the forged row first); it now forges a row
only the foreign key can refuse, and asserts on that constraint by name.

## Ingestion: 2,000 events/s, zero loss, and a noisy neighbour moves nobody

`POST /v1/events` takes batches of up to 500. One Redis Lua script per batch checks and charges
the workspace's **event** rate (GCRA, per event, burst of one maximal batch) and its monthly quota,
all or nothing. The writer group-commits: a workspace with no write in flight is written at once;
while one is in flight, whatever arrives goes out together in the next transaction. `202` is sent
only after `COMMIT`, so `202` means on disk. A batch with client ids is idempotent: a retry is
stored once and its quota refunded.

### Measured

`./scripts/loadtest.sh`, production builds, real Postgres and Redis, on a laptop (load generator
on the same machine). Open-loop: requests leave on schedule whether or not earlier ones answered,
so a slow server shows up as latency instead of quietly lowering the offered rate.

| | Result | Budget |
|---|---|---|
| Throughput, 4 Business workspaces x 500 events/s for 20 s | 2,003 events/s, 40,000 of 40,000 accepted | 2,000/s |
| Accept latency (25-event batches) | p50 19.1 ms, p99 38.7 ms | p99 < 50 ms |
| Stored rows vs accepted events, per workspace | equal; 0 lost | 0 |
| Quiet workspace p99, alone vs beside a Free workspace flooding at 10x its rate (720 samples each) | 16.7 ms vs 13.6 ms; flood: 67 of 96 batches refused | within 20% |

The load lane found two real bugs on its first run, and both are now held by tests: the rate limit
charged per *request* (a Free workspace could send 10,000 events/s), and a 50 ms flush timer put a
50 ms floor under every request (p50 was 72 ms).

## Dashboards: lanes on one time axis

A dashboard is a stack of full-width lanes sharing one x-axis, like a trace viewer, not a grid of
cards. Point at any lane, or focus the axis and use the arrow keys, and **every** lane reads out its
value at that instant. Each lane's query is a sentence of editable tokens: "**Unique users who did**
**page_viewed** where **path** is **/projects** by **device** as **a line**". The pickers offer only
what the workspace has actually sent.

The query engine compiles a lane spec to SQL over hourly rollups (identifiers from a closed list,
every value bound, tested with property-generated specs for injection), falling back to raw events
only for filters. Unique users are HyperLogLog sketches merged across buckets, so "users this month"
is distinct people, not a sum of daily counts, and the readout states its ±2.3% error.

`apps/api/test/scale.test.ts`: an 8-lane dashboard over rollups for **13 million events**
(30 days, 8 events, breakdowns, sums, sketches), 30 loads: **p95 260-286 ms** across five runs,
against a 300 ms budget.
The seed's rollups equal a recount of its raw events (`scripts/seed-check.sh`).

## Billing

Free / Team / Business: monthly events, seats, ingest rate. Checkout and the customer portal go
through a `BillingProvider`: Stripe in test mode when keys are set, otherwise a mock whose webhook
signature scheme is Stripe's (`stripe-signature`, `t=…,v1=…`), so CI exercises the real
verification code without the network. The webhook is signature-checked, **exactly once** (the
event id is inserted in the same transaction as the change it causes), **ordered** (an older event
cannot overwrite a newer state), and **immediate** (the ingest service's key cache is evicted, so a
new plan's quota applies to the next batch). A canceled subscription falls back to Free;
`past_due` keeps the paid plan through the provider's retry window.

## The design: the go / no-go poll

A product team opens this in the morning to ask one question: is anything wrong? The visual world
is the control room's go / no-go poll, where every station answers for itself before anyone
studies a display. It lends the type, the palette, the density and one signature move; the
layout and the controls stay the standard ones.

- **The roll call** is the first band on a dashboard. Every lane answers *Up*, *Down*, *Steady* or
  *No baseline*, as a glyph and a word, and each answer jumps to its lane. A lane that moved wears
  the accent, because "moved" is what needs a look; whether up is good news depends on the metric,
  and only the reader knows that. The verdict compares the latest **complete** bucket (the one in
  progress always looks low) with the same slot in earlier periods (the same hour on other days,
  the same weekday in other weeks), with a noise band from the median absolute deviation, and the
  lane prints both numbers and the band: *Tue, Oct 27: 102 against a typical 42; steady from 33 to
  50*. It runs on the data the dashboard already has: a second "previous period" query would
  double every lane's scan, and the 8-lane scale test sits at 260-286 ms of a 300 ms budget
  (`apps/web/lib/rollcall.ts`).
- **The lanes** still run full width on one shared, calendar-aligned time axis (midnights on 7
  days, Mondays on 30, the 1st and 15th on 90, in the dashboard's time zone) with one crosshair
  through all of them. Edit stays visible; moving, resizing and removing live in one labelled
  menu, and Remove asks once more, in words. A number lane's figure sits on its own row above its
  line.

Console grey and signal orchid by day, the same room with the lights down by night, square corners
and hairline seams. Sofia Sans Condensed for figures, verdicts and lane titles (six verdicts fit
one line), Chivo for chrome, Chivo Mono for event names and keys. The three faces are self-hosted
(`apps/web/app/fonts/`, SIL Open Font License beside each), not fetched from Google at build time:
that fetch failed intermittently under Turbopack on CI. An E2E spec asserts all three load and
paint, because a missing font falls back silently. The palette is at least ΔE 2.5 (canvas) and
8 (accent) from every other project in the portfolio.

A tenant's accent tints exactly five marks: the lane rail, primary buttons, the focus ring, the
workspace monogram and the current-page marker. `services/branding` judges a colour against the
product's real surfaces (light: 4.5:1 on all three backgrounds, plus its button label and tint;
dark: a lighter step of the same hue is derived), refuses it with a table of every surface and
its ratio, and offers the nearest shade that passes. A stored accent is **re-judged on every
render**, because it was judged against the backgrounds of the day it was saved: when this
redesign changed the canvas, a seeded accent that had passed at 4.5:1 reached 4.40:1, so the
workspace now paints the nearest passing shade and tells its admin, instead of quietly breaking
contrast. `apps/web/lib/branding.test.ts` holds both halves: the branding
service's surfaces equal the stylesheet, and nothing but those five marks may read `--brand`.

Every colour pair is checked against WCAG AA from the real stylesheet in both schemes
(`contrast.test.ts`), the chart palette was validated for colour-vision deficiency, and axe runs
over every route in both schemes, a branded tenant included, with zero violations.

## Running it

Requirements: Node 20, pnpm 9, Docker.

```bash
git clone https://github.com/bastian-red/saas-dashboard.git
cd saas-dashboard
pnpm install

cp .env.example .env
sed -i "s|^AUTH_SECRET=|AUTH_SECRET=$(openssl rand -base64 32)|" .env
sed -i "s|^BILLING_MOCK_SECRET=|BILLING_MOCK_SECRET=$(openssl rand -base64 32)|" .env

docker compose -f infra/docker-compose.yml up -d   # Postgres :5443, Redis :6389
pnpm db:deploy                                     # migrations as saas_owner, then saas_app's password
pnpm db:seed                                       # 2 workspaces, 3 people, ~82,000 events over 90 days

pnpm dev    # web :3000, api :4000, ingest :4200, aggregator :4300
```

Open http://localhost:3000 and sign in as `sam@fieldnote.test` / `demo-password-2026` (owner of
Fieldnote, analyst in the branded Harbor Labs). `rui@fieldnote.test` / `viewer-password-2026` is a
viewer; `jo@harbor.test` / `outsider-password-2026` belongs to Harbor Labs only.

Send an event with the seeded demo key (a local key for a local database, published on purpose):

```bash
curl -X POST http://localhost:4200/v1/events \
  -H "Authorization: Bearer sk_demo_fieldnote_local_dev_only_0000" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"event":"signed_up","userId":"u_42","properties":{"source":"organic"}}]}'
```

It is on a dashboard a few seconds later, once the aggregator has rolled it up.

The whole stack in containers, migrated and seeded:

```bash
docker compose -f infra/docker-compose.yml --profile app up -d --build
```

`pnpm dev` goes through `scripts/dev.sh`: it loads `.env`, checks the secrets and that
`DATABASE_URL` logs in as `saas_app`, checks Postgres and Redis answer, then starts turbo. Turbo
runs in strict environment mode and reads no `.env` itself, so `turbo run dev` alone would start
four processes with no configuration.

## Testing

| Lane | Command | Count | What it needs |
|---|---|---|---|
| Gate (pre-commit) | `pnpm test` | 385 tests | nothing; seconds |
| Environment contract | `pnpm env:contract` | source, `.env.example`, `turbo.json` agree | nothing |
| Integration | `./scripts/integration.sh` | 49 tests | Postgres, Redis; runs as `saas_app` |
| Ingest load | `./scripts/loadtest.sh` | 2 measurements | Postgres, Redis |
| Seed determinism + recount | `pnpm db:seed:check` | 2 workspaces | a database |
| Dev smoke | `./scripts/dev-smoke.sh` | the documented `pnpm dev`, env stripped | datastores up |
| E2E + accessibility | `./scripts/e2e.sh` | 74 tests (37 x Chromium, Firefox) | datastores up |
| Demo GIF | `./scripts/demo-gif.sh` | 7 frames | ffmpeg, ImageMagick |

The integration and load lanes use their own databases (`saas_it`, `saas_load`) and Redis indexes.
Every lane runs at the **documented** budgets: the E2E browsers each come from their own address,
the integration suites from fresh users. A lane that lifts a limit hides that limit's bugs.

Every claim above has been proven able to fail: the fix was reverted, the test went red, and the
fix was restored. Among them: the RLS policies, the tenant guard, the composite foreign key, the
quota script, the per-event rate limit, webhook dedupe and ordering, the advisory lock in the
aggregator, the branding cascade, the signed-out deep link, the seed's determinism and the
dev-smoke's dependence on `scripts/dev.sh`.

The pre-commit hook runs gitleaks, the environment contract, the invisible-character scan and the
gate lane. CI runs every lane on every push, audits runtime dependencies for critical advisories,
and builds all four Docker images.

## Configuration

Every variable is documented in [`.env.example`](.env.example) and declared in `turbo.json`;
`scripts/env-contract.mjs` fails the commit when the source, `.env.example` and `turbo.json`
disagree. Secrets go in `globalPassThroughEnv`, never `globalEnv`, so a rotated secret never
enters a build cache key.

## Layout

```
apps/web               Next.js: trace view, sentence editor, members, keys, billing, branding, /status
apps/api               NestJS: auth, workspaces, roles, dashboards, query API, billing + webhook, /health, /status
services/ingest        Fastify: POST /v1/events, API keys, Lua admission, group-commit writer
services/aggregator    watermarked hourly rollups per workspace, HyperLogLog sketches, recount
services/query-engine  lane spec -> parameterised SQL; sketch maths; result shaping (pure)
services/billing       BillingProvider: Stripe (test mode) and a signature-compatible mock
services/branding      the tenant-accent WCAG gate and its derived steps (pure)
packages/db            Prisma schema, RLS migrations, partitioned events, seed
packages/shared        zod contracts, role matrix, plan catalogue, errors
e2e                    Playwright
infra                  Dockerfiles and docker-compose.yml
```
