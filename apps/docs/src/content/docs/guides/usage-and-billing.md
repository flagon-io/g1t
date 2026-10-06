---
title: Usage and billing
description: What is free on g1t, what the g1t plan costs and includes, how compute is paid for, the limits that keep spend in check, and enterprise billing.
---

The forge is free: repositories, git, issues, pull requests and review cost
nothing, for public and private work. What costs money is compute, the
things g1t runs for you: agents, the sandboxes they and your checks run in,
deployed apps, and, on the plan, storage and git traffic past what is
included. Each is
charged at what it costs g1t plus 20%, to the workspace that owns the
repository. There is no seat price.

## What is free

Every workspace, with or without the plan, has the whole forge:

- Public and private repositories, git, issues, pull requests and reviews.
- Protected branches, code owners and secret push protection.
- Search and Explore.
- The [audit log](/guides/audit-log/), kept 90 days, with export.
- Your own agent through [MCP](/reference/mcp/).
- 1 GB of private repository storage, and 10,000
  [git operations](#git-operations) a month.

None of this is charged. A free workspace is never charged for storage:
once its private repositories hold 1 GB, pushes to them are refused at the
start of the push, with what to do: make the repository public, delete what
you do not need, or start the plan for 10 GB. Public repositories are never
charged for storage.

Compute is not free. Agents, checks, workflows, the merge queue,
deployments and semantic search need [the g1t plan](#the-g1t-plan), or a
[card check](#no-card-no-compute) for the trial and the open-source pool.

## The g1t plan

One plan, **$20 a month per workspace**, however many people and agents
are in it. It is never priced per person.

| Each month (UTC) | |
| --- | --- |
| Included usage | $10, at cost plus 20% |
| Members | Unlimited |
| Private repository storage | 10 GB |
| Git operations | 10,000 |
| [Deployments](/guides/deployments/) | 10 apps, 1 million requests, 3 million CPU milliseconds, 3 custom domains and 200 build minutes |

**Included usage** pays for the month's usage first, at the same prices as
everything else: agents, sandbox time, builds, storage, git operations,
search embeddings and security scans. Past it, usage is charged at cost
plus 20%. It starts again on the 1st of each month (UTC). **Unused
included usage does not roll over.** Billing shows how much of it this
month's usage has drawn.

**The other $10** pays for running g1t, the free forge everyone uses, and
the people building it.

Deployments are part of the plan. There is no separate Deployments
purchase.

### Start or end the plan

Only an owner can start or end the plan.

1. Open **Settings → Billing and plans**, `g1t.sh/<workspace>/-/billing`.
2. On the **g1t** card, choose **Start the g1t plan**.
3. If the workspace already has a checked card, the plan starts on it at
   once. Otherwise, pay on the card page you are sent to.

Back on Billing, the card says **On the g1t plan** (**first month** in
the first billing cycle), with a meter for the month's included usage and
one for deployments. **Manage on Stripe** opens the card, invoices and
billing details. **End at the end of the period** ends the plan then, with
nothing more charged after; **Keep the plan** takes that back until then.
If a renewal payment fails, the card says **Payment failed**, with
**Update payment on Stripe**, and the plan's features stop until it is
paid.

A card that says **Comped by g1t** or **Included by g1t** is on under terms
g1t set with the workspace, such as
[comped](#enterprises-and-custom-terms) terms, with nothing to pay or end.

## No card, no compute

Compute costs g1t real money from the first second, and free compute
attracts people who use it to mine cryptocurrency. A card check is the
smallest gate that stops that: it puts a real card behind each workspace,
and each card gets one trial.

A free workspace needs a card check before its trial or g1t's open-source
pool pays for anything. Only an owner can do it.

1. Open **Settings → Billing and plans**.
2. Under **Try it with $5 of usage**, choose **Check a card**. You are sent
   to Stripe's card page.
3. Enter the card. If your bank asks for 3-D Secure, confirm it there.

The card check is **never charged**: Stripe saves and verifies the card,
and nothing is taken. Back on Billing, a line says whether the trial
started. The card is saved as the workspace's card, so starting the plan
later needs no second card page.

The trial needs a credit or debit card; prepaid cards can still pay for the
plan. A prepaid card passes the check, and unlocks the open-source pool,
but starts no trial.

The card check unlocks:

- [The trial](#the-trial): $5 of usage, once.
- [The open-source pool](#the-open-source-pool): checks, workflows and
  the merge queue on public repositories.

## The trial

Once its card is checked, a workspace gets **$5 of trial credit**, once. It
pays for usage at cost plus 20%: agents, sandbox time, checks, workflows,
the merge queue and semantic search. It never pays for deployments.

- Each card gets one trial, whichever workspace it is checked in. Prepaid
  cards start none.
- Trials come from a pool of **$100 a month** for everyone together. It
  renews on the 1st of each month (UTC). When a month's pool is given out,
  new trials wait until the 1st, and **Settings → Billing** says so.
- Billing and mission control show what is left.
- While on the trial, a workspace runs at most 2 agents at once, and each
  run for at most 60 minutes. See [caps](#caps).

The trial does not turn into a charge. Nothing is charged until an owner
starts the plan. If a free workspace's last trial run goes past what was
left, g1t covers the difference, and the statement shows it as **Covered
by g1t**. When the trial is used up, new compute waits for the plan.

## The open-source pool

g1t sets aside **$25 a month** for public repositories, at most **$2 a
month** for any one repository. It pays for **checks, workflows and the
merge queue on public repositories**, after a card check. It does not pay
for agents, deployments, storage or embeddings.

When the pool or the repository's share is spent, those runs wait for the
next month, or for the plan. Each statement line the pool paid says so,
and the month's statement totals it under **Paid by g1t's open-source
pool**.

## What is charged

| | Charged |
| --- | --- |
| Making a change for an issue | Yes |
| Revising a change after checks, a review or a person | Yes |
| A review by a g1t agent | Yes |
| Catching up with `main` | Yes, when it needed an agent |
| Planning an [outcome](/guides/outcomes/) | Yes |
| Acceptance checks | [Sandbox time](#sandbox-time) |
| The [merge queue](/guides/merge-queue/) | [Sandbox time](#sandbox-time) |
| [Workflow](/guides/actions/) jobs | [Sandbox time](#sandbox-time) |
| [Deployments](/guides/deployments/) | Past what the plan includes |
| [Private repository storage](#storage-search-embeddings-and-scans) | Past 10 GB, on the plan only |
| [Git operations](#git-operations) | Past 10,000 a month, on the plan only |
| [Search embeddings](#storage-search-embeddings-and-scans) | For private text |
| [Security scans](#storage-search-embeddings-and-scans) | Yes |
| Repositories, issues, pull requests, review, search, the API and MCP | No |

Each run is charged when it finishes: what the model provider charged for
it, plus 20%, and its sandbox time. A small change costs a few cents.

Work a workspace routes to [its own model providers](/guides/models/) is
paid for at those providers instead. Such a run is charged here only for
its [sandbox time](#sandbox-time), like any other sandbox.

The charge goes to the workspace that owns the repository, whoever
assigned the issue. That is why putting g1t agents to work on a
repository needs the Write [role](/guides/access-and-roles/) or higher on it.

## How prices are set

Every price is what g1t pays for the thing, at Cloudflare or a model
provider, plus 20%. The live prices are on
[g1t.sh/pricing](https://g1t.sh/pricing), straight from the price book
billing charges from.

| Meter | Unit |
| --- | --- |
| Models | What the provider charged for the run |
| Sandbox time | Per second: memory, disk and the Durable Object behind each container, plus CPU |
| Deploy builds | Per second |
| App requests, CPU and apps | Per million requests, per million CPU milliseconds, per app-month |
| Custom domains past the plan | Per domain-month |
| Private storage | Per GB-month |
| Git operations | Per 1,000 |
| Search embeddings | Per million tokens |
| Security scans | Per million CPU milliseconds and per million rows written |

Prices keep themselves current as those costs move:

- **Models.** Each of g1t's hosted runs goes through its Cloudflare AI
  Gateway, which prices every request at the provider's current rates. A
  run is charged when it finishes at what the sandbox reported; within
  about 15 minutes it is **settled** to the gateway's figure, and any
  difference appears on the statement as a correction, such as
  *Correction to "Work on acme/api#12": AI Gateway priced its 41 model
  requests at $0.0312, not $0.0298*. A run whose sandbox stopped without
  reporting is charged from the gateway's logs instead of not at all.
- **Cloudflare.** Every day, g1t checks what Cloudflare billed its account
  against what was used: Containers and the Durable Objects behind them
  against the seconds containers ran, Workers for Platforms per request
  and per CPU millisecond. When a cost moves, the price book moves with
  it, and the change is listed on the pricing page with the reason. A
  measurement far from the current cost is not adopted, only logged, so
  one odd day cannot reprice anything.

### Sandbox time

Every sandbox g1t starts runs on Cloudflare Containers, and Cloudflare
charges g1t for every second of it. So each one is metered by the second,
from start to stop, whatever it was for: agents, reviews, revisions,
catch-ups, planning, acceptance checks, the merge queue and workflow jobs.
There are no free minutes.

A sandbox second is priced in two parts: memory, disk and the Durable
Object behind the container, for every second; and CPU, for the vCPU it
used. A run whose sandbox reports its own CPU use is priced on it. One
that does not is priced at the average CPU sandboxes use.

Each sandbox is one line on the [statement](#the-statement), such as
*Checks on acme/api#12: 3m 12s of sandbox time*. Deploy builds are not
counted here: [Deployments](/guides/deployments/) charges them by the
second, after the plan's 200 build minutes.

## Git operations

Cloudflare charges g1t **$0.15 per 1,000 git operations** from 2026-10-14.
An operation is one clone, fetch or push through g1t's git endpoints.
Pushes from agents' sandboxes go to the store directly and are not counted.

| | Each month (UTC) |
| --- | --- |
| Included, on every workspace | 10,000 |
| On the plan, past 10,000 | $0.18 per 1,000 (cost plus 20%) |
| Free workspace, past 50,000 | Not charged. Slowed to 60 an hour until the month turns. |

10,000 is about twenty times what an active workspace uses; an agent run
takes two to four. A free workspace is never charged for git operations.
Past 50,000 in a month, its git requests past 60 in an hour are answered
`429` with when to try again.

Counting starts on 2026-10-14. **Billing** shows this month's count
against what is included.

## Storage, search embeddings and scans

These are counted through the month and charged once it is over, as one
line dated the month's last day, so the limit counts them as they happen.
The plan's included usage and the trial pay for them first.

| | What it costs g1t | What is counted |
| --- | --- | --- |
| Private repository storage | $0.50 a GB-month (Cloudflare Artifacts) | On the plan, each day, what the workspace's private repositories hold past 10 GB. A month's GB-months are those days added up, divided by 30. |
| Search embeddings | $0.067 per million tokens (Workers AI) | The text of private repositories, issues and pull requests put in the search index. Public text and searches are not charged. |
| Security scans | $0.02 per million CPU milliseconds and $1.00 per million rows written (Workers and D1) | The CPU each history scan and dependency check takes and the rows it writes. |

Storage is charged at $0.60 a GB-month (cost plus 20%). It is measured from
the packs pushed through g1t's git endpoints to each repository and its
pull requests' working copies, so what is charged is never more than what
is stored. Public repositories are never charged, and neither is a free
workspace: its pushes to private repositories stop at 1 GB instead.

## Limits

Every workspace has two limits: **g1t's ceiling** on usage not yet paid
for, and **your spend limit** on what is charged in a month. Work stops at
whichever is lower. Both are in the **Spend limit** section of **Settings →
Billing and plans**, on the plan.

### The ceiling

Usage is charged after it runs, so at any moment some of it is not yet
paid. g1t lets that reach a ceiling that grows with your history:

| | Ceiling on what is unpaid |
| --- | --- |
| **Free** | None to reach: a free workspace is never charged. The trial and g1t's pools pay for its compute. |
| **First month on the plan** | $100 |
| **Paid** | Twice what you have paid, never below $100, up to $1,000 |
| **Established**: three steady months | Three times your monthly spend, up to $10,000 |
| **Reviewed** | What g1t set with you |

- A payment counts once it has **cleared for 7 days**, the time in which
  most bad cards are caught. Credits g1t gives and payments in test mode
  do not raise the ceiling.
- **Established** comes by itself after three months in a row of $20 or
  more, every invoice paid, nothing declined in 90 days and nothing ever
  disputed.
- **Prepaying** raises what can be used before work stops by the same
  amount, at once. See [prepay](#prepay).

With a card on file, **g1t charges it as you near the ceiling** (80%): an
invoice for what you owe, paid at once, after which the ceiling is yours
again. A workspace that pays keeps going; the ceiling stops one that does
not.

What counts as unpaid is each item at what it cost g1t or what it is
charged, whichever is more, less what was paid this month, plus anything
left unpaid from earlier months. What included usage, the trial or the
open-source pool paid for does not count.

### Your spend limit

What the workspace may be charged in a month (UTC). At it, new work stops
until the month turns or an owner raises it. Until owners set one, it is
**automatic**: $200, or twice last month's spend, whichever is more, up to
what is available.

Owners set it under **Your monthly spend limit**: **Automatic**, **Fixed
at** an amount, **Everything available**, or, once, **Use my one-time
raise**, then **Save limit**. The section says how far you can go yourself,
and whether the one-time raise is still yours:

| | Up to |
| --- | --- |
| Any amount | The highest ceiling the workspace has had, plus what is prepaid |
| **The one-time raise**, once per workspace | Twice the highest ceiling |
| Past that | **Raise my limit**: a request to g1t |

To ask for more, use the **Raise my limit** section: give the limit you
need, what you expect to spend a month, and what it is for, then **Send the
request**. A person at g1t answers **within one business day**, in the app
and by email, and the section shows the request and its answer. An approved amount becomes a
floor under your ceiling, and your spend limit can go up to it.

### Prepay

Paying in advance pays for usage as it happens, after the plan's included
usage, and raises what can be used before work stops by the same amount,
at once. It is never needed to start work. Only an owner can prepay.

1. Open **Settings → Billing and plans**, and find **Prepay**.
2. Choose **By card, with 3-D Secure** or **By bank transfer** (from
   $1,000).
3. Choose $100, $500 or $1,000, or type your own amount, from $25, and
   choose **Prepay**. By card, the most is $10,000.
4. Pay on the page you are sent to, confirming 3-D Secure if your bank
   asks. A bank transfer page gives the account details, and the amount
   counts when the money arrives.

**Prepaid balance** shows what is paid in advance and not used yet.

### Caps

The plan also caps what agents can do at once and spend:

| Cap | First month on the plan, or the trial | After | Who sets it |
| --- | --- | --- | --- |
| Agents at once | 2 | 10 | g1t |
| Time per run | 60 minutes | The [guardrails](/guides/guardrails/)' own caps | g1t |
| Spend per run | $2 | $2 | Owners, from $0.10 to $100 |
| Agents' spend per issue | $10 | $10 | Owners, from $1 to $1,000 |

Owners set the run and issue caps under **Caps on agents** on **Billing**,
then **Save caps**; a blank field goes back to the default. A cap g1t staff
set for the workspace wins over both. When an issue's agents reach its cap,
the message links straight to that section. See
[caps on a plan](/guides/g1t-agents/#caps-on-a-plan) for what happens at
each.

### Alerts

Owners are told at **50%, 75%, 90% and 100%** of each of:

- the plan's included usage,
- your spend limit,
- g1t's ceiling.

Each alert shows at the top of **Billing** and is emailed.

### Spikes

If the last hour's spend is more than **5 times the workspace's usual
hour** over the last week, and at least **$5**, new compute pauses until an
owner answers. Runs already under way finish. A banner across the top of
every page in the workspace says so, and **Billing** shows the spike with
two choices, for owners on both:

- **Keep going**: compute starts again, for 24 hours or until the hour's
  spend doubles again, whichever comes first.
- **Stop**: compute stays paused until an owner chooses **Keep going**.

g1t's own workspaces are never paused.

### Spent more than you meant to

If a month went past what you meant to spend, use **Spent more than you
meant to? Tell us.** on **Billing**: say what happened and choose **Tell
g1t**. Once in 12 months per workspace, g1t can credit the overage above
your usual month: always the 20% g1t added to it, and what it cost g1t up
to $50. Larger credits, or a second one within 12 months, are reviewed by a
person. The credit appears on the statement with the day it happened,
such as *Credit from g1t: accidental usage on 2026-11-12*.

## Invoices

Every charge is a real invoice from g1t, kept on Stripe's billing page
with its PDF and emailed as a receipt:

- **When each month closes**, an invoice for what the workspace owes,
  itemised: the plan, usage past what it includes, and anything left
  unpaid from before. Prepaid money is taken off as *Paid in advance*.
- **When the workspace nears its ceiling** mid-month, the same, sooner.
- **When the workspace is deleted**, a final invoice for what it owes,
  charged at once with no minimum. See
  [deleting a workspace](/guides/workspaces/#what-billing-needs).

Each is charged to the card on file. The Billing page lists them, with
links to view each on Stripe and download its PDF.

### The minimum charge

Only the month's close has a minimum: a card is not charged less than
**$5** then, so a payment's fee is never most of what is paid. When a month
closes owing less, the amount carries over to the next invoice that reaches
$5, as *Unpaid from earlier*. A charge made because a workspace is at or
near a limit always goes through, whatever the amount, so work can carry
on.

## Moving a repository between workspaces

When a repository is [transferred](/guides/transferring-repositories/#billing),
usage from that moment is charged to the workspace it moved to: agent runs,
builds, app traffic, git operations and storage. What it used before stays
on the old workspace's bill, and runs already under way finish on the bill
they started on.

## Your card and billing details

These live on **Stripe's billing page**, not on g1t: g1t never sees or
stores card numbers. An owner opens it with **Open Stripe billing** under
**Card and invoices** on **Settings → Billing and plans**, and there adds or replaces the card, downloads invoices and
receipts, and sets the billing email, address and tax ID. g1t support
never takes card details by phone or email.

If a card is declined, work stops until the workspace pays, and the
Billing page and the API say why. Replace the card or prepay to clear it.
A payment disputed with the card's bank stops work the same way.

While payments on g1t are in test mode, no real card is charged. Use the
test card `4242 4242 4242 4242` with any future date and any code. The
Billing page says when payments are in test mode.

## When work is stopped

A workspace that cannot start compute starts nothing new. Assigning an
issue, planning, or asking for a review is refused with `402` and a
message saying why and what to do, with the page to do it on: start the
plan, check a card, raise the spend limit, answer a spike, or wait for the
next month's pool.

A step g1t would take by itself, such as a revision or a review, stops
instead, and the pull request says **Needs you** with the reason. A
workflow job is recorded as failed with "Not started:" and the reason.
Runs already under way finish, so usage can go slightly past a limit.

## Security on every plan

Security is never a paid extra. Every workspace, free or on the plan, has
the same [audit log](/guides/audit-log/), kept 90 days, and the same CSV
and JSON export. Single sign-on through your identity provider is not
built yet; when it is, it will be on every plan.

## Enterprises and custom terms

Some accounts are billed differently, set up by g1t with you. Every price
is public; custom terms change how you pay, not what things cost.

- **Enterprise**: one billing account paying for several workspaces.
  Their usage and payments count together, against one limit, and each
  workspace's Billing page says which enterprise pays for it. An
  enterprise is **invoiced**: when each month closes, one invoice goes to
  the enterprise's billing address, with a line for each workspace, due in
  30 days and paid by card or bank transfer. If it goes overdue, the
  workspaces' work stops until it is paid.
- **Comped**: g1t covers the account's usage. The plan is on without being
  charged, and usage is still recorded at what it cost, so the Usage page
  stays accurate.
- **Custom**: a discount on usage, a limit of its own, or a larger share
  of the pools, sometimes until a date.

g1t's own workspaces and those of Flagon, Inc., the company that makes g1t,
run comped. Their usage is recorded at cost, apart from what customers
pay.

Each change is made by g1t staff and recorded with who made it and why. To
ask for one, write to [hey@flagon.io](mailto:hey@flagon.io).

## Earlier plans

Deployments used to be a $5 plan of its own. It is part of the g1t plan
now. A Deployments subscription bought before keeps working until its
current period ends, and is not renewed.

## The Usage page

A workspace's **Usage** page, `g1t.sh/<workspace>/-/usage`, shows what its
agents have cost. Every member can see it, from **Usage** in the
workspace's sidebar. The workspace's overview, `g1t.sh/<workspace>`, has a
**Usage** card with this month's spend: the plan's included usage or the
trial credit used so far, on-demand charges past what is included, what it
went on, and a way to **Billing**.

These figures are what the agent harness reports for each run. Your model
provider's own figures can differ by a few percent, because each prices
the same tokens itself; the provider's invoice is what counts.

Pick a period: **This month**, **Last 7 days**, **Last 30 days** or **Last
90 days**. The page then shows:

| | |
| --- | --- |
| Spent | What the period cost, and how much of it was the model provider's. |
| Agent runs | How many runs there were. |
| Average run | What a run cost on average. |
| Credit left | What is prepaid and not used yet, and about how many days it lasts at the period's rate. |
| Spend per day | A chart of each day, split by kind of work. |
| By kind of work | Making changes, reviews, catching up and planning. A revision counts as making a change. |
| By repository | Each repository's share. |
| Pull requests that cost most | The ten that cost most, each linked. Planning appears as the repository, linked to its plans. |
| By model | Each model's share. |

## The statement

The **Billing** page ends with the workspace's statement, a month at a
time. Every member can see it.

- **Totals.** What the month charged, what was paid and credited, and how
  many entries make it up.
- **Grouped by day or by project.** Each day (or project) has one line
  per kind of charge, with how many entries it holds and what they come
  to:

  | Line | What it holds |
  | --- | --- |
  | Agent runs | Runs on g1t's models: the model's cost plus the margin. |
  | Runs on your own model provider | Older months only: the flat fee runs on your own provider used to carry. |
  | Sandbox time | Each sandbox's time. |
  | Deployments | Builds and apps past what the plan includes. |
  | Private storage | Storage past what is included, once a month. |
  | Git operations | Operations past what is included, once a month. |
  | Search embeddings | Private text put in the search index, once a month. |
  | Security scans | History scans and dependency checks, once a month. |
  | Payments | Card payments and invoices paid. |
  | Credits from g1t | Credit g1t added, such as a goodwill credit. |
  | Refunds | Money given back to your card. |

- **Covered.** Below the totals, what paid for usage before it was
  charged, each with its amount:

  | Line | What paid |
  | --- | --- |
  | Paid by your plan's included usage | The plan's $10 a month. |
  | Paid by your trial credit | The one-time trial. |
  | Paid by g1t's open-source pool | The pool, for public repositories. |
  | Covered by g1t | A free workspace's last trial run past its trial. |

  Each entry says in its description how much of it was paid this way. A
  month that closed under the [minimum charge](#the-minimum-charge) says
  what carried over.
- **Open a line** to see its entries, 50 at a time, newest first. Each
  run links to the pull request it was for.
- **Pick a month** to see an earlier one.
- **CSV** downloads every entry of the month, with the line it falls under
  and what covered it, for your own books. Invoices from Stripe remain the
  record for what was charged to your card.

## The preview

While payments on g1t are in test mode, g1t's hosted models are open only
to the workspaces g1t runs itself. Every other workspace's agents, checks
and merge queue work with [its own model provider](/guides/models/), and
the sandbox time is paid as above. When payments go live, every workspace
can use g1t's hosted models.

## For services: entitlements, reserve, settle

Every g1t service that starts something that costs money asks billing
first. These RPCs are internal; they are documented so the behavior above
can be traced.

| RPC | Takes | Returns |
| --- | --- | --- |
| `entitlements` | `workspace` | What the workspace may do now (below). |
| `reserve` | `workspace`, `repo`, `public`, `kind`, `estimateMicros` | A reservation, or a refusal. |
| `settle` | `reservationId`, `actualMicros` | `true`, or `false` if it was settled or had lapsed before. Safe to repeat. |

**`entitlements`** returns, among others: `plan` (`free`, `paid`,
`internal` or `enterprise`), `compute` (may start compute at all),
`trialMicrosLeft`, `trialVerified` (a card check is done), `firstMonth`,
`maxConcurrentAgents`, `maxRunMinutes`, `runCapMicros`, `issueCapMicros`,
`ceilingMicros`, `exposureMicros`, `heldMicros`, `prepaidMicros`,
`includedMicros`, `includedUsedMicros`, `paused` (why compute is paused,
or none), `spike`, `alerts`, `gitOperations` and `gitOperationsIncluded`.

**`reserve`** holds the work's estimated cost before it starts, so starts
at the same moment cannot overshoot together. `kind` is `agent`, `check`,
`workflow`, `queue`, `deploy` or `embedding`. `estimateMicros` is the most
the work is expected to cost g1t **in millionths of a dollar, before the
margin**; billing adds the margin. For an agent, that is its model's
average plus its sandbox for its whole time cap.

A reservation has an `id`, `paidBy` (`credit` for included usage, `trial`,
`oss` or `on_demand`), `heldMicros` and `expiresAt`. A hold never settled
**lapses after 3 hours**. A refusal has one of these codes and a message
for the owner with the page to fix it on:

| Code | Why |
| --- | --- |
| `not_paid` | No plan, and nothing else pays for this kind of work, or no card check yet. |
| `trial_used` | The one-time trial is spent. |
| `limit` | The spend limit or g1t's ceiling would be passed. |
| `paused` | A spend spike is waiting for an owner, or g1t staff put a hold on compute. |
| `oss_pool_empty` | The open-source pool, or the repository's share of it, is spent this month. |

**`settle`** releases the hold with what the work cost, at cost before the
margin. It never charges: the charge goes on the ledger the usual way when
the work reports its usage.
