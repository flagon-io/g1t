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
| GraphQL `artifactsEventsAdaptiveGroups` | Artifacts' own count by `date`, `eventType` and `repositoryName`. Operations are `create`, `fork`, `push`, `pull`, `delete`; errors (`rateLimited`, `serverError`, …) are kept but not counted. | `cost_lines`, source `artifacts_events`; per workspace (from the store key `<workspace>--<repo>`; a pull request's working copy, `pulls--<id>`, is its repository's workspace's, from repos' `pull_owners`) in `own_counts` as `cloudflare_git` |
| GraphQL `aiGatewayRequestsAdaptiveGroups`, filtered to `AI_GATEWAY_ID` | What AI Gateway priced g1t's own provider traffic at, by `date`, `provider`, `model` and `wholesale`: `count`, `sum.cost` (dollars), `sum.tokensIn`/`tokensOut`/`cacheReadTokens`/`cacheWriteTokens`. Field names checked against Cloudflare's schema (introspection of `AccountAiGatewayRequestsAdaptiveGroups{Sum,Dimensions,Filter_InputObject}`). An adaptive (sampled) dataset: an estimate, close at g1t's volumes. Only g1t's hosted models go through this gateway: a workspace's own provider is called at its own address, never here. | `cost_lines`, source `ai_gateway`, product `ai_gateway_requests`: per day and model a line `<provider>_<model>` (requests, at the gateway's cost), and at no cost `…__tokens`, `…__cache_read_tokens`, `…__cache_write_tokens`; Cloudflare-billed (unified billing) requests are prefixed `wholesale__`. Mapped to `models` (migration 0036). A re-read day replaces all its gateway lines. |
| The ledger | Every charge: its cost at the price book's cost, what it was charged at price, what paid for it. | read, never written |
| `pending_usage` | Month-end meters (git, storage, scans, embeddings, the cache) as they stand. | snapshotted daily into `pending_days` |
| `plan_payments` | The plan's $20. | read |
| repos `git_operations` | Operations customers are charged for, per workspace, counted by repos through its `operation_mapping`. | `own_counts` meter `git_operations` |
| Subscriptions, `GET /accounts/{account}/subscriptions` | What g1t pays each month whatever it uses (Workers Paid, add-ons): each subscription that is paid, trialing or awaiting payment, at its price over its frequency. Not on the billable-usage bill. Read in the daily run with the bill's token; a failure is logged and the last read stays. | `cf_subscriptions` (one row) |
| repos `artifacts_usage` | Every raw meter of the git store (`git.fetch`, `git.receive_pack`, `binding.*`, …) per day and workspace, with repos' `operation_mapping`. | `own_counts` meters `artifacts_<raw meter>`, and `cost_operations` (raw counts × the mapping's `cost_operations`: what g1t expects Cloudflare to bill) |

A meter's slug is Cloudflare's name lower-cased with words joined by `_`
and the "(First … included)" note dropped: `Workers for Platforms CPU ms
(First 60M ms are included)` under `Workers` is product `workers`, meter
`workers_for_platforms_cpu_ms`. Several rows of the same day and meter
(regions, tiers) are added together before they are stored.

## Credentials

| Secret on g1t-billing | Permissions | Used for |
| --- | --- | --- |
| `CLOUDFLARE_BILLING_TOKEN` (optional) | Account: **Billing Read**, Account: **Account Analytics Read**, for the g1t account only | Reading the bill, the Artifacts events and the subscriptions |
| `CLOUDFLARE_USAGE_TOKEN` (exists) | Billing Read, Account Analytics Read, AI Gateway Read | The keeper (settling runs from the gateway's logs); also the bill when `CLOUDFLARE_BILLING_TOKEN` is not set. AI Gateway's analytics are read with this token first and, if that is refused, with the bill's: Cloudflare answers a token without AI Gateway Read with no rows rather than an error, so the bill's token would read as a gateway that priced nothing |

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
   1. Read the bill, the Artifacts events and AI Gateway's analytics. The first run reads the last
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

**Run the analysis now** at the top of sudo's Costs & margin and Bill & pricing pages
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
| `models` | not Cloudflare: AI Gateway's settled cost on the ledger; AI Gateway's own daily total (`ai_gateway_requests`) beside it, to check it | every other task (agent runs) |
| `platform` | Workers, D1, KV, Queues, Email, Browser Rendering, other Durable Objects | the plan's price |

For each day and bucket:

- **Cloudflare cost** = Σ the bucket's lines' cost, as billed: after the
  included allowances, so a month inside them costs $0 here as on
  Cloudflare's Billable usage page. `models` uses the ledger's cost of the
  tokens instead; that is paid to the model providers and is not on
  Cloudflare's bill. Its "Cloudflare" column is what AI Gateway priced the
  same traffic at, which drift compares with the ledger (below); it is
  never added to the cost.
- **Own cost** = Σ the ledger's `cost_micros` for the bucket's keys (the
  price book's cost when charged), plus month-end deltas. A workspace's own
  model provider is no cost to g1t.
- **Value** = what customers were charged at price: `-amount_micros` plus
  what the plan's included usage, a trial, the open-source pool or g1t paid.
  g1t's own (comped) workspaces are valued at cost plus the margin.
- **Cash** = what workspaces paid: `-amount_micros`, and the plan's price.
  Never tax or card fees: a payment credits the balance, and
  `plan_payments`, without them (see [Tax and the card fee](#tax-and-the-card-fee)).
- **Given away** = the part of the cost that went on usage g1t paid for
  itself on purpose, by why:
  - **comped**: all of a comped workspace's cost, every bucket;
  - **free use**: a free period's usage, the overruns g1t covered
    (`ledger.given_micros`), and all of a workspace's cost on a day it had
    nothing priced (free allowances);
  - **trial** and **open-source pool**: what `trial_micros` and
    `oss_micros` paid;
  - **discount**: what a discount on an account's custom terms took below
    cost plus the margin (`ledger.discount_micros`, see
    [Margin floor](#margin-floor)). The usage is valued at its price, so a
    discounted sale never reads as margin lost;
  - **promotional credit** and **goodwill credit**: what credit staff gave
    paid for, when it is spent (`given_credit_promotional_micros`,
    `given_credit_goodwill_micros`, migration 0038). That usage's charge is
    taken out of cash, so it is never money in. A refund is not here: see
    [Credits from g1t](#credits-from-g1t).

  Otherwise a workspace's day is split by those shares of its value at
  price, and the same shares of each of its buckets' cost are given, its
  part of running g1t included. The Team plan's included usage is sold:
  the plan's price paid for it. Stored on `margin_days` (`given_micros`
  and `given_<why>_micros`, `given_discount_micros` from migration 0036)
  and `workspace_costs` (`given_micros`). Sudo's Bill & pricing page lists
  comped, free use, trial and pool by name; the discount part is in the
  total until the page names it (`givenDiscountMicros`).
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
  - **Cloudflare subscriptions**: what Cloudflare lists, a month, over
    the range (`cf_subscriptions`); until a read has worked,
    `CLOUDFLARE_FIXED_MONTHLY_MICROS`, an estimate.
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
| Cost, on `models` | What AI Gateway priced g1t's own provider traffic at over the 7 days, against the ledger's model cost for the same days (billed to g1t: comped, free and trial use included, a workspace's own provider not), more than the `ai_gateway_requests` mapping's `drift_percent` (10%) apart, with at least `min_daily_cost`. A ledger with none of the gateway's cost is drift too, and so is a gateway that priced nothing against a ledger with at least `min_daily_cost` of model cost (no percentage): that is not agreement, it is a token that cannot see AI Gateway, or calls that went around it | The gateway higher: model calls g1t paid for and charged no one: runs not settled yet (they catch up within the hour), runs with no session, a run started without a billing ticket, or something else on g1t's gateway. The ledger higher: runs that reached a provider without the gateway. The detail adds why the gateway's own figure may be off: prompt-cache read and write tokens (the gateway prices them at its rates for cache tokens, which can lag the provider's; check against the provider's invoice), requests Cloudflare billed itself (unified billing: on Cloudflare's bill, not a provider's), and models with no price. Days are UTC by when a request ran (gateway) and when a charge was entered (ledger), so a run across midnight shifts a little between days; the 7-day sum absorbs it. |
| Unpriced | Over the 7 days, a model in AI Gateway's analytics with tokens and $0 cost, or runs settled with `runs.gateway_note` (the gateway could not price all of a run) | The gateway has no price for a model g1t runs: add it in the gateway (custom cost) or route away from it. Until then those runs are charged no less than the sandbox reported (Claude Code's own price table), never $0 silently. |
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

In sudo, Costs & margin → Bill & pricing → **Mappings**: Cloudflare's product and meter
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

## Model costs

Every model call g1t pays for is an agent run's (the `claude` CLI in the
sandbox, `crates/runner`); the only other model is Workers AI's embeddings,
which are on Cloudflare's bill (`embeddings`). How each reaches the ledger:

| Call | Who pays | Run and session | Ledger cost | Settled to the gateway |
| --- | --- | --- | --- | --- |
| Agent run through the model proxy (`services/models`) on g1t's hosted models | g1t | `runs` row; session `ms_…` in `cf-aig-metadata` | On finish, the sandbox's figure (Claude Code's `total_cost_usd`, at its own price table, cache tokens included) | Yes, every 15 minutes |
| Agent run straight to the gateway (no `MODELS_URL`) | g1t | `runs` row; session `rs_…` in `cf-aig-metadata` (`services/runner` `gatewaySession`) | As above | Yes |
| Agent run with no gateway (`AI_GATEWAY_ID` empty, self-hosting) | g1t's key | `runs` row, no session | The sandbox's figure | No: nothing to settle against |
| Agent run on a workspace's own provider | The workspace | `runs` row, `billed_to = 'workspace'`, no session | None (no cost to g1t) | No; never on g1t's gateway |
| A sandbox that died before reporting | g1t | as its route | Charged from the gateway when settled | Yes |
| Embeddings (indexing) | g1t | none (Workers AI) | Month-end `context` meter | No: Cloudflare's bill, `embeddings` bucket |
| Embeddings (queries, search and agent context) | g1t | none | None: not charged, by design | No: in Cloudflare's `embeddings` line, shared out |

**Settling.** A run's charge is corrected to what AI Gateway priced its
session's requests at (`settled_cost` in `keeper.rs`). The gateway's
figure is trusted in full: it is not held to the $100 cap on a sandbox's
own report. It is never taken below what the sandbox reported when it
cannot be the whole cost: a request with tokens and no cost (a model the
gateway has no price for) or more logs than are read (2,000). Such a run
keeps `runs.gateway_note`, its correction says why, and it raises the
**Unpriced** drift. g1t keeps no token rates of its own: the first figure
is Claude Code's, the final one the gateway's.

**The daily total.** AI Gateway's analytics for the day (above) against
the ledger's model cost is the check that nothing slips past: a model call
with no run, or a run never settled, shows as **Cost** drift on `models`.
The gateway's per-request `cost` is its estimate from its own price list:
it can be off for prompt-cache tokens, for requests Cloudflare bills
itself, and for models it has no price for. The drift's detail says when
any of those were in the window; the provider's invoice is the last word.

### Margin floor

A sold charge is cost × (1 + `MARGIN_PERCENT`), rounded up (`margin_on`;
`charge_micros` for a sandbox's own report). Terms change it only as
follows (`Terms::discounted`, `Billing::charged`):

- **Standard**: charged in full.
- **A 100% discount** (what was "comped"; see [Discounts](#discounts)),
  `FREE_WHILE_BUILDING`, the plan's included usage, the trial,
  the open-source pool, and overruns g1t covers: given, and counted by why
  (above).
- **Custom, with a discount**: the discount comes off, and what it took
  below cost plus the margin is written on the entry as
  `ledger.discount_micros` and counted as given (**discount**), so the sale
  is valued at its price and charged plus given is never under cost plus the
  margin. On a settlement correction it moves with the charge (less than
  nothing when the charge comes down).
- **Goodwill credits** (overages) are separate, given by staff on purpose:
  their margin part first, the cost only up to the cap, each audited.

Every usage path goes through this: `finish_run`, settling, sandbox time,
features and builds (`charge_feature`), and the month-end meters.

## Discounts

An account's terms are standard, or custom: a **discount** from 1 to 100%,
a limit of its own, or both, with a reason (the terms' note) and an
optional end date. What used to be "comped" is a **100% discount**
(`Terms::full_discount`; migration `0039_discounts_not_comped.sql` moved
every `comped` row to `custom` at 100%, and code reads a leftover `comped`
row as 100%). In SQL, `sales::FULL_DISCOUNT_SQL`.

- **Charging.** Every charge records what the discount took off it
  (`ledger.discount_micros`), 100% included: the entry is charged nothing
  and the discount is its whole price. Migration 0039 backfilled the
  discount on a 100%-discounted workspace's earlier entries that were
  charged nothing and paid by nothing, at cost plus 20%.
- **What a 100% discount still does as "comped" did.** The plan is on
  without its price (`PlanKind::Internal`), trust is `internal` (no limit
  on unpaid usage), nothing is invoiced or closed, and g1t's own spend on
  it is held to the monthly budget (the terms' limit, at cost; see
  [Spend caps](#spend-caps)).
- **The statement and Usage.** The customer sees every usage line at its
  price (`StatementLine.price_micros`: charged, plus what paid for it, plus
  the discount), the discount per day or project and in the totals
  (`StatementTotals.price_micros`, `discount_micros`, `discount_percent`),
  and the CSV has price and discount columns. The Usage page measures at
  price for a discounted account (`Usage.discount_micros`,
  `discount_percent`).
- **Margin.** A 100% discount's usage is given away as before, in the
  bucket still named `comped` (`given_comped_micros`); sudo calls it
  **100% discounts**. A partial discount's part below cost plus the margin
  is `given_discount_micros` (**partial discounts**). Both are kept apart
  from margin on what was sold.
- **sudo.** The workspace's **Terms** form takes a discount (None, 25%,
  50%, 100%, or Custom, a whole percent; the custom field shows by CSS
  alone), a limit, an end date and the reason. Badges and filters say
  *100% discount* or *N% off*. Each change is audited (`terms`), such as
  `standard → 100% discount, monthly budget $150.00: g1t's own`.

## Credits from g1t

Staff give a workspace credit from sudo; the code is
`services/billing/src/grants.rs`, the tables `credit_grants` and
`ledger.credit_kind` (migration `0038_staff_credits.sql`).

### Giving credit

sudo → the workspace (or an enterprise, choosing one of its workspaces) →
**Give credit**:

1. **Amount**: $10, $20, $25, $50, $100, or **Custom** (up to $10,000).
   Up to $100 it is one step; over $100, type the workspace's slug as well.
2. **Kind**: promotional (a welcome, a referral, an event), goodwill (an
   apology), or refund (money back for something that went wrong: say what
   it refunds and, optionally, the day).
3. **Expires**: never, 30, 90 or 365 days, or the end of a chosen day
   (UTC). A refund never expires.
4. **Note**: required. It is on the statement and in the owners' email.

The form needs no JavaScript: the fields for one choice (the custom amount,
a refund's details, the expiry date) show by CSS alone, and all show where
`:has()` is not supported. `admin_credit` checks everything again.

A grant is a `crd_…` ledger line (kind `top_up`, so never a payment) with
`credit_kind`, and a `credit_grants` row. The balance rises at once. The
owners are emailed through identity's `notify_owners` (the same path as
limit notices). It is audited as `credit`. The Overages queue's one-click
goodwill credit is a grant too, of kind goodwill.

The inbox is not told: its items are threads on a repository, built from
events, and a credit is a workspace's. That needs a workspace-level inbox
thread first.

### How it is spent

Credit is spent before anything prepaid, the soonest-expiring grant first
(never-expiring last, then the oldest). Given while the workspace owes, it
pays what is owed first, the most recent usage first. What each grant paid
for is never stored: `grants::replay` works it out from the ledger in order,
so the charge paths do not know about credit and the answer is always what
the ledger says. A charge that comes down (a settled run) gives back to
the grant that paid last, while it can still be spent.

### Expiry and revoking

- **Expiry.** The daily run (`expire_credits`, before the reconciliation)
  closes grants past `expires_at` and enters what was left as a negative
  `crd…_expired` line; audited as `credit_expired`. A grant past its expiry
  pays for nothing even before the run.
- **Revoke.** sudo → the workspace's **Credits** (or **Credits & refunds**)
  → **Revoke unused**, with why (`admin_revoke_credit`): what is left, as a
  `crd…_revoked` line, audited as `credit_revoked`. What was spent stays
  spent.

Neither takes the balance below zero: at most the balance, if a refunded
payment left less there than the credit.

### How margin treats them

| Kind | When spent | On the day it was given |
| --- | --- | --- |
| Promotional | The usage is valued at its price, its charge comes out of cash and is given (`given_credit_promotional_micros`) | Nothing |
| Goodwill | The same, as `given_credit_goodwill_micros` | Nothing |
| Refund | Paid for: cash, as any usage | Its amount (less what was revoked) comes off cash on the day it refunds, shared over that day's paid usage |

A refund gives back money already collected, so counting it as given would
make it look like a budget g1t chose to spend. Taking it off cash for the
day it refunds says that day's sale was worth less, and counting what it
later pays for as cash keeps money in equal to what was collected. The
refund's day is clamped to the last 30 days, the days the reconciliation
recomputes; an older one lands on the oldest. Refunds never expire, so
cash taken back is never stranded.

What credit paid of a month-end meter (storage, git, scans) is its own
row on the day it was charged, since those meters are reconciled from
snapshots. Sudo's Costs & margin lists promotional and goodwill credit
under **Given away**, and below the statement the range's credits given,
spent, and refunded. **Credits & refunds** (`/credits`, `admin_credits`)
lists every grant (by kind, month, staff and workspace) and the last 12
months by kind: given, spent, expired, revoked.

### Purchased and scoped credit (prepaid AI)

`credit_grants` also has `scope` (`all`, or `models`: model usage only,
`grants::is_model_usage`, which includes the agent rate) and `source`
(`staff`, `purchase`, `promo_code`, `upgrade`), and `CreditKind::Purchased`.
Spending takes credit scoped to models first, then the soonest-expiring. A
grant scoped to models given while the workspace owes pays only what models
owed, never other usage (`replay`). Purchased credit is money paid in: its
ledger line is a payment (Stripe's id, never `crd…`, `credit_kind`
`purchased`, statement kind *AI credit*), and the usage it pays for stays
money in, never given. Staff cannot give it (`admin_credit` refuses the
kind). Code: `services/billing/src/ai.rs`; migration `0040_ai_credit.sql`.

- **Buying.** `buy_ai_credit` opens Stripe Checkout (payment mode, $10 to
  $1,000, a second line *Card processing fee* when the `card_fee` cost
  setting is on, `setup_future_usage=off_session`), recorded in `checkouts`
  with `feature = 'ai_credit'`, `amount_cents` the credit and `fee_cents`
  the fee. The credit is entered by whichever comes first, the person coming
  back (`confirm_ai_credit`, `?ai_credit=cs_…`) or
  `checkout.session.completed`: both claim the row `open → paid`, the
  grant's id is the session's id (`INSERT OR IGNORE`) and the ledger's
  reference is unique, so a payment is credited exactly once. Expires 365
  days after purchase (the daily `expire_credits`).
- **Owed.** AI credit props up the balance but is money only for models, so
  what is owed is `max(0, AI credit left − balance)` (`owed_with`; at a
  month's close, `models_left_before` the month's start).
- **Auto-reload.** `ai_reload` (settings; off by default) and `ai_reloads`
  (one row per attempt). Each cron run (and a run that would be refused)
  calls `reload_now`: below the threshold, it charges the customer's default
  payment method off-session for the target less the balance (whole
  dollars, at least $10, within the month's maximum), with the idempotency
  key `reload/<workspace>/<YYYY-MM>/<n>` (a retry after a crash is the same
  PaymentIntent), and grants purchased credit with the PaymentIntent's id. A
  decline or a payment needing the person turns auto-reload off
  (`failed_at`, `error`), emails the owners and audits `ai_reload_failed`.
- **At $0.** `start_run` on g1t's models refuses with `payment_required`
  when the workspace is on the paid plan (not a 100% discount, not an
  enterprise), its included usage is used, and AI credit is $0 or less.
- **Upgrade credit.** The first time a plan subscription is recorded active
  (`features::record`), $5 of promotional credit scoped to models, id
  `crd_upgrade_<workspace>`, expiring in a year: given, never revenue. Never
  for a workspace with a 100% discount.

### The agent rate and models' markup

Price-book meters (migration 0040, each with versions and a public change):
`agent_models` (per provider dollar; markup 20% until 2026-10-08, then 0,
a fall applied at once), `agent_tokens` ($0 until 2026-10-22, then $0.25 a
million tokens: a rise, after the 14 days' notice, emailed to owners on the
plan by `tell_owners_of_rises`), `gateway_models` (markup 0 during beta),
`card_fee_percent` (29,000 micros per dollar) and `card_fee_fixed`
(300,000). Changing any is a price-book change, never a deploy. `finish_run`
and `settle` charge models at `agent_models`' markup; `charge_agent_rate`
charges the tokens `token_usage` counted for the run's session since it was
last charged (`runs.agent_tokens`, claimed with a compare-and-set), on a
line `<run>/agent` (later `<run>/agent/<tokens>`), with `quantity` the
tokens. Runs on a workspace's own provider have no session here and are not
charged the rate. **Card fee switch:** sudo → Costs → Guardrails → *Card fee
on card payments* (`cost_settings.card_fee`, `on`/`off`, on by default). It
covers every card payment now, not only AI credit: see
[Tax and the card fee](#tax-and-the-card-fee).

### Budgets

The owners' spend limit is the budget. `limits.alert_levels` (comma
separated, default every level), `limits.pause_at_limit` (default 1; off,
100% is a warning, never a stop; the trust ceiling still stops work) and
`limits.budget_webhook` (an https address, not g1t's; posted once per alert
level a month by `warn_limits`). `set_budget` sets them, with `keepLimit`
to leave the limit itself alone. A free workspace (trust `new`) has no
spend limit to set: `set_spend_limit` and `set_budget` say so.

### Earlier credits

Migration 0038 makes every earlier `Credit from g1t:` line a goodwill
grant with no expiry: the old form asked for "a refund or goodwill" with
no way to tell them apart, and goodwill never reads as money in.

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
Migration `0036_model_costs_in_full.sql` adds `ledger.discount_micros`,
`margin_days.given_discount_micros`, `runs.gateway_note` and the
`ai_gateway_requests` → `models` mapping. Migration
`0038_staff_credits.sql` adds `credit_grants`, `ledger.credit_kind` and
`margin_days.given_credit_{promotional,goodwill}_micros`, and backfills
earlier credits (see [Credits from g1t](#credits-from-g1t)).

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

`0` turns either off. Cloudflare's subscriptions are read from Cloudflare
each day (`cf_subscriptions`) and shown on the page only;
`CLOUDFLARE_FIXED_MONTHLY_MICROS` ($30) stands in until a read works.

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
closes, storage meters, token usage, spikes, sales records and
notes, `workspace_costs`, its workspace margin alert and its own billing
account. It keeps `own_counts` (what Cloudflare's bill is compared with)
and the audit log, which records the reset with the note and the number of
rows. The workspace, its members and its repositories are identity's and
repos' and stay.

Billing refuses it while `STRIPE_SECRET_KEY` is a live key, for comped
workspaces, and for a workspace an enterprise pays for. It then runs the
costs analysis again (as **Run the analysis now** does), so the margin
figures drop the workspace's past usage at once; if that run does not
finish, the page says so and the button does it.

## Stripe

Billing keeps what it needs from Stripe so reads never wait on it, and
hears of changes three ways (`webhooks.rs`, `stripe_sync.rs`).

**API version.** Every request sends `Stripe-Version: 2025-02-24.acacia`
(`stripe::STRIPE_VERSION`), the version billing's field reads are written
for; without it Stripe answers at the account's default. Webhook events
come at the destination's own version: billing reads an invoice's
subscription from `subscription` or `parent.subscription_details.subscription`.
Raising the version is a code change: read Stripe's upgrade notes for every
field billing reads.

**Failures.** No Stripe failure reaches a page as a 500: each payment page
(`page_opened`), the portal, confirmations and plan changes turn it into
`stripe::friendly` (Stripe's own message, never the request or a key), and
log the full error with the workspace. Every payment page is recorded
through one insert (`CHECKOUT_INSERT`), checked against the migrations by
`every_checkout_insert_fills_the_table`, and has an idempotency key
(`page/<purpose>/<workspace>/…/<10-minute bucket>`).

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

## Tax and the card fee

Owner decision 2026-10-08. Code: `services/billing/src/tax.rs` (what is
kept, the address hold), `stripe.rs` (every request's tax fields),
`invoices.rs`, `webhooks.rs`, `ai.rs`; migration
`0041_tax_and_card_fees.sql`.

### What Stripe is asked

Every price excludes tax (`tax_behavior=exclusive`) and carries tax code
`txcd_10103001` (software as a service, business use; the card fee too,
since a fee for paying for a sale follows the sale). Fields are valid for
`2025-02-24.acacia`.

| Request | Tax | Card fee |
| --- | --- | --- |
| Checkout, plan or Security (`subscription_fields`) | `automatic_tax[enabled]`, `billing_address_collection=required`, `tax_id_collection[enabled]`, with a customer `customer_update[address]=auto` and `[name]=auto`; the subscription keeps automatic tax for every renewal | A second recurring line, *Card processing fee* |
| Subscription on a saved card (`saved_subscription_fields`) | `automatic_tax[enabled]`; a customer Stripe Tax cannot place fails, and the person is sent to Checkout, which asks for the address | `items[1]`, the `card_fee` product |
| Checkout, prepay (`prepay_fields`) | As above | By card only; none by bank transfer |
| Checkout, AI credit (`credit_fields`) | As above | Its own line |
| Checkout, card check (`card_check_fields`) | Setup mode: nothing charged, nothing taxed. `billing_address_collection=required`, and the card's address is copied onto a customer with none (`fill_address`) | — |
| Auto-reload (`charge_saved`) | `POST /tax/calculations` first (credit and fee as lines), the PaymentIntent for the total, then `POST /tax/transactions/create_from_calculation` with the PaymentIntent as reference; a refund reverses its share (`create_reversal`, `mode=partial`) | In the calculation and the amount |
| Workspace invoice, month close and threshold (`invoice_workspace`) | `automatic_tax[enabled]` on the draft; each item `tax_behavior`, `tax_code` | An item *Card processing fee*, when the default payment method is a card |
| Enterprise invoice (`invoice_enterprise`) | The same | Never |
| Products (`Stripe::product`) | Made with `tax_code`; one found without it is given it | The `card_fee` product, `metadata[g1t]=card_fee` |

### What is kept

A payment credits the balance with what it paid for, never its tax or fee:
prepay credits the page's `amount_subtotal` less the fee line
(`credit_prepayment`), a workspace invoice `amount_paid − tax − fee`
(`credit_invoice`), AI credit its credit amount, and `plan_payments` the
plan's invoice less its tax and *Card processing fee* lines
(`stripe::invoice_split`). Each payment's tax and fee are rows in
`tax_and_fees` (`<reference>/tax`, `<reference>/card_fee`; the enterprise's
account id in `workspace` for its invoices), with the PaymentIntent, so a
refund (`charge.refunded`) gives back the balance, tax and fee in
proportion (`tax::refund_split`, negative rows under `refund/<charge>/…`).
`workspace_invoices.fee_micros` and `tax_micros` sit beside each usage
invoice.

- **Statement.** *Tax* and *Card processing fees* are their own lines per
  day (`StatementLine.passed_micros`), never in `charged_micros`; totals
  `tax_micros`, `card_fee_micros`. The CSV has a row a day for each.
- **Margin.** Cash never holds them, so margin is untouched. sudo → Costs
  shows **Tax collected** and **Card fees passed on** for the range
  (`OverallMargin.tax_collected_micros`, `card_fees_micros`). Tax is owed to
  the authorities: file it from Stripe Tax's reports, never from g1t's.

### No address

Stripe Tax needs a country (in the US a ZIP code, in Canada a postal code
or province: `stripe::address_places_customer`). Before a workspace
invoice is drafted, g1t checks the customer; without an address, or when
Stripe leaves the draft at `requires_location_inputs` or refuses with
`customer_tax_location_invalid`, nothing is charged:
`accounts.tax_address_needed_at` is set, the owners are emailed once
(`notify_owners`), and Billing shows **Add a billing address**. Saving
Invoice details with an address Stripe Tax can use clears it, as does a
charge that goes through. Work is not stopped for it; the limits still
apply. Auto-reload without an address fails like a declined card (turned
off, owners told). An enterprise's invoice is not sent without an address:
sudo → the enterprise → Invoices → **Billing address** (`admin_enterprise_address`,
with its tax ID; audited `billing_address`).

### The card fee

`card_fee_cents` grosses Stripe's fee up so the amount paid for is left
after it: `(amount + 30¢) / (1 − 2.9%)`, rounded up; $0.91 on $20, $1.06
on $25. It is worked out on the amount before tax, so Stripe's fee on the
tax itself (a few cents) is g1t's. It is shown before paying: the plan card
and pricing page (`Plan.card_fee_cents`), AI credit (*Card processing fee
$1.06, plus tax where it applies*), Prepay. Never on a bank transfer or an
enterprise's (`send_invoice`) invoice. Meters stay at cost + 20% and models
at the provider's price plus the agent rate (price versions in migration
0040); the fee is passed through, not margin.

### Tax-exempt customers and tax IDs

g1t never sets `tax_exempt`. For a customer who sends an exemption
certificate, set it in Stripe's dashboard (Customers → the customer → Tax
status: Exempt, or Reverse charge); Billing then says so. Tax IDs come
from Checkout (`tax_id_collection`) or Invoice details (`set_billing_details`,
validated against Stripe's types in `details::TAX_ID_TYPES`); Stripe checks
EU VAT numbers and Stripe Tax applies a reverse charge where it should.
Billing shows Stripe's `verification.status`.

### In Stripe's dashboard (not done by g1t)

1. **Settings → Tax → Get started**: turn on Stripe Tax in live and test
   mode.
2. **Origin address**: Flagon, Inc.'s head office address.
3. **Default tax code**: Software as a service, business use
   (`txcd_10103001`); **default tax behavior**: exclusive.
4. **Registrations**: add each jurisdiction where Flagon is registered to
   collect (its home state at least; then states as thresholds are
   crossed, which Stripe Tax's monitoring flags; the EU's OSS and the UK
   if selling there). Stripe collects only where a registration exists.
5. **Customer portal**: tax ID and address updates are already allowed
   (`portal_configuration`).
6. Refund an invoice through a **credit note**, so its tax is reversed in
   Stripe Tax.

## Free workspaces

Owner decision 2026-10-08: one free workspace per person, and a free
workspace adds no one. Billing answers one question, `free_workspaces`
(`credits.rs`): which of the given workspaces are on no paid plan
(`plan_kind_for` is `Free`). The plan, an enterprise's terms and a 100%
discount (flagon-io) count as paid; with payments off nothing is free.
Identity asks it (`services/identity/src/paid.rs`) and refuses with
`payment_required`:

| Where | Refused when |
| --- | --- |
| `create_workspace` | The person owns any free workspace. Several from before are kept (grandfathered); none can be added until each is paid for or deleted. |
| `add_member`, `invite_member` | The workspace is free. |
| `add_collaborator` | Someone outside a free workspace (a username who is not a member, or an address). Members' roles are fine. |
| `accept_invite`, `respond_repo_invitation` | The invite's workspace (or repository's) is free now: it waits. A sign-up with such an invite makes the account without joining. |

`@g1t` is never counted as someone added. If billing cannot be asked, the
change is refused for now ("try again"), never let through. The site says
so first (New workspace, People, a repository's Access, from the same RPC);
the API and MCP pass identity's refusal on as `402`.

## The Security and quality activation

A second monthly subscription a workspace can hold beside the plan
(`Feature::Security`, `feature = 'security'` in `subscriptions`). It turns
on the security suite's paid features for the workspace's private
repositories: custom secret patterns, validity checks, delegated bypass,
code scanning, dependency review and the security overview. Public
repositories have them free; secret scanning, push protection,
vulnerability alerts and security updates are free everywhere.

- **Price.** The price book's `security_activation` meter (unit
  `workspace-month`, `source` `list`, markup 0): 10,000,000 micros, $10,
  from migration `0037_security_activation.sql` with its first
  `price_versions` row and a public `price_changes` record. `plan()` and the
  `prices` RPC read it (`features::security_plan_at`); if the price book
  cannot be read, $10. Nothing in the web app hard-codes it. A change is a
  new price version, like any other: noticed on the pricing page and
  applied from its `effective_at` to new subscriptions. Subscriptions
  already running keep the amount Stripe has until they are changed in
  Stripe.
- **Stripe.** Its own subscription and its own product, tagged
  `metadata[g1t]=security` (the plan's is `plan`). Started from the Billing
  page with `subscribe` (`feature: security`) on the checked card, or
  through Checkout; ended with `cancel_subscription` (`feature: security`)
  at the period's end. Its invoices count in `plan_payments` like the
  plan's, as paid revenue.
- **Who has it.** `has_feature(workspace, security)`: on with an active
  subscription, with comped terms or as an enterprise's workspace, or when
  Stripe is not configured. The plan's allowance (`allowances.plan`) does
  not include it. Refusals are `PaymentRequired` with the price from the
  price book and the Billing page's address.
- **Where it is checked.** The security service, on each paid call for a
  private repository (`suite::entitled`) and before using custom patterns
  in a push (`patterns_for`). When billing cannot be reached it is taken
  as off: a paid feature waits rather than running unpaid.
- **Fixes.** "Fix with g1t" runs g1t's agent, charged as agent usage, never
  to the activation.
- **Sales figures.** MRR in sudo counts `feature = 'plan'` only; the
  activation's subscriptions are not in it yet.
