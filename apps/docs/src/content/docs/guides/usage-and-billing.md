---
title: Usage and billing
description: What is free on g1t, what the g1t plan costs and includes, how compute is paid for, the limits that keep spend in check, and enterprise billing.
---

The forge is free: repositories, git, issues, pull requests and review cost
nothing, for public and private work. What costs money is compute, the
things g1t runs for you: agents, the sandboxes they and your workflows run in,
deployed apps, and, on the plan, storage and git traffic past the free
amounts. Each is charged at what it costs g1t plus 20%, to the workspace
that owns the repository. There is no seat price, and on the plan there
are no quotas: only your spend limit stops anything.

## What is free

Every workspace, with or without the plan, has the whole forge:

- Public and private repositories, git, issues, pull requests and reviews.
- Protected branches, code owners and secret push protection.
- [Security scans](#storage-search-embeddings-and-scans) of history and
  dependencies, which g1t pays for on a free workspace.
- Search and Explore.
- The [audit log](/guides/audit-log/), with export: kept 7 days, or 90 on
  the plan.
- Your own agent through [MCP](/reference/mcp/).
- 1 GB of private repository storage, and 50,000
  [git operations](#git-operations) a month.

None of this is charged, on the plan or not. A free workspace is never
charged for storage: once its private repositories hold 1 GB, pushes to
them are refused at the start of the push, with what to do: make the
repository public, delete what you do not need, or start the plan, where
storage past 1 GB is usage and pushes never stop. Public repositories are
never charged for storage.

Compute is not free. Agents, workflows, the merge queue,
deployments and semantic search need [the g1t plan](#the-g1t-plan), or a
[card check](#no-card-no-compute) for the trial and the open-source pool.

### One free workspace per person

Each person can own **one free workspace**: a workspace that is not on the
g1t plan, an enterprise's terms or a full discount. A new workspace starts
free, so while you own a free workspace, creating another is refused with
the way forward:

1. Start the plan on the free workspace you have
   ([Start or end the plan](#start-or-end-the-plan)), or
2. delete it, if you no longer use it
   ([Delete a workspace](/guides/workspaces/)).

Then create the new one. If you owned several free workspaces before this
rule, you keep them all, but you cannot create another until each of them
is on the plan or deleted. Workspaces you belong to without owning them do
not count. The site's **New workspace** page says so before you start;
`POST /workspaces` and the MCP `workspace` tool's `create` action answer
`402` (`payment_required`) with the same message.

### Who a free workspace can add

A free workspace keeps the people already in it, but **cannot add anyone**
until it starts the plan:

- no new members, by username or by email invite;
- no outside collaborators on its repositories, and no invitations to them;
- an invite or invitation sent before cannot be accepted until then (it
  waits, and works once the plan is on).

Its members can still be given a role on its repositories, and put on its
[teams](/guides/teams/). On the **People** page and a repository's
**Settings → Access**, an owner sees **Start the plan to invite people**
with a button to the plan. Through the API and MCP, adding a member,
inviting, adding an outside collaborator and accepting are refused with
`402` (`payment_required`). g1t's own agent, `@g1t`, works in every
workspace and never counts as someone added.

Your own machines are. Workflow jobs on
[self-hosted runners](/guides/self-hosted-runners/) cost nothing, on every
plan, the free one included, and need no card; their minutes show on usage
as **Self-hosted runner time** at $0. Agent work you send to your runners
still needs its model paid for, unless it uses your own model provider.

## The g1t plan

One plan, **$20 a month per workspace**, however many people and agents
are in it. It is never priced per person. Like every price on g1t, it
excludes tax ([Tax](#tax)), and paid by card it carries Stripe's
[card processing fee](#card-processing-fee) as its own line, $0.91 a month
on $20.

- **$10 of usage each month** at cost plus 20%, used first.
- **Everyone in the workspace** at one price, never per person.
- **Unlimited** projects, previews and repositories.
- Agents, workflows, the merge queue,
  [deployments](/guides/deployments/) and semantic search.
- **90 days** of [audit log](/guides/audit-log/#how-long-it-is-kept), in
  place of a free workspace's 7.
- Usage past $10 is charged at cost plus 20%, **up to your
  [spend limit](#limits)**.

There are **no quotas** on the plan: no count of projects, previews,
build minutes, requests, custom domains, git operations or gigabytes
stops a workspace. Everything that costs g1t money is metered from the
first unit (past the free 1 GB of private storage and 50,000 git
operations that every workspace has), and only your spend limit stops
work.

**Included usage** pays for the month's usage first, at the same prices as
everything else: agents, sandbox time, builds, app traffic, custom domains,
storage, git operations, search embeddings and security scans. Past it,
usage is charged at cost plus 20%. It starts again on the 1st of each
month (UTC). **Unused included usage does not roll over.** Billing shows
how much of it this month's usage has drawn.

### What it costs

Every price is what g1t pays plus 20%, except models: they are charged at
the provider's price with no markup, and g1t's own part is the agent rate.
The live figures are on [g1t.sh/pricing](https://g1t.sh/pricing).

| What | Unit | Costs g1t | You pay |
| --- | --- | --- | --- |
| Agent models | A run | What the provider charged | The provider's price, from [AI credit](#ai-credit) |
| g1t agent rate | Million tokens a run uses (input, output and cached), [weighted by kind](#the-agent-rate) | — | $0.25, from Oct 22, 2026 |
| g1t agent rate, your own model key | The same, on runs that use [your own provider](/guides/models/) | — | $0.25, from Oct 22, 2026 |
| AI Gateway | A request | What the provider charged | The provider's price: free of markup during beta |
| Sandbox time (agents, workflows, the merge queue) | Second | About $0.001 a minute | About $0.0012 a minute |
| [Larger machines](#workflow-jobs-on-larger-machines) for workflow jobs (`g1t-2core`, `g1t-4core`) | Second | About 2.8 and 5.1 times a sandbox second | Cost + 20% |
| Deploy builds | Second | About $0.001 a minute | About $0.0012 a minute |
| App requests | Million | $0.30 | $0.36 |
| App CPU time | Million CPU milliseconds | $0.02 | $0.024 |
| Custom domains | Domain-month | $0.10 | $0.12 |
| Private storage, past the free 1 GB | GB-month | $0.50 | $0.60 |
| [Actions cache](#actions-cache) storage | GB-month | $0.015 | $0.018 |
| Git operations, past the free 50,000 a month | 1,000 | $0.15 | $0.18 |
| Search embeddings | Million tokens | $0.067 | $0.0804 |
| Security scans | Million CPU ms / million rows | $0.02 / $1.00 | $0.024 / $1.20 |
| Projects, previews, apps and repositories | | Next to nothing | Not charged |

Sandbox and build seconds follow what Cloudflare bills g1t, so the
figures above move a little; the pricing page always has today's.
Actions cache storage is charged at R2's published price, and is not on
the pricing page yet.

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

Back on Billing, the plan's card says **On the g1t plan** (**first month**
in the first billing cycle), with the billing period, a meter for the
month's included usage, and the **Upcoming invoice**: the plan and add-ons
at their monthly price plus usage still owed after included usage, credit
and any discount, from g1t's own ledger (**View upcoming invoice** splits
it). **Usage** and **Invoices** go to each. Runs on your own model provider
are not in it: your provider bills those. App traffic, custom domains,
storage and git operations are counted through the month and charged when
it closes. **Downgrade to free at the period's end** ends the plan then,
with nothing more charged after; **Keep the plan** takes that back until
then. If a renewal payment fails, the card says **Payment failed**, and the
plan's features stop until it is paid: update the card with **Manage in
Stripe** under **Payment method**.

Starting the plan uses the card from the card check, or else the default
card on Stripe's billing page, without a second page; with neither, Stripe's
page asks for one. If Stripe refuses, the page says why in a sentence.

A card that says **100% discount from g1t** or **Included by g1t** is on
under terms g1t set with the workspace, such as a
[100% discount](#enterprises-and-custom-terms), with nothing to pay or end.

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
pays for usage at cost plus 20%: agents, sandbox time, workflows,
the merge queue and semantic search. It never pays for deployments.

- Each card gets one trial, whichever workspace it is checked in. Prepaid
  cards start none.
- Trials come from a pool of **$100 a month** for everyone together. It
  renews on the 1st of each month (UTC). When a month's pool is given out,
  new trials wait until the 1st, and **Settings → Billing** says so.
- Billing and mission control show what is left.
- While on the trial, a workspace runs at most 2 agents at once, and each
  run for at most 60 minutes. See [caps](#caps).
- While payments are in test mode, the trial does not open g1t's hosted
  models: its agents run on the workspace's own
  [model provider](/guides/models/), and the trial pays for their sandbox
  time.

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
| A review by g1t | Yes |
| Catching up with `main` | Yes, when it needed an agent |
| Planning an [outcome](/guides/outcomes/) | Yes |
| The [merge queue](/guides/merge-queue/) | [Sandbox time](#sandbox-time) |
| [Workflow](/guides/actions/) jobs | [Sandbox time](#sandbox-time), more on a [larger machine](#workflow-jobs-on-larger-machines) |
| [Actions cache](#actions-cache) | What it holds, on the plan only |
| [Deployments](/guides/deployments/) | Builds, requests, CPU time and custom domains, from the first. Projects and previews are not charged. |
| [Private repository storage](#storage-search-embeddings-and-scans) | Past the free 1 GB, on the plan only |
| [Git operations](#git-operations) | Past the free 50,000 a month, on the plan only |
| [Search embeddings](#storage-search-embeddings-and-scans) | For private text, on the plan only |
| [Security scans](#storage-search-embeddings-and-scans) | On the plan only |
| Repositories, issues, pull requests, review, search, the API and MCP | No |

Each run is charged when it finishes: what the model provider charged for
it, with no markup; the agent rate on the tokens it used, on a line of its
own (*g1t agent rate: 1,240,000 tokens for work on acme/api#12*); and its
sandbox time. A small change costs a few cents. Tokens counted after a run
reports are charged when it is settled. Until Oct 22, 2026 the agent rate is
$0, and from Oct 8, 2026 models carry no markup (before, cost plus 20%); both
are dated changes on the pricing page.

Work a workspace routes to [its own model providers](/guides/models/) is
paid for at those providers instead. Such a run is charged here for its
[sandbox time](#sandbox-time), like any other sandbox, and the agent rate
on the tokens it used, on a line of its own (*g1t agent rate, your own
model key: 980,000 tokens for work on acme/api#12*).

### The agent rate

The agent rate pays for what g1t adds around the model: context, memory,
routing and orchestration. It is charged per million tokens a run used,
on g1t's models and on your own model key alike:

1. g1t's model proxy counts each answer's tokens as it passes: input,
   output, and prompt-cache reads and writes. The sandbox reports what its
   agent counted too, and the rate is charged on the more of the two.
2. Each kind of token counts at its weight: input ×1, output ×1, cache
   writes ×1, and cache reads ×0.1, as model providers price them. The weights
   are on [g1t.sh/pricing](https://g1t.sh/pricing) under the rate, and a
   change to them is a dated price change like any other.
3. The run is charged when it reports, and again for tokens counted after
   that, never twice for the same token.

On the **Usage** page the agent rate's lines count weighted tokens and name
the weights: **Agent rate** for runs on g1t's models, and **Agent rate, your
own model key** for runs on your own provider.

The charge goes to the workspace that owns the repository, whoever
assigned the issue. That is why putting g1t to work on a
repository needs the Write [role](/guides/access-and-roles/) or higher on it.

## Add-ons

An add-on is a monthly price per workspace that turns on more of g1t. Each
is its own line on the workspace's Stripe subscription and is turned on or
off from **Billing → Add-ons**.

| Add-on | Price | What it adds |
| --- | --- | --- |
| Security and quality | $10 a month | Custom secret patterns, validity checks, delegated bypass, code scanning, dependency review and the security overview on **private** repositories. Public repositories get all of it free. |

Secret scanning, push protection, vulnerability alerts, security updates,
the dependency graph and SBOMs are free everywhere, without the add-on. An
add-on does not need the plan, and the plan does not include one. Agent work
it starts, such as **Fix with g1t**, is ordinary usage. See
[What's free and what's paid](/guides/security/pricing/).

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
| App requests and CPU | Per million requests, per million CPU milliseconds |
| Custom domains | Per domain-month |
| Private storage past the free 1 GB | Per GB-month |
| Actions cache storage | Per GB-month |
| Git operations past the free 50,000 a month | Per 1,000 |
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
  reporting is charged from the gateway's logs instead of not at all. When
  the gateway has no price for a model a run used, the run is never settled
  below what its sandbox reported, and the correction says so.
- **Cloudflare.** Every day, g1t checks what Cloudflare billed its account
  against what was used: Containers and the Durable Objects behind them
  against the seconds containers ran, Workers for Platforms per request
  and per CPU millisecond. When a cost moves, the price book moves with
  it, and the change is listed on the pricing page with the reason. A
  large move, or a measurement far from the current cost, waits for a
  person at g1t to check it, so one odd day cannot reprice anything.

### How we keep prices at cost

Prices follow what Cloudflare charges g1t. Every day g1t reads its own
Cloudflare bill and sets it beside what it counted and what it charged
for the same things, product by product, so a price that no longer
matches its cost is found and corrected.

- **A price that goes down** changes at once.
- **A price that goes up** is announced first: it is listed on
  [g1t.sh/pricing](https://g1t.sh/pricing) with the day it takes effect,
  and owners of workspaces on the plan are emailed. It takes effect 14
  days later, and for something charged once a month (git operations,
  storage, the actions cache, custom domains, embeddings, scans) at the
  start of the month after that, so no month is charged at two prices.
- **Nothing already charged changes.** Each charge records the price it
  was made at.

Some of the Cloudflare products g1t pays for are in beta and do not yet
define exactly what they bill; see
[What g1t can't do yet](/about/limitations/#billing).

### Sandbox time

Every sandbox g1t starts runs on Cloudflare Containers, and Cloudflare
charges g1t for every second of it. So each one is metered by the second,
from start to stop, whatever it was for: agents, reviews, revisions,
catch-ups, planning, the merge queue and workflow jobs.
There are no free minutes.

A sandbox second is priced in two parts: memory, disk and the Durable
Object behind the container, for every second; and CPU, for the vCPU it
used. A run whose sandbox reports its own CPU use is priced on it. One
that does not is priced at the average CPU sandboxes use.

Each sandbox is one line on the [statement](#the-statement), such as
*Checks on acme/api#12: 3m 12s of sandbox time*. Deploy builds are not
counted here: [Deployments](/guides/deployments/) charges them by the
second, from the first, under **Builds**.

### Workflow jobs on larger machines

A workflow job whose `runs-on` names a [larger machine](/guides/actions/#machine-sizes)
runs on a larger Cloudflare Containers instance, and its seconds cost what
that instance costs g1t, plus 20%:

| `runs-on` | Instance | Its memory and disk, against the standard machine's | A second with its vCPUs as busy as an average sandbox's |
| --- | --- | --- | --- |
| `g1t-2core` | 2 vCPU, 8 GiB, 16 GB | 1.9 times | About 2.8 times a sandbox second |
| `g1t-4core` | 4 vCPU, 12 GiB, 20 GB | 2.7 times | About 5.1 times a sandbox second |

A job that reports its own CPU is priced on it: its memory and disk for
every second, and the vCPU-seconds it used. One that does not is priced
at the right-hand column. Its line on the statement names the machine,
such as *A workflow job in acme/api on g1t-4core: 6m 40s of sandbox
time*. A job usually finishes several times sooner on a larger machine,
so it often costs about the same.

## Git operations

Cloudflare charges g1t **$0.15 per 1,000 git operations** from 2026-10-14.
An operation is one clone or fetch (a request that fetches objects) or one
push, and making, forking or deleting a repository: what Cloudflare bills
g1t for. Listing refs, and anything g1t answers from its own cache, is
never an operation: a repeat clone of the same commit is served from
g1t's [pack cache](/guides/git/#where-a-slow-requests-time-went) and is not
counted. g1t meters every request it makes to the store, and
what counts follows what Cloudflare confirms it bills; this page changes
with it.

Your agents' git counts the same as yours. Agent runs, checks, reviews,
builds and workflow jobs clone, fetch and push through the same git
endpoints you use, and so does any git command an agent runs itself. Each
counts for the workspace whose repository it is. A pull request's working
copy, where an agent clones and pushes its changes, counts for the
workspace of the repository the pull request is in. g1t's own nightly
backups are never counted for your workspace.

| | Each month (UTC) |
| --- | --- |
| Free, on every workspace | 50,000 |
| On the plan, past 50,000 | $0.18 per 1,000 (cost plus 20%). Never slowed or refused. |
| Free workspace, past 50,000 | Not charged. Slowed to 60 an hour until the month turns. |

50,000 is far more than an active workspace uses; an agent run takes two
to four. A workspace on the plan pushes and clones on past it and pays for
what it uses, up to its spend limit. A free workspace is never charged for
git operations: past 50,000 in a month, its git requests past 60 in an
hour are answered `429` with when to try again.

Charging starts on 2026-10-14: operations before then are never charged.
**Billing** shows this month's count under **Git operations & storage**.

## Storage, search embeddings and scans

These are counted through the month and charged once it is over, as one
line dated the month's last day, so the limit counts them as they happen.
The plan's included usage and the trial pay for them first.

Security scans and search embeddings run on every workspace, with or
without the plan. On a free workspace g1t pays for them itself. They appear on the statement at $0, *covered by g1t*, never count
toward the limit and never use the trial.

| | What it costs g1t | What is counted |
| --- | --- | --- |
| Private repository storage | $0.50 a GB-month (Cloudflare Artifacts) | On the plan, each day, what the workspace's private repositories hold past the free 1 GB. A month's GB-months are those days added up, divided by 30. |
| Search embeddings | $0.067 per million tokens (Workers AI) | The text of private repositories, issues and pull requests put in the search index. Public text and searches are not charged. |
| Security scans | $0.02 per million CPU milliseconds and $1.00 per million rows written (Workers and D1) | The CPU each history scan and dependency check takes and the rows it writes. |

### Actions cache

What a workspace's [`actions/cache`](/guides/actions/#the-cache) entries
hold is measured every hour, and each day's largest figure counts. A
month's GB-months are those days added up, divided by 30, charged at
$0.018 a GB-month: R2's $0.015, plus 20%. It is charged from the first
byte, to workspaces on the plan only, as **Actions cache storage** under
**Git operations & storage**. A free workspace's caches are never charged;
they are held to the same 10 GiB a repository as everyone's.

### Private repository storage

Storage is charged at $0.60 a GB-month (cost plus 20%). It is measured from
the packs pushed through g1t's git endpoints to each repository and its
pull requests' working copies, so what is charged is never more than what
is stored. Public repositories are never charged, and neither is a free
workspace: its pushes to private repositories stop at 1 GB instead. On the
plan they never stop.

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

### Budget alerts

The spend limit is the workspace's monthly **budget** on usage past what the
plan includes. Under **Budget alerts**, owners choose:

| Setting | Means |
| --- | --- |
| **Alert at** | Any of 50, 75, 90 and 100% of the spend limit. Each is emailed to the owners once a month. |
| **Pause usage at 100%** | On (the default), new work stops at the limit. Off, the budget only alerts; g1t's own ceiling still applies. |
| **Webhook** | An `https://` address of your own, sent a JSON `POST` at each alert: `event` (`budget.alert`), `workspace`, `level_percent`, `spent_micros`, `budget_micros`, `sent_at`. |

Choose **Save alerts**. Through the API: `PUT /workspaces/:workspace/budget`,
or the MCP `billing` tool's `set_budget` action.

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

By card, the [card processing fee](#card-processing-fee) is its own line
(the card shows it for $100, $500 and $1,000); a bank transfer has none.
[Tax](#tax) is added where it applies. What you prepay is credited in full:
neither the fee nor the tax comes from it.

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
[caps on a plan](/guides/working-with-g1t/#caps-on-a-plan) for what happens at
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

## AI credit

Agent and AI Gateway usage is prepaid: a workspace on the plan buys **AI
credit**, and model usage draws on it, so g1t never fronts a model's cost.
The plan's included usage pays first; AI credit pays next, before any other
credit. Starting the plan comes with **$5 of AI credit, once** (it expires
a year after it is given).

### Buy AI credit

Only an owner can buy it.

1. Open **Settings → Billing and plans**, and find **AI credit**.
2. Choose $10, $25, $50 or $100, or **Custom** and type a whole-dollar
   amount from $10 to $1,000.
3. Choose **Buy AI credit**, and pay on Stripe's page.

The [card processing fee](#card-processing-fee) is its own line on that
page, and shown on Billing before you go there (on $25, *Card processing
fee $1.06, plus tax where it applies*), so the credit you get is the amount
you chose. [Tax](#tax) is added on top where it applies. The credit is
added once Stripe says the payment was made, whether or not you come back
to g1t, and **expires 1 year after purchase**. The card is kept for
auto-reload, which charges the credit, its card fee and its tax together.

### Auto-reload

Off by default. When it is on and AI credit falls below the amount you set,
g1t charges the saved card to bring it back to your target, in whole
dollars and at least $10, never more than your monthly maximum in a
calendar month (UTC).

| Setting | Means |
| --- | --- |
| **When AI credit falls below** | The threshold, such as $10 |
| **Reload it to** | The target, at least $10 above the threshold, at most $1,000 |
| **At most … a month** | The most auto-reload charges in a month, up to $10,000 |

g1t checks every 15 minutes, and right away when a run would otherwise
wait. If the card cannot be charged, auto-reload turns itself off and the
owners are emailed. Turn it on again after updating the card on Stripe.

### At $0

With no AI credit left and this month's included usage used, new runs on
g1t's models do not start, and the reason says to buy credit or turn on
auto-reload. Runs already going finish. Runs on your
[own model provider](/guides/models/) are not affected. A workspace with a
100% discount gets AI usage free through the discount, shown at its price
and then the discount; an enterprise is invoiced for it after use.

## Credits from g1t

g1t sometimes adds credit to a workspace: a welcome or referral credit, an
apology, or a refund for something that went wrong. The workspace's owners
get an email when it does, and **Billing** shows a **Credits from g1t**
card with each credit in a line, such as *$25.00 credit, $12.40 left,
expires Jan 5*.

| Kind | What it is | Expires |
| --- | --- | --- |
| Promotional | A welcome, a referral or an event. | Sometimes: the date is on the card and in the email. |
| Goodwill | An apology, or usage past what you meant forgiven. | Sometimes, as above. |
| Refund | Money back for something that went wrong, with what it is for. | Never. |

How credit is used:

1. It is added to your balance at once, so it lowers what you owe and
   raises what you can use before work stops.
2. Usage is paid from credit before anything you prepaid, and from the
   credit that expires soonest first.
3. Given while the workspace owes for this month, it pays that first.
4. Credit left when it expires stops counting, and the statement shows a
   line for what expired. g1t can also withdraw credit given by mistake;
   only what is left is withdrawn, never what was already used.

Credit is never paid out as money, and is never charged to a card. On the
statement, credits, expiries and withdrawals are under **Credits from g1t**.

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

Each is charged to the card on file, with the
[card processing fee](#card-processing-fee) and [tax](#tax) as lines of
their own. The Billing page lists them, with links to view each on Stripe
and download its PDF; each one's amount is the usage, with the fee and
tax under it.

## Tax

Every price on g1t excludes tax. Stripe adds sales tax, VAT or GST where it
applies (Stripe Tax), worked out from the workspace's billing address, and
shows it as its own line before you pay and on every receipt and invoice.
The plan, add-ons, prepaying, AI credit, auto-reload and invoices are all
taxed the same way, as software as a service for business use.

- **The address.** Stripe's payment pages always ask for a billing
  address, and save it as the workspace's **Invoice details**. A card check
  saves the card's billing address there too, if there is none yet. You
  can change it under [Your card and billing
  details](#your-card-and-billing-details).
- **A business tax ID.** Add it on Stripe's page or under **Invoice
  details** (the kind, such as EU VAT, and the number). Stripe checks it
  (**Verified by Stripe**, or **Stripe is checking it**) and applies it
  where the law says so, such as a reverse charge.
- **No address, no charge.** Where Stripe has nothing to work tax out
  from, g1t does not charge the card. Billing shows **Add a billing
  address**, the owners are emailed once, and the charge goes through once
  the address is saved. Nothing is lost, and work is not stopped for it.
  In the United States the ZIP code is needed; elsewhere the country.
- **Tax exempt.** If your organisation is exempt, write to
  support@g1t.sh with the certificate; Billing then says **Tax exempt**.
- **Refunds** give the tax back in proportion.

Tax is never part of your balance or usage: the statement shows it as its
own line, beside the payment it came with.

## Card processing fee

Paying by card adds Stripe's fee, **2.9% + $0.30**, as its own line,
**Card processing fee**, worked out so that what is left after Stripe's
fee is exactly what you paid for: $0.91 on the $20 plan, $1.06 on $25 of
AI credit. It is shown before you pay, on every card payment:

| Payment | Card fee |
| --- | --- |
| The plan and add-ons, each month | Yes, a monthly line |
| Prepaying by card, and AI credit | Yes |
| Auto-reload, and invoices charged to the card | Yes |
| Prepaying by bank transfer | No |
| An enterprise's invoices | No |

Tax applies to the fee as to what it is paid with. The fee pays Stripe, not
g1t: usage is still charged at cost plus 20%, and models at the provider's
price plus the agent rate. The statement shows card fees as their own line,
never from your balance.

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

Cards live on **Stripe's billing page**, not on g1t: g1t never sees or
stores card numbers. On **Settings → Billing and plans**:

- **Payment method** shows the default card (brand, last four digits and
  expiry). **Manage in Stripe** opens Stripe's page, where an owner adds,
  removes or replaces a card and makes one the default. The plan and
  auto-reload charge the default card.
- **Invoice details** are kept on the workspace's Stripe customer and
  printed on every invoice: the invoice email, company name, billing
  address, tax ID (its kind and number), a purchase order, and the invoice
  language. An owner edits them here and chooses **Save invoice details**.
  [Tax](#tax) is worked out from the address, so the card says when there
  is none yet (in the US it needs the ZIP code), shows Stripe's check of
  the tax ID, and says **Tax exempt** or **Reverse charge** when that
  applies.
- **Invoices** lists every invoice Stripe sent (the plan, add-ons, AI
  credit and month-end usage), each with **View** and **PDF**.
- **Add-ons** lists what can be turned on beside the plan, such as the
  [Security and quality activation](/guides/security/), with its price and
  **Turn on** or **Turn off**.

g1t support never takes card details by phone or email.

If a card is declined, work stops until the workspace pays, and the
Billing page and the API say why. Replace the card or prepay to clear it.
A payment disputed with the card's bank stops work the same way.

Through the API, `GET /workspaces/:workspace/billing_details` and
`GET /workspaces/:workspace/invoices` (the MCP `billing` tool's
`billing_details` and `invoices` actions) read the same.

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

Every workspace, free or on the plan, has the [audit log](/guides/audit-log/),
with the same CSV and JSON export, and secret scanning, push protection,
vulnerability alerts and security updates. The rest of the security suite
(custom patterns, validity checks, delegated bypass, code scanning,
dependency review and the security overview) is free on public
repositories and, on private ones, the **Security and quality**
activation: a monthly price per workspace from the price book ($10 today),
turned on from the Billing page, with or without the plan. See
[what's free and what's paid](/guides/security/pricing/). What the plan changes is how long the log is
kept: [7 days free, 90 on the plan](/guides/audit-log/#how-long-it-is-kept),
and longer by arrangement. Single sign-on through your identity provider is not
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
  workspaces' work stops until it is paid. [Tax](#tax) is added from the
  enterprise's billing address, which g1t keeps on its Stripe customer, and
  an invoice never carries the card processing fee.
- **A discount**: a percentage off every usage charge, from a few percent
  to 100%, with a reason, sometimes until a date. Prices themselves stay
  the public ones. The statement shows every line at its price and the
  discount beside it: the totals read **Usage at price**, **Discount
  (30%)** and **Charged**, each day or project has a **Discount** line, and
  the CSV has `price (USD)` and `discount (USD)` columns. The Usage page
  shows usage at price too, with the discount and what was charged.
- **A 100% discount**: nothing is charged, and the plan is on without
  being charged. The statement and the Usage page still show everything at
  its price, so you can see what the workspace would pay.
- **A limit of its own**, or a larger share of the pools.
- **A longer audit log**: up to 400 days for every workspace the account
  pays for, in place of the plan's 7 or 90. See
  [how long it is kept](/guides/audit-log/#how-long-it-is-kept).

g1t's own workspaces and those of Flagon, Inc., the company that makes g1t,
have a 100% discount. Their usage is shown at price and kept apart from
what customers pay.

Each change is made by g1t staff and recorded with who made it and why. To
ask for one, write to [hey@flagon.io](mailto:hey@flagon.io).

## Earlier plans

Deployments used to be a $5 plan of its own. It is part of the g1t plan
now. A Deployments subscription bought before keeps working until its
current period ends, and is not renewed.

## The Usage page

A workspace's **Usage** page, `g1t.sh/<workspace>/-/usage`, shows what it
used, by product, project and day. Every member can see it, from **Usage**
in the workspace's sidebar. A project's own, `g1t.sh/<workspace>/<project>/usage`,
shows the same for that project.

Every amount is **usage at price**: what was charged, plus what included
usage, credit or a discount paid for it. It is the one figure mission
control, the agent fleet, Usage and Billing all show, so they agree.

The filters, in one row:

| Filter | Choices |
| --- | --- |
| Period | **Current billing cycle** (the calendar month, UTC), **Last billing cycle**, the last 7, 30 or 90 days, or a **Custom range** of up to 400 days. The days it covers are shown beside it. |
| Products | Any of Agent, Sandboxes, AI Gateway, Deployments, Git & storage, Packages, Security & quality and Search. |
| Projects | Any of the projects with usage in the period. |
| Group by | Product, project or day, for the breakdown. |
| **⋯** | **Export CSV** (a row per day, product and meter) and the usage API. |

Then:

- **Included usage, credit and this range**: the plan's included usage this
  month, AI credit and credit from g1t left, and what the range came to:
  usage at price, then the discount (shown as *Discount (100%)* for a
  workspace g1t covers in full), included usage and pools, credits applied,
  and what is charged.
- **Consumption**: a column per day, week or month (**Daily**, **Weekly**,
  **Monthly**), stacked by product, with **Cumulative** to add them up.
  Hover or focus a column for each product's part; **Show as a table** has
  every number.
- **The breakdown**: each product family with its meters (the agent's
  model tokens, agent rate, agent rate on your own model key and sandbox
  time; sandbox time; builds; git operations and private storage with what
  is free; and so on), each with a trend line, how much was used and its
  charge at price. Open a meter for its projects. The agent also shows its
  runs, reviews, plans and checks, and its tokens by model.

Storage, git operations, scans and search embeddings are metered through
the month and charged when it closes; until then they are marked pending.
Through the API: `GET /workspaces/:workspace/usage`, or the MCP `billing`
tool's `usage` action.

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
  | Agent runs | Runs on g1t's models: the model at the provider's price (cost plus 20% before Oct 8, 2026). |
  | Agent rate | The agent rate on runs on g1t's models. |
  | Agent rate, your own model key | The agent rate on runs on your own provider. |
  | Runs on your own model provider | Older months only: the flat fee runs on your own provider used to carry. |
  | Sandbox time | Each sandbox's time. |
  | Self-hosted runner time | Each job on your own runners, at $0. |
  | Deployments | Builds as they finish; each month's requests, CPU time and custom domains when it closes. |
  | Private storage | Storage past the free 1 GB, once a month. |
  | Actions cache storage | What `actions/cache` held, on the plan, once a month. |
  | Git operations | Operations past the free 50,000, once a month. |
  | Search embeddings | Private text put in the search index, once a month. |
  | Security scans | History scans and dependency checks, once a month. |
  | Payments | Card payments and invoices paid. |
  | Credits from g1t | Credit g1t added (promotional, goodwill or a refund), and what of it expired or was withdrawn. See [Credits from g1t](#credits-from-g1t). |
  | Refunds | Money given back to your card. |
  | Tax | Tax paid with that day's payments. Not a charge, and not from your balance. |
  | Card processing fees | Card fees paid with that day's payments. Not a charge, and not from your balance. |

  Payments are what reached your balance; the tax and card fee paid with
  them are the two lines below them, and the totals say what they came to.

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
to the workspaces g1t runs itself. Every other workspace's agents and merge
queue work with [its own model provider](/guides/models/), and
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
or none), `spike`, `alerts`, `gitOperations` and `gitOperationsIncluded`
(the git operations free for every workspace), `freePrivateStorageBytes`
(the private storage free for every workspace) and `buildSecondsUsed`.
None of these is a quota on the plan.

**`usage_meters`** (`workspace`, `viewer`; members only) returns this
month's usage in six lines, `agents`, `builds`, `requests`, `domains`,
`git_storage` and `search_scans`, each with `micros` (at cost plus 20%,
before included usage or a pool paid for it) and a `quantity` such as
*42 build minutes*, each at price (what was charged plus what paid for it), as Usage measures it.

**`usage_report`** (`workspace`, `viewer`, `from`, `until`, optional `products` and `projects`; members only) is what the Usage page reads: totals (`priceMicros`, `discountMicros`, `includedMicros`, `creditsMicros`, `chargedMicros`, `pendingMicros`), each day's usage by product, and every product family with its meters, their daily figures and their projects.

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
