---
title: Usage and billing
description: What g1t costs, how a workspace pays, the limits that keep unpaid usage in check, and enterprise billing.
---

Hosting repositories, git, issues, pull requests, review, search and your
own agent cost nothing on g1t. Public repositories are free, and so is the
compute their agents use, up to a monthly budget g1t pays for. What costs
money is what g1t runs for you on private work: its agents' models, the
sandboxes they and your checks run in, deployed apps, and private storage
past the free amount. Each is charged at what it costs g1t plus 20%, after
it is used, to the workspace that owns the repository. There is no seat
price, ever.

Some features are paid for with a monthly plan the workspace turns on, and
are never free, including while the rest of g1t is. See
[Plans](#plans).

## Plans

A plan is one flat price a month for the whole workspace, however many
people and agents are in it: never per person.

| Plan | Price | Includes each month |
| --- | --- | --- |
| Team | $20 a month per workspace | $5 of usage credit, 50 GB of private storage, and a year of [audit log](/guides/audit-log/) |
| [Deployments](/guides/deployments/) | $5 a month | 10 apps up at once, 200 build minutes, 1 million requests, 3 million CPU milliseconds and 3 custom domains |

Usage past what a plan includes is charged at cost plus 20%, as it is
without the plan.

### Team

| | Without Team | With Team |
| --- | --- | --- |
| Usage credit | None | $5 a month |
| Private repository storage | 1 GB | 50 GB |
| Audit log | 30 days | 1 year |
| People | Everyone, no seat price | Everyone, no seat price |

The **usage credit** pays for the month's usage first, at cost plus 20%:
agents, sandbox time, builds, storage, search embeddings and security
scans. Past it, usage is charged as usual. It starts again on the 1st of
each month (UTC), and what is left unused does not carry over. Billing
shows how much of it this month's usage has drawn.

### Turning a plan on

Only an owner can turn a plan on or off.

1. Open **Settings → Billing**, `g1t.sh/<workspace>/-/billing`.
2. Under **Plans**, choose **Turn on Team** (or **Turn on Deployments**),
   and pay on the card page you are sent to.

Back on Billing, the plan says **On** and when it renews; the card is kept
and charged each month. **Turn off at the end of the period** ends the plan
on its renewal date, with nothing more charged after; **Keep Team** takes
that back. If a renewal payment fails, the plan says **Payment failed** and
the plan's features stop until it is paid.

A plan that says **Included, no charge** is on under terms g1t set with the
workspace, such as [comped](#enterprises-and-custom-terms) terms, with
nothing to pay or turn off.

## What is free, and what pays for it

Everything free on g1t is paid for by something: a plan, or a fixed
budget g1t sets aside each month. None of it is an open-ended allowance.

### Public repositories and open source

Hosting, git, issues, pull requests, review and search on a public
repository are never charged.

The compute its agents use, **sandbox time and model cost**, is paid by
**g1t's open-source pool** first:

| | Each month (UTC) |
| --- | --- |
| The pool, for every public repository together | $10 |
| One repository's share of it, at most | $1 |

When the pool or the repository's share is spent, that month's usage is
charged to the workspace as usual. Each statement line the pool paid says
so, as in *Work on acme/lib#12 ($0.04 paid by g1t's open-source pool)*,
and the month's statement totals it under **Paid by g1t's open-source
pool**. Builds, storage, embeddings and scans are not paid by the pool.

### Trials

So anyone can try g1t's agents without a key or a card, each new workspace
gets **$1 of trial credit**, once. It is given the first time the
workspace uses something, and pays for its usage at cost plus 20%, after
any Team credit: g1t's models, sandbox time, storage, embeddings and
scans, but never deployments. That is roughly 10 to 25 agent runs.

- Trials come from a budget of **$40 a month** for every new workspace
  together. It renews on the 1st of each month (UTC). When a month's
  budget is given out, new trials wait for the next month, and mission
  control and **Settings → Integrations** say when they start again.
- Mission control and **Settings → Integrations** show what is left.
- When it is used up, agents and workflow runs on g1t's models stop
  starting, and the pages that start them say so and link to
  Integrations. Connect your own model provider there and everything
  carries on at once.
- Workspaces that had the free allowance before trials renewed monthly keep
  what they had left of it.

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
| [Private repository storage](#storage-search-embeddings-and-scans) | Past 1 GB (50 GB on Team) |
| [Search embeddings](#storage-search-embeddings-and-scans) | For private text |
| [Security scans](#storage-search-embeddings-and-scans) | Yes |
| Repositories, git, issues, pull requests, search, the API and MCP | No |
| Agents and sandboxes on a public repository | From [the open-source pool](#public-repositories-and-open-source) first |

Each run is charged when it finishes: what the model provider charged for
it, plus 20%. A small change costs a few cents.

Work a workspace routes to [its own model providers](/guides/models/) is
paid for at those providers instead. Such a run is charged here only for
its [sandbox time](#sandbox-time), like any other sandbox.

The charge goes to the workspace that owns the repository, whoever
assigned the issue. That is why only members of a workspace can put g1t
agents to work on its repositories.

## How prices are set

g1t passes its own costs through. Everything a workspace uses costs g1t
money first, at Cloudflare or a model provider, and is charged at that
cost plus 20%. The 20% pays for running g1t and for building and keeping
up its features; g1t is not trying to make money on top of that. There is
no seat price, and nothing is bundled to hide what it costs. The live prices are on
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
  its cost plus its markup, and the change is listed on the pricing page
  with the reason. A measurement far from the current cost (more than 4×
  either way) is not adopted, only logged, so one odd day cannot reprice
  anything.

| | Markup |
| --- | --- |
| Models | 20% |
| Sandbox time | 20% |
| Deploy builds | 20% |
| App requests, CPU and apps | 20% |
| Custom domains past the plan | 20% |
| Private storage, search embeddings and security scans | 20% |

## Sandbox time

Every sandbox g1t starts for a workspace runs on Cloudflare Containers, and
Cloudflare charges g1t for every second of it. So each one is metered by
the second, from start to stop, whatever it was for: agents, reviews,
revisions, catch-ups, planning, acceptance checks, the merge queue and
workflow jobs. It is charged to the workspace that owns the repository.

| | |
| --- | --- |
| What it costs g1t | about $0.0009 a minute (Containers, standard-1, at the CPU sandboxes really use) |
| What you pay | that plus 20%, about $0.0011 a minute, by the second from the first |

Both follow what Cloudflare bills, so they move; today's exact figures are
on [g1t.sh/pricing](https://g1t.sh/pricing). See
[How prices are set](#how-prices-are-set).

Deploy builds are not counted here: [Deployments](/guides/deployments/)
charges them by the second on its own plan.

Each sandbox is one line on the [statement](#the-statement), such as
*Checks on acme/api#12: 3m 12s of sandbox time*.

## Storage, search embeddings and scans

Three things g1t used to absorb are metered at what they cost plus 20%,
like the rest. Each is counted through the month and charged once it is
over, as one line dated the month's last day, so the limit counts it as it
happens.

| | What it costs g1t | What is counted |
| --- | --- | --- |
| Private repository storage | $0.50 a GB-month (Cloudflare Artifacts) | Each day, what the workspace's private repositories hold past 1 GB (50 GB on Team). A month's GB-months are those days added up, divided by 30. |
| Search embeddings | $0.067 per million tokens (Workers AI) | The text of private repositories, issues and pull requests put in the search index. Public text and searches are not charged. |
| Security scans | $0.02 per million CPU milliseconds and $1.00 per million rows written (Workers and D1) | The CPU each history scan and dependency check takes and the rows it writes. Calls to OSV are free. |

Storage is measured from the packs pushed through g1t's git endpoints to
each repository and its pull requests' working copies. Pushes made by
g1t's own agents and imports are not counted yet, so what is charged is
never more than what is stored. Public repositories are never charged.

The live prices are on [g1t.sh/pricing](https://g1t.sh/pricing).

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
| **New**: has not paid g1t yet | $3 |
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
What a plan's credit, a trial or the open-source pool paid for does not
count: those are paid for already.

A **declined card** stops work until it is paid, as does a payment
disputed with the card's bank. Paying under Billing with another card
clears it at once.

## Invoices

Every charge is a real invoice from g1t, kept on Stripe's billing page
with its PDF and emailed as a receipt:

- **When each month closes**, an invoice for what the workspace owes,
  itemised: agents on g1t's models, sandbox time, and deployments past
  the plan. Credit you paid in advance
  is taken off as *Paid in advance*; anything left unpaid from before is
  added.
- **When the workspace nears its ceiling** mid-month, the same, sooner.

Each is charged to the card on file. The Billing page lists them, with
links to view each on Stripe and download its PDF.

### The minimum charge

No card is charged less than **$5**, so a payment's fee is never most of
what is paid. When a month closes owing less, nothing is charged: the
amount carries over and goes on the next invoice that reaches $5, as
*Unpaid from earlier*. That month's statement says what carried over. A
charge made because a workspace is near its limit goes through whatever
the amount, so work can carry on.

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
  what it cost, so the Usage page stays accurate, and paid features,
  Team among them, are on without a plan.
- **Plan and pools**: Team without charge, such as for a partner, or a
  larger share of the open-source pool or of trials.
- **Custom**: a discount on every usage charge, a limit of its own, or
  both, sometimes until a date, after which standard terms apply.

Each change is made by g1t staff in g1t's billing console and recorded with
who made it and why. To ask for one, write to
[billing@g1t.sh](mailto:billing@g1t.sh).

An enterprise account also has the [audit log](/guides/audit-log/) of each
of its workspaces, exported as CSV or JSON, and a year of it with Team.
Single sign-on through your identity provider is coming; it is not
available yet.

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

Beside the balance, the **Billing** page shows what the workspace has
spent this month and in total, and what it has paid and been credited in
total: every agent run, sandbox, build and app, at what was charged.

The **Billing** page ends with the workspace's statement, a month at a
time. Every member can see it.

- **Totals.** What the month charged, what was paid and credited, and how
  many entries make it up.
- **Grouped by day or by project.** Each day (or project) has one line
  per kind of charge, with how many entries it holds and what they come
  to, rather than a row for every run:

  | Line | What it holds |
  | --- | --- |
  | Agent runs | Runs on g1t's model provider: the model's cost plus the margin. |
  | Runs on your own model provider | Older months only: the flat fee runs on your own provider used to carry. |
  | Sandbox time | Each sandbox's time, memory and disk. |
  | Deployments | Builds and apps beyond the allowance. |
  | Private storage | Storage past the free amount, once a month. |
  | Search embeddings | Private text put in the search index, once a month. |
  | Security scans | History scans and dependency checks, once a month. |
  | Payments | Card payments and invoices paid. |
  | Credits from g1t | Credit g1t added, such as a goodwill credit. |
  | Refunds | Money given back to your card. |

- **Paid for.** Below the totals, what paid for usage before it was
  charged: **Paid by your Team plan's credit**, **Paid by your trial
  credit** and **Paid by g1t's open-source pool**, each with its amount.
  Lines show how much of them was paid this way, and each entry says so
  in its description. A month that closed under the
  [minimum charge](#the-minimum-charge) says what carried over.
- **Open a line** to see its entries, 50 at a time, newest first. Each
  run links to the pull request it was for.
- **Pick a month** to see an earlier one; months with no entries are not
  listed.
- **CSV** downloads every entry of the month, with the line it falls
  under and what the Team credit, the trial and the open-source pool paid
  of it, for your own books. Invoices from Stripe remain the record for
  what was charged to your card.

Each pull request's session also ends with what its run cost before the
margin.

## The preview

g1t is in preview.

- **Open to everyone:** accounts, workspaces, repositories, git, issues,
  pull requests, review, the API, and your own agent through MCP.
- **g1t's agents, for any workspace with its own model provider:** connect
  an Anthropic key or endpoint under [Integrations](/guides/models/) and the
  workspace's agents, acceptance checks and merge queue work at once. Your
  provider bills you for the models; g1t charges nothing for now, and only
  each run's sandbox time once pricing starts.
- **g1t's hosted models:** while payments are in test mode, every
  workspace can use g1t's own models on [its trial credit](#trials) ($1
  each, from a budget that renews monthly), and a few g1t has opened them
  to without limit. When payments go live, every workspace can use them,
  paid from its credit.

Each workspace decides where its model spend goes. A workspace that can use
neither sees a message saying so, with the way to connect its own provider.
