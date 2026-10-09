# Spend guardrails

Cloudflare has no hard spending cap. A loop in a Worker, a queue that
retries forever or a cron that lists KV every second shows up on the bill
weeks later unless something here catches it. This is what catches it,
how to stop it, and what the owner has to set up by hand in Cloudflare's
dashboard. Internal: the public side is the "When g1t pauses work for
everyone" section of `apps/docs/src/content/docs/guides/usage-and-billing.md`
and "How they are enforced" in `guides/guardrails.md`.

## What catches what

| Guardrail | Catches | Where |
| --- | --- | --- |
| A workspace's limits, caps and spike pause | One workspace's agents, sandboxes and builds running away | `services/billing/src/limits.rs`, `compute.rs`; reserved through `ComputeGate.admit` (`packages/contracts/src/compute.ts`) |
| The comped budget and the daily breaker | g1t's own spend on agents: comped accounts, trials, pools; $75 a day pauses hosted-model agent runs g1t pays for | `services/billing/src/budget.rs`; [BILLING_OPERATIONS.md](BILLING_OPERATIONS.md) |
| The daily reconciliation | What Cloudflare billed against what g1t counted, a day later | `services/billing/src/costs.rs`, `margin.rs` |
| **The hourly platform watch** | Platform cost no workspace's limit covers: Workers requests and CPU, D1 rows, Queue operations, Durable Objects, KV, Artifacts. Within the hour. | `services/billing/src/platform.rs` |
| **The platform pause** | A staff (or automatic) brake on whole kinds of work across g1t | `platform.rs`; read by every service through `g1t_kit::pause` (Rust) or `platformPaused` (`packages/contracts/src/platform.ts`) |
| **The models proxy's run cap** | An agent spending past its run's cap by calling the model proxy itself (a prompt-injected `curl`), around the sandbox's `--max-budget-usd` | `services/models/src/spend.ts`, `run-spend.ts` |
| Cloudflare's own notifications | Anything else, by product, as a last line | Set up by hand: [the checklist](#manual-steps-in-cloudflares-dashboard) |

## The hourly platform watch

At a quarter past each hour (billing's `*/15` cron, gated to the tick at
`:15`), billing reads two windows from Cloudflare's GraphQL Analytics API:
the hour before, and the month so far. It uses the costs reconciliation's
token, `CLOUDFLARE_BILLING_TOKEN` (else `CLOUDFLARE_USAGE_TOKEN`), which
needs **Account Analytics Read**. Without either it reads nothing and sudo
says so; the pause still works.

| Metric | Dataset and field | Named by |
| --- | --- | --- |
| `workers_requests` | `workersInvocationsAdaptive` `sum.requests` | script |
| `workers_cpu_ms` | `workersInvocationsAdaptive` `sum.cpuTimeUs` / 1000 | script |
| `d1_rows_read`, `d1_rows_written` | `d1AnalyticsAdaptiveGroups` `sum.rowsRead`, `sum.rowsWritten` | database id |
| `queue_operations` | `queueMessageOperationsAdaptiveGroups` `sum.billableOperations` | queue id |
| `do_requests` | `durableObjectsInvocationsAdaptiveGroups` `sum.requests` | script |
| `do_active_seconds`, `do_storage_write_units` | `durableObjectsPeriodicGroups` `sum.activeTime` (µs), `sum.storageWriteUnits` | namespace id |
| `do_rows_written` | `durableObjectsPeriodicGroups` `sum.rowsWritten` | namespace id |
| `kv_reads`, `kv_writes`, `kv_deletes`, `kv_lists` | `kvOperationsAdaptiveGroups` `sum.requests` by `actionType` | namespace id |
| `artifacts_events` | `artifactsEventsAdaptiveGroups` `count` | repository |

Each metric whose field is less certain has a query of its own, so a
dataset or field GraphQL refuses is logged (`platform watch: skipped …`)
and the others still count. Workers Logs has no dataset here; its volume
follows Workers requests, and log sampling is set per Worker.

Each hour is kept in billing's D1 (`platform_usage`, migration 0050) with
the script, queue, database or namespace that counted most; the month so
far in `platform_usage_month`; breaches in `platform_alerts`.

### Thresholds

Hourly, in `services/billing/wrangler.jsonc` `vars`. Each is about a dollar
to a few dollars an hour at list prices, far above a small alpha's normal
hour. `0` turns a metric's threshold (and its spike rule) off.

| Variable | Default | About |
| --- | --- | --- |
| `PLATFORM_HOURLY_WORKERS_REQUESTS` | 20,000,000 | $6/hour |
| `PLATFORM_HOURLY_WORKERS_CPU_MS` | 100,000,000 | $2/hour |
| `PLATFORM_HOURLY_D1_ROWS_READ` | 2,000,000,000 | $2/hour |
| `PLATFORM_HOURLY_D1_ROWS_WRITTEN` | 5,000,000 | $5/hour |
| `PLATFORM_HOURLY_QUEUE_OPERATIONS` | 5,000,000 | $2/hour |
| `PLATFORM_HOURLY_DO_REQUESTS` | 20,000,000 | $3/hour |
| `PLATFORM_HOURLY_DO_ROWS_WRITTEN` | 5,000,000 | $5/hour |
| `PLATFORM_HOURLY_DO_STORAGE_WRITE_UNITS` | 5,000,000 | $5/hour |
| `PLATFORM_HOURLY_DO_ACTIVE_SECONDS` | 3,000,000 | about $5/hour at 128 MB |
| `PLATFORM_HOURLY_KV_READS` | 10,000,000 | $5/hour |
| `PLATFORM_HOURLY_KV_WRITES` | 200,000 | $1/hour |
| `PLATFORM_HOURLY_KV_DELETES` | 200,000 | $1/hour |
| `PLATFORM_HOURLY_KV_LISTS` | 200,000 | $1/hour |
| `PLATFORM_HOURLY_ARTIFACTS_EVENTS` | 1,000,000 | |

The rules, in order:

1. **Threshold**: an hour over its threshold is a breach.
2. **Spike**: otherwise, an hour over `PLATFORM_SPIKE_FACTOR` (10) times the
   median hour of the week before, and at least `PLATFORM_SPIKE_FLOOR_PERCENT`
   (10%) of its threshold, is a breach. It needs a day of history first.
3. **Severe**: a threshold breach at `PLATFORM_SEVERE_FACTOR` (5) times the
   threshold or more pauses the levels that metric feeds, of those
   `AUTO_PAUSE` names (default `schedules,indexing`; `compute` and `renders`
   are off unless added). Spikes never pause.

| Metric | Feeds |
| --- | --- |
| Workers | schedules, indexing, renders |
| D1, Queues | schedules, indexing |
| Durable Objects, Artifacts | compute, schedules |
| KV | indexing, renders |

On a breach, staff are emailed at `COSTS_ALERT_EMAIL` through billing's
`EMAIL` binding, once per metric every 6 hours (a new automatic pause is
always emailed), and sudo's Costs & margin shows it under **Platform
pause**. The alert names the top script, queue, database or namespace.
Ids are Cloudflare's; `node scripts/ops/platform-usage.mjs` names them.

To change a threshold: edit the variable, push, and billing redeploys. The
next hour reads with it.

### Looking by hand

```sh
node scripts/ops/platform-usage.mjs            # month so far and the last 24 hours
node scripts/ops/platform-usage.mjs --json     # the same, as JSON
```

It needs `CLOUDFLARE_API_TOKEN` (or `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL`) with Account
Analytics Read, as `scripts/deploy/cloudflare.mjs` `cloudflareAuth` reads them, and names ids
with the D1, Queues, KV and Durable Objects listings when the token can
read them.

## The platform pause

Four levels, each independent, kept in billing's `platform_pause` table.

| Level | Stops | Where it is checked |
| --- | --- | --- |
| `compute` | Every reservation through billing's `reserve` except embeddings: agent runs, checks, the merge queue, workflow jobs on g1t's machines, deploy builds. For every workspace and plan, and where payments are not set up. Refused with `paused`. | `services/billing/src/compute.rs` `reserve` |
| `schedules` | Actions' cron-triggered runs (skipped, not run late), and the runner's sweep that starts queued agents (they stay queued) | `services/actions/src/plan.rs` `on_minute`; `services/runner/src/index.ts` `scheduled` |
| `indexing` | Embeddings (refused in `reserve`), context backfills (**Rebuild** refused, queued jobs closed with a note), search backfills (pages parked in search's `meta` and resumed where they were) | `reserve`; `services/context/src/index.ts`; `services/search/src/lib.rs` |
| `renders` | Social cards: a cache miss gets the cached brand card or a redirect to `https://g1t.sh/brand/g1t-logo-on-dark.png`, kept a minute | `services/og/src/index.ts`, `paused.ts` |

Work already running finishes at every level.

**Reads are cheap.** Every caller keeps the flags 30 seconds in its isolate:
billing itself (`pause_now`), Rust services through `g1t_kit::pause`, and
TypeScript services through `platformPaused`. A change reaches everything
within about 30 seconds, and there is never a D1 read per request.

**When the flag cannot be read, nothing is paused** (fail open), and the
failure is kept for the same 30 seconds. A pause is a brake someone pulls
on purpose; failing closed would turn a billing outage into a platform
outage. The other guardrails (workspace limits, the breaker, the model
proxy's run cap) do not depend on it.

### Pausing and resuming

1. Open sudo, **Costs & margin**, **Platform pause** (`https://sudo.g1t.sh/costs#platform`).
2. On the level's card, write why, and choose **Pause** or **Resume**.

Every change is in the audit log (`platform_paused`, `platform_resumed`),
with who and why. While any level is paused, every sudo page shows a red
**Platform pause** bar. A level the usage watcher paused says so and stays
paused until staff resume it: fix or understand the cause first.

Without sudo (billing's RPC, through a service binding):
`admin_set_pause` with `{ "level": "schedules", "paused": false, "note": "…", "by": "you@flagon.io" }`.

## The models proxy's run cap

A run's model cap was only enforced inside the sandbox
(`--max-budget-usd`). Now the proxy holds it too. When a run starts, the
runner gives its model session token (`g1tm_`) the run's cap
(`cap_model_sessions` on integrations). The proxy counts each answer's cost
from its token usage in one `RunSpend` Durable Object per session, so
requests fanned out across isolates cannot each spend the cap. At the cap it
answers `402` with `run_cap_reached`. At most 16 answers are counted in
flight at once, which bounds the overshoot. A session without a cap gets a
$100 backstop. A run token reaches only the message and model routes, and is
closed when the run ends.

## Manual steps in Cloudflare's dashboard

These are the owner's, once per account. None can be set from code.

- [ ] **Billing → Billable Usage notifications** (Manage Account → Billing →
      Notifications, or Notifications → Add → "Usage Based Billing"). Add
      one per product g1t uses: Workers (requests and CPU), Workers KV, D1,
      Queues, Durable Objects, R2, Workers Logs, Containers, Browser
      Rendering, Workers AI and Vectorize. Set each threshold near this
      doc's hourly threshold times about 24 times 3 (a day at a third of the
      watch's line), and send them to hey@flagon.io.
- [ ] **Budget alerts** (Manage Account → Billing → Budget alerts, where the
      account has them): one for the whole account's monthly usage, at the
      month's expected bill and at twice it.
- [ ] **Notifications → Destinations**: add hey@flagon.io (and a webhook,
      if one is set up for paging) so the alerts above reach someone.
- [ ] **Account API token for billing**: check `CLOUDFLARE_BILLING_TOKEN`
      (or `CLOUDFLARE_USAGE_TOKEN`) has Account Analytics Read. sudo's
      Platform pause says when the watch cannot read.
- [ ] Where to see them: Notifications → History for what fired; Billing →
      Billable Usage for the month so far by product.

## Deploy order for these changes

1. Billing (migration 0050 runs first, then the Worker): the pause, the
   watch, `platform_pause`, `admin_platform_guard`, `admin_set_pause`.
2. Search and og, with their new `BILLING` binding; actions, context and
   runner. Before billing has `platform_pause`, they read nothing paused.
3. Sudo.
4. For the run cap: integrations (migration 0006), then models (its
   `RunSpend` Durable Object migration), then runner. Any order works; a
   session without a cap gets the $100 backstop.
