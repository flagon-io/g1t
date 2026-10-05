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

A plan turns on one paid feature for the whole workspace: a monthly price
that includes an allowance, with usage past it charged at cost plus 20%.

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

Every workspace has two limits. One protects you from a surprise bill;
the other protects g1t from usage that is never paid for. Both are on
**Settings → Billing → Limits**.

### Your monthly spend limit

What the workspace may spend in a month (UTC). At it, work stops until the
month turns or an owner raises it. Owners choose one of:

- **Automatic** (the default): $200, or twice last month's spend,
  whichever is more. It keeps up as you grow: a workspace that spent $900
  last month can spend $1,800 this month without anyone changing a thing.
- **Fixed**: an amount you set.
- **None**: work never stops for spend.

You are emailed at 50%, 80% and 100% of it.

### What g1t lets go unpaid

Usage is charged after it runs, so at any moment some of it is not yet
paid for. g1t lets that reach a ceiling that grows with your history:

| | Ceiling on what is unpaid |
| --- | --- |
| **New**: has not paid g1t yet | $3: the free allowances and a little more |
| **Paid** | twice what you have paid, from $25 up to $1,000 |
| **Established**: three steady months | three times your monthly spend, up to $10,000, by itself |
| **Reviewed** | what g1t set with you; contact us |

With a card on file, **g1t charges it as you near the ceiling** (80%):
an invoice for what you owe, paid at once, after which the ceiling is
yours again. So a workspace that pays keeps going, however much it uses;
the ceiling only stops one that does not.

How the ceiling grows:

- A payment counts once it has **cleared for 7 days**, the time in which
  most bad cards are caught. Payments with prepaid cards pay, but do not
  raise the ceiling, nor do credits g1t gives or payments in test mode.
- **Established** comes by itself after three months in a row of real spend
  ($20 or more each), every monthly invoice paid, nothing declined in 90
  days and nothing ever disputed. From then the ceiling follows your
  spend.
- Past $10,000, or for terms of your own, **contact us**: we set it with
  you, often with an enterprise account and invoices.

What counts as unpaid is each item at what it cost g1t or what it is
charged, whichever is more, less what was paid this month, plus anything
left unpaid from earlier months: a new month is not a fresh allowance.

A **declined card** stops work until it is paid, as does a payment
disputed with the card's bank. Paying under Billing with another card
clears it at once.

## Invoices

Every charge is a real invoice from g1t, kept on Stripe's billing page
with its PDF and emailed as a receipt:

- **When each month closes**, an invoice for what the workspace owes,
  itemised: agents on g1t's models, runs on your own model provider,
  sandbox time, and deployments past the plan. Credit you paid in advance
  is taken off as *Paid in advance*; anything left unpaid from before is
  added.
- **When the workspace nears its ceiling** mid-month, the same, sooner.

Each is charged to the card on file. The Billing page lists them, with
links to view each on Stripe and download its PDF.

## Enterprises and custom terms

Some accounts are billed differently, set up by g1t with you:

- **Enterprise**: one billing account paying for several workspaces.
  Their usage and payments count together, against
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

- **Near the ceiling** on what is unpaid (80%), g1t sends an
  [invoice](#invoices) for what the workspace owes and charges it, so work
  does not stop.
- **When each month closes**, the month's [invoice](#invoices) is charged
  to it.
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
