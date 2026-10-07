# Billing operations: costs, margin and prices

How g1t checks what it charges against what Cloudflare charges it, keeps
prices at cost plus 20%, and tells staff when the margin slips. Internal.
Code: `services/billing/src/costs.rs` (reading the bill), `margin.rs`
(reconciliation, drift, alerts), `pricing.rs` (versions, proposals,
notice), `keeper.rs` (sandbox and Workers for Platforms measurements),
`budget.rs` (what g1t pays for itself, and its caps; see
[Spend caps](#spend-caps)).
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
5. In sudo, Costs & margin → **Run the analysis now**.

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
   4. Reconcile the last 31 days (further back after a gap) into
      `margin_days` and `workspace_costs`
      (replaced per day).
   5. Drift over the last 7 days into `cost_drift`.
   6. Unit costs over the last 30 days, proposed to the price book.
   7. Apply price versions whose date has come.
   8. Open, update and close margin alerts; email new ones.
   9. Email owners on the plan about rises to come.

**Run the analysis now** at the top of sudo's Costs & margin page
(`admin_run_costs`) runs all of step 2 at once, alerts included, with no
need to wait for 04:17 UTC. Running it twice is safe: every step replaces
what it wrote.

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

- **Cloudflare cost** = Σ the bucket's lines' cost, as billed: after the
  included allowances, so a month inside them costs $0 here as on
  Cloudflare's Billable usage page. `models` uses the ledger's cost of the
  tokens instead; that is paid to the model providers and is not on
  Cloudflare's bill.
- **Own cost** = Σ the ledger's `cost_micros` for the bucket's keys (the
  price book's cost when charged), plus month-end deltas. A workspace's own
  model provider is no cost to g1t.
- **Value** = what customers were charged at price: `-amount_micros` plus
  what the plan's included usage, a trial, the open-source pool or g1t paid.
  g1t's own (comped) workspaces are valued at cost plus the margin.
- **Cash** = what workspaces paid: `-amount_micros`, and the plan's price.
- **Given away** = the part of the cost that went on usage g1t paid for
  itself on purpose, by why:
  - **comped**: all of a comped workspace's cost, every bucket;
  - **free use**: a free period's usage, the overruns g1t covered
    (`ledger.given_micros`), and all of a workspace's cost on a day it had
    nothing priced (free allowances);
  - **trial** and **open-source pool**: what `trial_micros` and
    `oss_micros` paid.

  Otherwise a workspace's day is split by those shares of its value at
  price, and the same shares of each of its buckets' cost are given, its
  part of running g1t included. The Team plan's included usage is sold:
  the plan's price paid for it. Stored on `margin_days` (`given_micros`
  and `given_<why>_micros`) and `workspace_costs` (`given_micros`).
- **Month-end meters**: a day's figure is that day's `pending_days`
  snapshot less the day before's, within a month. Their month-end ledger
  entries are left out, so nothing is counted twice.
- **Product margin** = (value − cost) / value.
- **Sudo's statement** keeps apart:
  - **Usage sold**: cash for usage against the cost of the usage buckets
    less what was given. Its margin is the headline; at cost plus 20% it
    sits near 16.7%.
  - **Running g1t**: the plan's price against `platform` less its given
    share.
  - **Cloudflare subscriptions**: `CLOUDFLARE_FIXED_MONTHLY_MICROS` over
    the range, an estimate, since they are not on the usage bill.
  - **Not mapped**: billed, charged for by nothing.
  - **Given away**: by why. A budget, watched under g1t's own spend, never
    shown as a loss.
  - **All in**: money in against all of it, with the figure without what
    was given beside it. **Who g1t paid** splits the cost into Cloudflare
    and the model providers.

  The overall alert is (Σ cash − (Σ cost − Σ given)) / Σ cash.
- **Quantities**: where a mapping names an `own_meter`, Cloudflare's
  billed quantity of those lines (or, without one, Artifacts' operation
  events) against g1t's own count.

**Shared costs to workspaces.** A bucket's cost is shared in proportion
to, first available: Cloudflare's own per-workspace count
(`cloudflare_<bucket>`, today the Artifacts events by repository), g1t's
own count, what its usage cost (so free use carries its own cost), what
each was charged for it. `platform`
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

It applies from the next run; **Run the analysis now** applies it at once.
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

**Charged at price** (a product's value) is what each day's usage was paid:
charged to a card or credit, or drawn from the plan's included usage, a
trial, a pool or a gift. Usage nothing paid for, as in a free period, is
valued at price (cost plus the margin), since it was given away at its price
rather than sold for nothing; so are g1t's own workspaces. Runs on a
workspace's own model provider have no cost to g1t. Every daily run
reconciles the whole 31-day window from what is already kept, so a change in
how a day is valued reaches every day sudo shows.

## Alerts runbook

| Alert | Raised when | First steps |
| --- | --- | --- |
| Margin under the floor | A product's value against cost under `margin_floor_percent` (10%) for `alert_days` (3) days running, each with at least `min_daily_cost` | Open the product on Costs & margin. Cost up? Check proposals (approve a rise; it waits out the notice). Value down? A mapping or `revenue_map` may have moved. |
| All of g1t under the floor | The same for money in against the cost of what was sold: every cost less what was given away (comped workspaces, free periods, the trial, the pools), which is a budget watched in budget.rs. While less than $1 a day comes in, it says the dollars, not a percentage | Look at which products moved; check `platform` (it has no revenue of its own and grows with traffic). Before launch, with little paid usage, expect it. |
| Leak | Drift of kind leak | Map the meter, or decide it is overhead. |
| Drift | Count drift | See Drift above. Cloudflare's definitions change in beta: ask them in writing ([ARTIFACTS.md](ARTIFACTS.md), §7). |
| Costs more than it pays | A workspace's shared cost over 30 days above what its usage was priced at (`value_micros`, whoever paid: card, trial, gift or included usage) × `anomaly_factor`, at least `anomaly_floor`; not comped workspaces | Shown on Reach out as "Costs more than it pays": its usage is priced below what it costs. Abuse (Abuse & fraud page) or a gap in pricing. Not emailed. A trial or gift paying for usage does not raise it. |

Alerts close on their own when the condition clears. Open ones are
emailed again weekly. The red bar on every sudo page shows margin,
overall and leak alerts.

## Token usage

The model proxy (`services/models`) reads Anthropic's `usage` from every
`/v1/messages` answer, streamed or whole, on g1t's models and on a
workspace's own provider alike (OpenAI-shaped providers are translated
first). Count-tokens requests are not answers and are skipped. After the
answer, it calls `record_tokens`, which adds input, output, cache reads and
cache writes to one row per day, workspace, person, session and model in
`token_usage` (migration `0030_token_usage.sql`). The person is who the run
was for, from the model session's `requested_by`; never g1t's agent. A
report that fails is dropped and never affects the answer.

`token_usage` reads a window (42 days by default, 366 at most) for the
workspace or one person: totals, every day's tokens and the active days,
with `costMicros` the window's run charges from the ledger, measured as
`usage` measures them. These counts are for views only: runs are still
priced from AI Gateway's logs, never from `token_usage`.

## Tables (migration `0022_costs_and_margin.sql`)

`cost_lines`, `cost_map`, `revenue_map`, `own_counts`,
`pending_days`, `margin_days`, `workspace_costs`, `cost_drift`,
`margin_alerts`, `price_versions` (seeded with every current price as
version 1), `price_proposals`, `price_notices`, `cost_settings` (the
guardrails, seeded), the `actions_cache` price, and `ledger.price_version`.
Every create is `IF NOT EXISTS` and every seed `INSERT OR IGNORE`; the one
`ALTER` is applied once by D1's migration tracking. Migration
`0023_one_operation_mapping.sql` drops `billable_units` (see above).

## Spend caps

Two caps keep what g1t pays for itself bounded while billing takes no
real money. Both are measured at **cost** (what Cloudflare and the model
providers charge g1t), never at price. Code: `services/billing/src/budget.rs`.
Page: sudo **Costs & margin** → **g1t's own spend** (`/costs#spend`).

### What counts as g1t's own spend

Every charge that settles (an agent run's model cost from `finish_run` or
AI Gateway's settlement, sandbox time from `record_sandbox`, a build from
`charge_feature`) is split by what paid for it and g1t's part is added to
`g1t_spend` (day, bucket, billing account):

| Bucket | What |
| --- | --- |
| `comped` | All of a comped account's work (flagon-io) |
| `trial` | The trial credit's share |
| `oss` | The open-source pool's share |
| `given` | A free workspace's overrun past its last bit of trial |
| `unpaid` | Charged, but with no real money behind it: Stripe's test key, or `FREE_WHILE_BUILDING` |

The plan's included usage and on-demand charges count as revenue only
with live payments; in test mode they are `unpaid`. A workspace's own
model provider costs g1t nothing and is not counted. Month-end meters
(git, storage, scans, embeddings, the cache) are not counted here; the
daily reconciliation covers them. Migration `0024_spend_caps.sql`
backfills the current month from the ledger.

### Caps

| Cap | Variable (g1t-billing) | Default | At the cap |
| --- | --- | --- | --- |
| A comped account's monthly budget | `COMPED_MONTHLY_CEILING_MICROS`, or the account's own **Limit** in its terms | $150 a month | New work on the account (agents, checks, workflows, builds) is refused with "<name>'s monthly budget for g1t's own agents is used up … Staff can raise it in sudo". Runs already going finish; the per-run cap still applies to them. It lifts when staff raise the budget or the month turns (UTC). |
| The daily breaker | `PLATFORM_DAILY_SPEND_CAP_MICROS` | $75 a day (UTC) | New agent runs on g1t's hosted models that g1t would pay for are refused until 00:00 UTC. Not paused: agents on the workspace's own model provider, checks and builds, and workspaces paying with live payments on the plan (not given by staff) or an enterprise contract. In test mode that exemption covers no one. |

`0` turns either off. `CLOUDFLARE_FIXED_MONTHLY_MICROS` ($30: Workers
Paid and Workers for Platforms) is shown on the page only.

The checks are cheap: `reserve` reads today's total (one indexed sum) and,
for a comped account, its month's comped rows. Refusals come back as
`paused`, which the compute gate honours for every plan, internal and
enterprise included (`packages/contracts/src/compute.ts`). The runner tells
billing whether an agent run is on hosted models (`hostedModel` on
`reserve`); a caller that does not say is treated as hosted.

### Alerts

All to `COSTS_ALERT_EMAIL` (`hey@flagon.io`), through the `EMAIL` binding:

- **Comped budget**: at 50, 75, 90 and 100%, once each per account and month
  (`budget_alerts`), checked every 15 minutes. A jump past several levels
  sends only the highest.
- **Breaker**: at once, from the charge that trips it; if that email fails,
  the 15-minute cron sends it (`spend_breaker.told_at`).

While the breaker is open or a comped budget is used up, every sudo page
shows a red **Spend cap** bar.

### Raising and lifting

- **Raise a comped budget**: sudo → the workspace → Billing → **Terms**, set
  **Limit $** to the new monthly budget (blank goes back to the default),
  with a note. It applies to the next start; nothing to deploy. The change
  is in the account's audit log.
- **Lift the breaker for today**: sudo → Costs & margin → **g1t's own
  spend** → **Lift for today**, with why (`admin_lift_breaker`; audit action
  `breaker_lifted`). It resets by itself at 00:00 UTC.
- **Change a default**: edit the variable in `services/billing/wrangler.jsonc`
  and deploy g1t-billing.

## Resetting a test workspace

sudo → the workspace → **Reset billing (testing)** (`admin_reset_billing`)
returns a workspace used for testing to how a new customer starts. It
deletes the workspace's rows from every billing table: ledger and balance,
plan and plan payments, limits and limit requests, trial grant, invoices,
holds, card checks, alerts sent, price notices, month-end snapshots and
closes, storage and sandbox meters, token usage, spikes, sales records and
notes, `workspace_costs`, its workspace margin alert and its own billing
account. It keeps `own_counts` (what Cloudflare's bill is compared with)
and the audit log, which records the reset with the note and the number of
rows. The workspace, its members and its repositories are identity's and
repos' and stay.

Billing refuses it while `STRIPE_SECRET_KEY` is a live key, for comped
workspaces, and for a workspace an enterprise pays for. Afterwards press
**Run the analysis now** on Costs & margin so the margin figures drop the
workspace's past usage.

## Stripe

Billing keeps what it needs from Stripe so reads never wait on it, and
hears of changes three ways (`webhooks.rs`, `stripe_sync.rs`).

**The webhook.** A destination made in Stripe's dashboard (Developers →
Webhooks → Add destination) with the endpoint URL
`https://api.g1t.sh/stripe/webhook`, in the mode of billing's key (at
launch, make one in live mode and put its secret). Its signing secret
(`whsec_…`: the destination, Signing secret, Reveal) is the billing
Worker's secret:

```sh
cd services/billing && npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Without it every event is refused with 400. After rolling the secret in
Stripe, put the new one; during the roll Stripe signs with both, so there
is no gap. The event list need not be exact: billing adds any event it
handles that the destination does not send (daily, or **Fix destination**
in sudo → Stripe), and enables it again if Stripe disabled it. It never
changes the secret. sudo → Stripe shows whether the secret is set, the
destination and its status, missing events, and the latest events.
Events are claimed once each in `stripe_events`; a handler that fails
forgets its claim, and Stripe retries.

**What is kept, and how it stays current**

| Kept | Where | Refreshed by |
| --- | --- | --- |
| Saved card (brand, last 4, expiry) | `accounts.card_*`, `card_synced_at` | `customer.updated`, `payment_method.*`, `setup_intent.succeeded`; forgotten when g1t sets a default card, so the next read asks once; the daily pass for cards older than 7 days |
| Plans | `subscriptions` | `customer.subscription.*`, `invoice.*`; a read asks Stripe at most hourly once a period is over; the daily pass for rows older than a day |
| Payments, refunds, disputes | ledger, `checkouts`, invoices | their events |

**Every cron run (every 15 minutes)** replays missed events: Stripe's event
list from an hour before `stripe_sync.through`, oldest first, through the
same once-only claim. `through` moves to 5 minutes before now when all were
handled, back to the first failure otherwise, and stays when more than
1,000 events were listed. Claims stuck at `handling` for 10 minutes are
dropped so the replay retries them. The first run reads 3 days back.

**Daily** (`keeper::DAILY`): the destination at billing's address is
enabled again if Stripe disabled it and given any missing event, audited as
`stripe`/`webhook`; then up to 25 stale cards and 25 stale plans are read
again.

**What still calls Stripe on a request**: starting a payment page, a plan
or a card check; opening the billing portal; settling a page the person
came back from; renaming a workspace (the customer's name). Nothing a page
view reads.
