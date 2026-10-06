# Billing operations: costs, margin and prices

How g1t checks what it charges against what Cloudflare charges it, keeps
prices at cost plus 20%, and tells staff when the margin slips. Internal.
Code: `services/billing/src/costs.rs` (reading the bill), `margin.rs`
(reconciliation, drift, alerts), `pricing.rs` (versions, proposals,
notice), `keeper.rs` (sandbox and Workers for Platforms measurements).
Page: sudo **Costs & margin** (`/costs`).

Several Cloudflare products g1t runs on are new. Artifacts bills
"operations" from 2026-10-14 without defining them (see
[ARTIFACTS.md](ARTIFACTS.md), M1). So nothing here hard-codes a product
list or a unit: every line Cloudflare bills is kept, and how a line maps
to what g1t sells is data you change from sudo, without a deploy.

## Data sources

| Source | What | Where it lands |
| --- | --- | --- |
| Billable usage, `GET /accounts/{account}/billable-usage?from=&to=` | One row per service per day in FOCUS columns: `ServiceFamilyName`, `ServiceName`, `ChargePeriodStart`, `PricingQuantity`, `ContractedCost` / `BilledCost` / `ListCost`. Every product g1t uses appears once it is used: Workers, Workers for Platforms, D1, KV, R2, Queues, Containers, Durable Objects, Artifacts, Browser Rendering, Workers AI, Vectorize, Cloudflare for SaaS, Email. Inside an included amount the cost is 0. | `cost_lines`, source `billable_usage` |
| GraphQL `artifactsEventsAdaptiveGroups` | Artifacts' own count by `date`, `eventType` and `repositoryName`. Operations are `create`, `fork`, `push`, `pull`, `delete`; errors (`rateLimited`, `serverError`, …) are kept but not counted. | `cost_lines`, source `artifacts_events`; per workspace (from the store key `<workspace>--<repo>`) in `own_counts` as `cloudflare_git` |
| The ledger | Every charge: its cost at the price book's cost, what it was charged at price, what paid for it. | read, never written |
| `pending_usage` | Month-end meters (git, storage, scans, embeddings, the cache) as they stand. | snapshotted daily into `pending_days` |
| `plan_payments` | The plan's $20. | read |
| repos `git_operations` | Operations customers are charged for, per workspace, counted by repos through its `operation_mapping`. | `own_counts` meter `git_operations` |
| repos `artifacts_usage` | Every raw meter of the git store (`git.fetch`, `git.receive_pack`, `binding.*`, …) per day and workspace, with repos' `operation_mapping`. | `own_counts` meters `artifacts_<raw meter>`, and `cost_operations` (raw counts × the mapping's `cost_operations`: what g1t expects Cloudflare to bill) |

A meter's slug is Cloudflare's name lower-cased with words joined by `_`
and the "(First … included)" note dropped: `Workers for Platforms CPU ms
(First 60M ms are included)` under `Workers` is product `workers`, meter
`workers_for_platforms_cpu_ms`. Several rows of the same day and meter
(regions, tiers) are added together before they are stored.

## Credentials

| Secret on g1t-billing | Permissions | Used for |
| --- | --- | --- |
| `CLOUDFLARE_BILLING_TOKEN` (optional) | Account: **Billing Read**, Account: **Account Analytics Read**, for the g1t account only | Reading the bill and the Artifacts events |
| `CLOUDFLARE_USAGE_TOKEN` (exists) | Billing Read, Account Analytics Read, AI Gateway Read | The keeper; also the bill when `CLOUDFLARE_BILLING_TOKEN` is not set |

With neither, the daily run reconciles only what g1t counted itself, and
the page says the bill cannot be read. Nothing fails. To set the scoped one:

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token.
2. Permissions: Account · Billing · Read; Account · Account Analytics · Read.
3. Account resources: Include · the g1t account. No zone permissions.
4. `cd services/billing && npx wrangler secret put CLOUDFLARE_BILLING_TOKEN`.
5. In sudo, Costs & margin → **Read the bill now**.

Alerts are emailed through the `EMAIL` binding (Cloudflare Email Sending)
to `COSTS_ALERT_EMAIL` (`hey@flagon.io`). An empty value sends none.

## Schedule

The daily cron (`17 4 * * *`, `keeper::DAILY`) runs, in order:

1. The keeper's measurements (sandbox seconds, app requests and CPU), each
   a proposal now, not a direct change.
2. `costs_daily`:
   1. Read the bill and the Artifacts events. The first run reads the last
      31 days (GraphQL keeps 31); later runs the last 4, since Cloudflare
      restates recent days, or back to the last day read after a gap.
      Lines are upserted on `(day, source, product, meter)`, so a re-read
      replaces, never adds.
   2. g1t's own counts for the same days (replaced per day).
   3. Snapshot `pending_usage` into `pending_days`.
   4. Reconcile those days into `margin_days` and `workspace_costs`
      (replaced per day).
   5. Drift over the last 7 days into `cost_drift`.
   6. Unit costs over the last 30 days, proposed to the price book.
   7. Apply price versions whose date has come.
   8. Open, update and close margin alerts; email new ones.
   9. Email owners on the plan about rises to come.

**Read the bill now** in sudo (`admin_run_costs`) runs step 2 at once.

## Reconciliation math

Every Cloudflare line goes to one of g1t's products ("buckets") by
`cost_map`: the row for its product with the longest matching meter
prefix, `*` last. A line no row claims goes to `unmapped`.

| Bucket | Cloudflare | Paid for by (`revenue_map`) |
| --- | --- | --- |
| `sandboxes` | Containers, Durable Objects compute duration | `sandbox`, `self_hosted`, `builds` |
| `deployments` | Workers for Platforms | `deployments` |
| `git` | Artifacts operations (and its events, as counts) | `git` |
| `repo_storage` | Artifacts storage | `storage` |
| `actions_cache` | R2 | `cache` |
| `embeddings` | Workers AI, Vectorize | `context` |
| `security` | (Workers CPU, under `platform`) | `security` |
| `domains` | Cloudflare for SaaS | `domains` |
| `models` | not Cloudflare: AI Gateway's settled cost on the ledger | every other task (agent runs) |
| `platform` | Workers, D1, KV, Queues, Email, Browser Rendering, other Durable Objects | the plan's price |

For each day and bucket:

- **Cloudflare cost** = Σ the bucket's lines' cost. `models` uses the
  ledger's cost instead.
- **Own cost** = Σ the ledger's `cost_micros` for the bucket's keys (the
  price book's cost when charged), plus month-end deltas. A workspace's own
  model provider is no cost to g1t.
- **Value** = what customers were charged at price: `-amount_micros` plus
  what the plan's included usage, a trial, the open-source pool or g1t paid.
  g1t's own (comped) workspaces are valued at cost plus the margin.
- **Cash** = what workspaces paid: `-amount_micros`, and the plan's price.
- **Month-end meters**: a day's figure is that day's `pending_days`
  snapshot less the day before's, within a month. Their month-end ledger
  entries are left out, so nothing is counted twice.
- **Product margin** = (value − cost) / value. **Overall margin** =
  (Σ cash − Σ cost) / Σ cash.
- **Quantities**: where a mapping names an `own_meter`, Cloudflare's
  billed quantity of those lines (or, without one, Artifacts' operation
  events) against g1t's own count.

**Shared costs to workspaces.** A bucket's cost is shared in proportion
to, first available: Cloudflare's own per-workspace count
(`cloudflare_<bucket>`, today the Artifacts events by repository), g1t's
own count, what each was charged for it, what its usage cost. `platform`
and `unmapped` are shared by each workspace's share of all usage that
day. Shares are whole micros that add up to the bill exactly (largest
remainder).

## Drift (last 7 days)

| Kind | When | What to do |
| --- | --- | --- |
| Count | g1t's count and Cloudflare's differ by more than the mapping's `drift_percent` (10%) | Find out what Cloudflare counts: compare its events with `own_counts` `artifacts_*` and `cost_operations`. If it counts more (binding reads, `ls-refs`), either change repos' `operation_mapping` so customers are charged for what Cloudflare counts, or leave it and let the per-unit cost rise (below). |
| Cost | Cloudflare charged more than `drift_percent` away from the price book's cost of the same usage, with at least `min_daily_cost` | A price is stale: check the proposals. |
| Leak | Cost of at least `min_daily_cost` and nothing charged for it (never for `platform`), or a meter in `unmapped` | Map the meter (below), or decide it is overhead (`platform`). |

## Prices: versions, proposals, notice

- `price_versions` holds every price ever, never edited. `prices` is the
  version in force. The daily run applies a version once its
  `effective_at` has come, and adds the public `price_changes` record.
  Ledger entries made from the price book carry `price_version` (the
  version ids, comma-separated), so a past statement is always explained
  by the prices of its day.
- Proposals come from the keeper (sandbox seconds, app requests and CPU)
  and the reconciler (mappings with `scale_to_own`: today git operations).
  For git operations: Cloudflare's rate per its own operation (the median
  over charged days of cost ÷ quantity) × (Cloudflare's operations ÷ g1t's)
  × 1,000. If Cloudflare counts three for each one g1t counts, the per-1,000
  price triples. At least 1,000 of g1t's operations are needed.
- Decision (`pricing::decide`): under 2% is noise; more than 4× either way
  is suspect and waits for staff; within `auto_apply_percent` (25%) it is
  applied on its own when `auto_apply` is on; anything else waits.
- Notice: a fall applies at once. A rise applies `notice_days` (14) after
  the decision, and for a monthly meter (git, storage, cache, domains,
  embeddings, scans) at the start of the month after that, so no month
  is charged at two prices. Owners of workspaces on the plan are emailed
  once per rise (`price_notices`), and the pricing page lists it with
  "takes effect". Rises are never retroactive; margin protection is for
  new usage once notice has run.
- Staff approve or reject in sudo. A rejection needs a note.

## Changing a mapping

In sudo, Costs & margin → **Mappings**: Cloudflare's product and meter
prefix (as **Cloudflare's lines** lists them; `*` for the rest of the
product), g1t's product, and optionally:

- **Price meter**: the price book meter the line measures.
- **Own meter**: g1t's count of the same units (`own_counts.meter`).
- **Scale to g1t's count**: price one of g1t's units at as many of
  Cloudflare's as it took (proposals as above).
- **Drift threshold**.

It applies from the next run; **Read the bill now** applies it at once.
Every change is in the audit log (`cost_mapping`).

## Which raw meters are operations

There is one mapping, and the repos service owns it: `operation_mapping`
in g1t-repos' database, one row per raw meter with `cost_operations` (how
many operations Cloudflare bills for it) and `billable_operations` (how
many the customer is charged for). Change it with repos'
`set_operation_mapping` RPC (services only), or
`npx wrangler d1 execute g1t-repos --remote` until sudo has a form. A
change applies to counts from then on, never to what was counted.
Billing keeps no mapping of its own: it reads repos' `git_operations`
(already mapped) for what customers are charged, and `artifacts_usage`
(raw counts with the mapping) for `cost_operations`. Migration 0023 drops
the `billable_units` table 0022 made for this, which was never written.

## Alerts runbook

| Alert | Raised when | First steps |
| --- | --- | --- |
| Margin under the floor | A product's value against cost under `margin_floor_percent` (10%) for `alert_days` (3) days running, each with at least `min_daily_cost` | Open the product on Costs & margin. Cost up? Check proposals (approve a rise; it waits out the notice). Value down? A mapping or `revenue_map` may have moved. |
| All of g1t under the floor | The same for money in against every cost | Look at which products moved; check `platform` (it has no revenue of its own and grows with traffic). |
| Leak | Drift of kind leak | Map the meter, or decide it is overhead. |
| Drift | Count drift | See Drift above. Cloudflare's definitions change in beta: ask them in writing ([ARTIFACTS.md](ARTIFACTS.md), §7). |
| Costs more than it pays | A workspace's shared cost over 30 days above its revenue × `anomaly_factor`, at least `anomaly_floor`; not g1t's own | Shown on Reach out as "Costs more than it pays". Abuse (Abuse & fraud page) or a gap in pricing. Not emailed. |

Alerts close on their own when the condition clears. Open ones are
emailed again weekly. The red bar on every sudo page shows margin,
overall and leak alerts.

## Tables (migration `0022_costs_and_margin.sql`)

`cost_lines`, `cost_map`, `revenue_map`, `own_counts`,
`pending_days`, `margin_days`, `workspace_costs`, `cost_drift`,
`margin_alerts`, `price_versions` (seeded with every current price as
version 1), `price_proposals`, `price_notices`, `cost_settings` (the
guardrails, seeded), the `actions_cache` price, and `ledger.price_version`.
Every create is `IF NOT EXISTS` and every seed `INSERT OR IGNORE`; the one
`ALTER` is applied once by D1's migration tracking. Migration
`0023_one_operation_mapping.sql` drops `billable_units` (see above).
