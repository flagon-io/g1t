---
title: Usage and billing
description: What g1t costs, how a workspace pays, the limits that keep unpaid usage in check, and enterprise billing.
---

Hosting repositories, issues, pull requests, review and your own agent cost
nothing on g1t. What costs money is what g1t runs for you: its agents'
models, the sandboxes they and your checks run in, and deployed apps. Each
is charged at what it costs g1t plus a set markup, after it is used, to the
workspace that owns the repository. There is no seat price.

Some features are paid for with a monthly plan the workspace turns on, and
are never free, including while the rest of g1t is. See
[Plans](#plans).

## Plans

A plan turns on one paid feature for the whole workspace, the way
Cloudflare's or Vercel's paid plans do: a monthly price that includes an
allowance, and usage past it charged from credit at cost plus 20%.

| Plan | Price | Includes each month |
| --- | --- | --- |
| [Deployments](/guides/deployments/) | $5 a month | 10 apps up at once, 1 million requests, 3 million CPU milliseconds. Builds are charged by the second. |

Only an owner can turn a plan on or off.

1. Open **Settings → Billing**, `g1t.sh/<workspace>/-/billing`.
2. Under **Plans**, choose **Turn on Deployments**, and pay on the card
   page you are sent to.

Back on Billing, the plan says **On** and when it renews; the card is kept
and charged each month. **Turn off at the end of the period** ends the plan
on its renewal date, with nothing more charged after; **Keep Deployments**
takes that back. If a renewal payment fails, the plan says **Payment
failed** and the feature stops until it is paid.

Plan usage past the allowance and builds are drawn from the workspace's
credit, so a workspace with a plan can add credit while agents are free.

## The free allowance

So anyone can try g1t's agents without a key of their own, every workspace
gets **$1 of model cost on g1t's own models**, free, until **October 22,
2026** (11:59 PM Pacific). That is roughly 10 to 25 agent runs: changes,
reviews and revisions. The allowance covers the GitHub Actions runners
too, while it lasts.

- Mission control and **Settings → Integrations** show what is left.
- When it is used up, agents and workflow runs stop starting, and the
  pages that start them say so and link to Integrations. Connect your own
  model provider there and everything carries on at once.
- The allowance draws on one shared pool. If the pool runs out before
  October 22, the allowance ends for everyone early.
- Workspaces on their own provider never use it.

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
| [Deployments](/guides/deployments/) | The plan, and builds and usage past it. Never free. |
| Repositories, git, issues, pull requests, the API and MCP | No |

Each run is charged when it finishes: what the model provider charged for
it, plus 20%. A small change costs a few cents.

Work a workspace routes to [its own model providers](/guides/models/) is
paid for at those providers instead. Each such run here is a flat $0.10
for g1t's orchestration, plus its [sandbox time](#sandbox-time).

The charge goes to the workspace that owns the repository, whoever
assigned the issue. That is why only members of a workspace can put g1t
agents to work on its repositories.

## How prices are set

g1t passes its own costs through. Everything a workspace uses costs g1t
money first, at Cloudflare or a model provider, and is charged at that
cost plus a set markup. There is no seat price, and nothing is bundled to
hide what it costs. The live prices are on
[g1t.sh/pricing](https://g1t.sh/pricing), straight from the price book
billing charges from.

Prices keep themselves current as those costs move:

- **Models.** Each of g1t's hosted runs goes through its Cloudflare AI
  Gateway, which prices every request at the provider's current rates. A
  run is charged when it finishes at what the sandbox reported; within
  about 15 minutes it is **settled** to the gateway's figure, and any
  difference appears on the statement as a correction, such as
  *Correction to "Work on acme/api#12": AI Gateway priced its 41 model
  requests at $0.0312, not $0.0298*. When a provider changes its prices,
  runs are charged the new ones from that day. A run whose sandbox stopped
  without reporting is charged from the gateway's logs instead of not at
  all.
- **Cloudflare.** Every day, g1t checks what Cloudflare billed its account
  against what was used: Containers against the seconds containers ran,
  Workers for Platforms per request and per CPU millisecond. When a cost
  moves by 2% or more, the price book moves with it, since each price is
  its cost times its markup, and the change is listed on the pricing page
  with the reason. A measurement far from the current cost (more than 4×
  either way) is not adopted, only logged, so one odd day cannot reprice
  anything.

| | Markup |
| --- | --- |
| Models | 20% |
| Deploy builds, app requests, CPU and apps | 20% |
| Sandbox time | 138%, which also pays for the orchestration around each sandbox and everyone's free minutes |

## Sandbox time

Every sandbox g1t starts for a workspace runs on Cloudflare Containers, and
Cloudflare charges g1t for every second of it. So each one is metered by
the second, from start to stop, whatever it was for: agents, reviews,
revisions, catch-ups, planning, acceptance checks, the merge queue and
workflow jobs. It is charged to the workspace that owns the repository.

| | |
| --- | --- |
| Free each month | 500 minutes (calendar month, UTC) |
| Past that | about $0.002 a minute, by the second |
| What it costs g1t | about $0.0009 a minute (Containers, standard-1, at the CPU sandboxes really use) |

Both follow what Cloudflare bills, so they move; today's exact figures are
on [g1t.sh/pricing](https://g1t.sh/pricing). See
[How prices are set](#how-prices-are-set).

Deploy builds are not counted here: [Deployments](/guides/deployments/)
charges them by the second on its own plan.

Each sandbox is one line on the [statement](#the-statement), such as
*Checks on acme/api#12: 3m 12s of sandbox time*, with whether it fell
within the free minutes.

## Usage limits

Everything a workspace uses costs g1t money at Cloudflare or a model
provider before the workspace pays for it. So, as Fly and Cloudflare do
with new accounts, every workspace has a limit on usage not yet paid for.
When it is reached, the workspace's work stops until it pays, or the
month turns:

- **No new sandboxes.** Assigning an agent, planning, asking for a
  review and workflow jobs are refused with `402 payment_required` and the
  reason; acceptance checks and the merge queue wait. Runs already under
  way finish.
- **No new builds**, and **deployed apps pause**: they answer with a page
  saying so (`402`) and run nothing. Once the workspace is under its limit
  again, g1t rebuilds each one from the commit it was serving, by itself.

What counts is this month's usage (UTC), each item at what it cost g1t or
what it is charged, whichever is more, less what was paid this month, plus
any charges left unpaid from earlier months: a new month is not a fresh
allowance. Even
usage that is free to you, such as the free minutes, counts at its cost:
the limit is about what g1t has spent on a workspace's behalf.

| Workspace | Limit |
| --- | --- |
| **New**: has not paid g1t yet | $3: the free allowances and a little more |
| **Paid**: has paid g1t | twice what it has paid, from $25 up to $1,000 |
| **Reviewed** | what g1t set for it, after talking with you |
| **Comped** | none: g1t covers it |

The limit is there to stop accounts that will never pay, not to slow down
ones that do. So:

- **With a card on file, work does not stop.** As a workspace nears its
  limit (80%), g1t charges its card for what it owes. That payment lowers
  what is owed and raises the limit, since the limit grows with what a
  workspace has paid. A workspace that pays as it goes keeps going.
- **A declined card stops work** until it is paid, with a message saying
  so, and the pull requests that were waiting say **Needs you**. Paying
  under Billing with another card clears it at once.
- **Your own spend limit means stop.** An owner can set a lower monthly
  limit under **Settings → Billing → Usage limit**. At that one, g1t stops
  work and does not charge the card past it.

Payments in test mode are not money: they neither lower what is owed nor
raise the limit, and automatic charges only happen with live payments.
Credits g1t gives, such as refunds, lower what is owed but do not raise
the limit. To go past $1,000, write to support.

## Enterprises and custom terms

Some accounts are billed differently, set up by g1t with you:

- **Enterprise**: one billing account paying for several workspaces, as
  GitHub Enterprise does. Their usage and payments count together, against
  one limit, on one set of terms, and each workspace's Billing page says
  which enterprise pays for it. An enterprise is invoiced: when each month
  closes, Stripe emails one invoice to the enterprise's billing address,
  with a line for each workspace, due in 30 days and paid on Stripe's
  invoice page by card or bank transfer. Paying it clears every workspace
  on it; if it goes overdue, their work stops until it is paid.
- **Comped**: g1t covers the account's usage. Usage is still recorded with
  what it cost, so the Usage page stays accurate, and paid features are on
  without a plan.
- **Custom**: a discount on every usage charge, a limit of its own, or
  both, sometimes until a date, after which standard terms apply.

Each change is made by g1t staff in g1t's billing console and recorded with
who made it and why. To ask for one, write to support.

## Your card, invoices and billing details

These live on **Stripe's billing page**, not on g1t: g1t never sees or
stores card numbers. An owner opens it from **Settings → Billing → Card
and invoices → Manage billing on Stripe** (or **Add a card on Stripe**),
and there adds or replaces the card, downloads invoices and receipts, and
sets the billing email, address and tax ID. Saving a card charges
nothing. g1t support never takes card details by phone or email; if you
need help, we send you a link to that same Stripe page.

With a card on file:

- **Near the usage limit** (80%), g1t charges it for what the workspace
  owes, at least $5, so work does not stop.
- **When each month closes**, g1t charges it for what the workspace owed
  at the end of the month, and the statement shows the payment as *Usage
  for 2026-10, charged to the card on file when the month closed*.
- **If it is declined**, work stops until the workspace pays, and the
  Billing page and the API say why. Replace the card or add credit to pay.

Comped workspaces are never charged, and an enterprise's workspaces are
billed through the enterprise. Test-mode cards are never charged
automatically.

## Add credit

Credit is a payment in advance: it pays for usage as it happens, and lowers
what the workspace owes against its limit. It is never needed to start
work. Only an owner of the workspace can add credit.

1. Open the workspace's **Settings → Billing**, `g1t.sh/<workspace>/-/billing`.
2. Under **Add credit by card**, choose an amount: $10, $25, $50 or $100.
3. Pay on the card page you are sent to.

You come back to the Billing page, and the credit is there once the payment
has gone through. The amount credited is what the card processor says was
paid.

While payments on g1t are in test mode, no real card is charged. Use the
test card `4242 4242 4242 4242` with any future date and any code. The
Billing page says when payments are in test mode.

## When work is stopped

A workspace at its limit, or with a declined card, starts nothing new.
Assigning an issue, planning, or asking for a review is refused with `402`
and the reason:

```json
{
  "error": {
    "code": "payment_required",
    "message": "The acme workspace reached its $3.00 limit for usage not yet paid for, so its sandboxes, builds and apps are stopped. The limit grows as a workspace pays g1t; an owner can pay under Billing, or write to support to have it raised."
  }
}
```

A step g1t would take by itself, such as a revision or a review, stops
instead, and the pull request says **Needs you** with the reason. Runs
already under way finish, so usage can go slightly past the limit.

## The Usage page

A workspace's **Usage** page, `g1t.sh/<workspace>/-/usage`, shows what its
agents have cost. Every member can see it. The sidebar shows this month's
spend.

While g1t is free, nothing is charged, so the page and the sidebar show
what runs **used**, at what they cost: g1t's models and your own provider's
together. Credit is not drawn down.

These figures are what the agent harness reports for each run. Your model
provider's or gateway's own figures can differ by a few percent, because
each prices the same tokens itself; the provider's invoice is what counts.

Pick a period: **This month**, **Last 7 days**, **Last 30 days** or **Last
90 days**. The page then shows:

| | |
| --- | --- |
| Spent | What the period cost, and how much of it was the model provider's. **Used**, at cost, while g1t is free. |
| Agent runs | How many runs there were. |
| Average run | What a run cost on average. |
| Credit left | The balance, and about how many days it lasts at the period's rate. |
| Spend per day | A chart of each day, split by kind of work. |
| By kind of work | Making changes, reviews, catching up and planning. A revision counts as making a change. |
| By repository | Each repository's share. |
| Pull requests that cost most | The ten that cost most, each linked. Planning appears as the repository, linked to its plans. |
| By model | Each model's share. |

## The statement

The **Billing** page lists the workspace's balance and its statement:
every payment and every run, newest first, up to the latest 100. Each run names its kind of work
and links to the pull request it was for. Every member can see it.

Each pull request's session also ends with what its run cost before the
margin.

## The preview

g1t is in preview.

- **Open to everyone:** accounts, workspaces, repositories, git, issues,
  pull requests, review, the API, and your own agent through MCP.
- **g1t's agents, for any workspace with its own model provider:** connect
  an Anthropic key or endpoint under [Integrations](/guides/models/) and the
  workspace's agents, acceptance checks and merge queue work at once. Your
  provider bills you for the models; g1t charges nothing for now, and $0.10
  a run once pricing starts.
- **g1t's hosted models:** while payments are in test mode, every
  workspace can use g1t's own models on
  [the free allowance](#the-free-allowance) ($1 each, until October 22),
  and a few g1t has opened them to without limit. When payments go live,
  every workspace can use them, paid from its credit.

Each workspace decides where its model spend goes. A workspace that can use
neither sees a message saying so, with the way to connect its own provider.
