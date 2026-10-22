---
title: Usage and billing
description: What is free on g1t, what the g1t plan costs and includes, how compute is paid for, the limits that keep spend in check, and enterprise billing.
---

The forge is free: repositories, git, work items, pull requests and review cost
nothing, for public and private work. What costs money is compute, the
things g1t runs for you: the sandboxes your workflows and checks run in,
deployed apps, and, on the plan, storage and git traffic past the free
amounts. Each is priced from what it costs g1t, plus 20%: runner minutes
at a fixed rate for each machine, everything else at its cost plus 20%.
It is charged to the workspace that owns the repository. There is no seat price.
Your spend limit bounds paid usage; public storage and service size limits still apply.

Wherever this page says an owner can do something to a workspace's
billing, so can its [billing managers](/guides/workspaces/#roles-that-add-to-a-member):
starting or ending the plan, the spend limit and budget alerts,
prepaying, the card and billing details. Deleting the
workspace stays with owners.

## What is free

Every workspace, with or without the plan, has [Chat](/guides/chat/) and
the whole forge:

- Channels, direct messages, threads, mentions and live delivery, with no
  limit on history. People chatting is never charged.
- Public and private repositories, git, work items, pull requests and reviews.
- Protected branches, code owners and secret push protection.
- [Security scans](#storage-search-embeddings-and-scans) of history and
  dependencies, which g1t pays for on a free workspace.
- Search and Explore.
- The [audit log](/guides/audit-log/), with export: kept 7 days, or 90 on
  the plan.
- Your own coding agent through [MCP](/reference/mcp/).
- 1 GB of private repository storage, 5 GB of public repository storage,
  and 50,000 [git operations](#git-operations) a month.

None of this is charged, on the plan or not. A free workspace is never
charged for storage: once its private repositories hold 1 GB, pushes to
them are refused at the start of the push, with what to do: make the
repository public, delete what you do not need, or start the plan, where
storage past 1 GB is usage and pushes never stop. Public repositories are
never charged for storage. Every workspace, including paid workspaces,
has a **5 GB public repository storage cap**. Pushes, imports, forks and
changes that would add public storage need room within that cap.
Recently deleted repositories still count until permanently deleted.

A write reserves room under the cap before it reaches storage, so writes
at the same moment cannot overshoot it together, and gives back what it
did not use as soon as it finishes. A push still uploading after an hour
is declined, and nothing of it is stored: a push is at most 100 MB,
which uploads well within an hour on any ordinary connection. A write that is interrupted
keeps its reservation until g1t staff confirm it can no longer finish,
from what the write itself recorded and never by its age alone. While it
is held, a reservation counts against the 5 GB cap, but it is never
charged: only what g1t measured as stored is. If public pushes are
refused for room your repositories do not use, ask g1t support to look.

Compute is not free. Workflows, the merge queue,
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
[teams](/guides/teams/). On the **Members** and **Invitations** pages and a repository's
**Settings → Access**, an owner sees **Start the plan to invite people**
with a button to the plan. Through the API and MCP, adding a member,
inviting, adding an outside collaborator and accepting are refused with
`402` (`payment_required`).

Your own machines are. Workflow jobs on
[self-hosted runners](/guides/self-hosted-runners/) cost nothing, on every
plan, the free one included, and need no card; their minutes show on usage
as **Self-hosted runner time** at $0.

## The g1t plan

One plan, **$21 a month per workspace**, however many people are in it. It is never priced per person. Like every price on g1t, it
excludes tax ([Tax](#tax)). There is no card processing fee on top: it is
part of the price.

- **$10 of usage each month**, used first: everything g1t runs, at the
  [prices below](#what-it-costs) (runner minutes at their flat rate per
  machine, everything else at cost plus 20%). That is 2,500 runner minutes on the standard machine
  (`ubuntu-latest`), or about 3,333 on `ubuntu-slim`.
- **Everyone in the workspace** at one price, never per person.
- **Unlimited** repositories and previews.
- Workflows, the merge queue,
  [deployments](/guides/deployments/), semantic search, and
  [Security and quality](/guides/security/pricing/) on private
  repositories.
- **90 days** of [audit log](/guides/audit-log/#how-long-it-is-kept), in
  place of a free workspace's 7.
- Usage past $10 is charged the same way, **up to your
  [spend limit](#limits)**.

The plan has no count limit on repositories or previews. Public repository
storage has the 5 GB cap above, and repository and request size limits
still apply. Paid usage is metered from the
first unit (past the free 1 GB of private storage and 50,000 git
operations that every workspace has). Your spend limit also stops new
paid work.

**Included usage** pays for the month's usage first, at the same prices as
everything else: runner minutes, builds, app traffic, custom domains,
storage, git operations, search embeddings and security scans. Past it,
usage is charged at the same prices. It starts again on the 1st of each
month (UTC). **Unused included usage does not roll over.** Billing shows
how much of it this month's usage has drawn.

### What it costs

Pricing has two rules:

1. **Everything g1t runs at cost plus 20%.** Builds, hosting, storage,
   git operations, search and security scans: what g1t pays for them,
   plus 20%. [Runner minutes](#runner-minutes) are a fixed rate for each
   machine, set the same way: what a minute of it costs g1t with half its
   vCPUs busy, plus 20%, rounded up to a tenth of a cent, and never under
   its cost with every vCPU busy.
2. **Your own runners are free.** Jobs on your
   [own runners](/guides/self-hosted-runners/) cost nothing here.

There are no seats. The live figures are on
[g1t.sh/pricing](https://g1t.sh/pricing).

| What                                                                                                                     | Unit                                                                          | Costs g1t                                                  | You pay                          |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| [Runner minutes](#runner-minutes) on the standard machine (2 vCPU, 8 GiB, 16 GB): workflow jobs, checks, the merge queue | Minute, each job rounded up                                                   | From $0.0014 a minute idle to $0.0038 with both vCPUs busy | $0.004 a minute                  |
| [Runner minutes](#runner-minutes) on `ubuntu-slim` (1 vCPU, 6 GiB, 12 GB)                                                | Minute, each job rounded up                                                   | From $0.0010 a minute idle to $0.0022 with its vCPU busy   | $0.003 a minute                  |
| Deploy builds                                                                                                            | Second                                                                        | About $0.0017 a minute                                     | About $0.002 a minute            |
| App requests                                                                                                             | Million                                                                       | $0.30                                                      | $0.36                            |
| App CPU time                                                                                                             | Million CPU milliseconds                                                      | $0.02                                                      | $0.024                           |
| Custom domains                                                                                                           | Domain-month                                                                  | $0.10                                                      | $0.12                            |
| [Container apps](/guides/deployments/#docker-deployments), while awake                                                   | Second, by the minute: vCPU, memory, disk and the Durable Object, by the size | From $0.0129 an hour (`lite`)                              | Cost + 20%: from $0.0155 an hour |
| Data container apps send                                                                                                 | GB                                                                            | $0.05                                                      | $0.06                            |
| Private storage, past the free 1 GB                                                                                      | GB-month                                                                      | $0.50                                                      | $0.60                            |
| [Actions cache](#actions-cache) storage                                                                                  | GB-month                                                                      | $0.015                                                     | $0.018                           |
| Git operations, past the free 50,000 a month                                                                             | 1,000                                                                         | $0.15                                                      | $0.18                            |
| Search embeddings                                                                                                        | Million tokens                                                                | $0.067                                                     | $0.0804                          |
| Security scans                                                                                                           | Million CPU ms / million rows                                                 | $0.02 / $1.00                                              | $0.024 / $1.20                   |
| Repositories, previews and apps                                                                                          |                                                                               | Next to nothing                                            | Not charged                      |

Build seconds follow what Cloudflare bills g1t, so that figure moves a
little; the pricing page always has today's. Runner minutes are fixed
rates.
Actions cache storage is charged at R2's published price, and is not on
the pricing page yet.

**The other $10** pays for running g1t, the free forge everyone uses, and
the people building it.

Deployments are part of the plan. There is no separate Deployments
purchase.

### Start or end the plan

Only an owner or a billing manager can start or end the plan.

1. Open **Workspace → Access → Billing and plans**, `g1t.sh/<workspace>/-/settings/billing`.
2. On the **g1t** card, choose **Start the g1t plan**.
3. If the workspace already has a checked card, the plan starts on it at
   once. Otherwise, pay on the card page you are sent to.

Back on Billing, the plan's card says **On the g1t plan** (**first month**
in the first billing cycle), with the usage month and the day the plan
renews: **Usage month Oct 1 – Oct 31, 2026; the plan renews Nov 15, 2026**.
Usage is counted by calendar month (UTC), but the plan renews on the day
of the month it started, so a plan started mid-month renews mid-month.
Then come a meter for the month's included usage, and the **Upcoming invoice**: the plan and add-ons
at their monthly price plus usage still owed after included usage, credit
and any discount, from g1t's own ledger (**View upcoming invoice** splits
it). **Usage** goes to usage by product and repository. App traffic, custom
domains, storage and git operations are counted through the month and
charged when it closes.

To end the plan, choose **Manage billing** and cancel it on Stripe's
billing page: it ends at the end of the period, with nothing more charged
after, and the plan's card says **Ends on** and the date. Until then,
**Manage billing** lets you keep it after all. If a renewal payment fails,
the card says **Payment failed**, and the plan's features stop until it is
paid: choose **Update payment method** and change the card on Stripe's
page.

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

1. Open **Workspace → Access → Billing and plans**.
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
pays for usage at the plan's prices: runner minutes for checks, workflows
and the merge queue (1,250 on the standard machine, about 1,666 on
`ubuntu-slim`), and semantic search. It never pays for deployments.

- Each card gets one trial, whichever workspace it is checked in. Prepaid
  cards start none.
- Trials come from a pool of **$100 a month** for everyone together. It
  renews on the 1st of each month (UTC). When a month's pool is given out,
  new trials wait until the 1st, and **Billing and plans** says so.
- Billing shows what is left.

The trial does not turn into a charge. Nothing is charged until an owner
starts the plan. If a free workspace's last trial run goes past what was
left, g1t covers the difference, and the statement shows it as **Covered
by g1t**. When the trial is used up, new compute waits for the plan.

## The open-source pool

g1t sets aside **$50 a month** for public repositories, at most **$4 a
month** for any one repository: 12,500 and 1,000 minutes of workflow
jobs, checks and merge queue runs on the standard machine, which public
repositories get as private ones do. It pays for **checks, workflows and the merge queue on
public repositories**, after a card check. It does not pay
for deployments, storage or embeddings.

When the pool or the repository's share is spent, those runs wait for the
next month, or for the plan. Each statement line the pool paid says so,
and the month's statement totals it under **Paid by g1t's open-source
pool**.

## What is charged

|                                                                          | Charged                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Checks and the [merge queue](/guides/merge-queue/)                       | [Runner minutes](#runner-minutes)                                                                                         |
| [Workflow](/guides/actions/) jobs                                        | [Runner minutes](#runner-minutes), at the rate of the machine each ran on                                                 |
| [Actions cache](#actions-cache)                                          | What it holds, on the plan only                                                                                           |
| [Deployments](/guides/deployments/)                                      | Builds, requests, CPU time, custom domains and container time, from the first. Repositories and previews are not charged. |
| [Private repository storage](#storage-search-embeddings-and-scans)       | Past the free 1 GB, on the plan only                                                                                      |
| [Git operations](#git-operations)                                        | Past the free 50,000 a month, on the plan only                                                                            |
| [Search embeddings](#storage-search-embeddings-and-scans)                | For private text, on the plan only                                                                                        |
| [Security scans](#storage-search-embeddings-and-scans)                   | On the plan only                                                                                                          |
| Repositories, work items, pull requests, review, search, the API and MCP | No                                                                                                                        |

The charge goes to the workspace that owns the repository, whoever
started the work.

## Add-ons

**Billing → Add-ons** lists what comes with the plan beside its usage, and
whether it is on:

| Add-on                 | Price                              | What it adds                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security and quality   | With the plan, no price of its own | Custom secret patterns, validity checks, delegated bypass, code scanning, dependency review and the security overview on **private** repositories. Its scans are charged at cost plus 20%. Public repositories get all of it free. |
| Production deployments | With the plan                      | Previews per pull request and production on g1t.page, metered at cost plus 20%.                                                                                                                                                    |

Secret scanning, push protection, vulnerability alerts, security updates,
the dependency graph and SBOMs are free everywhere, on every plan. See [What's free and what's paid](/guides/security/pricing/).

## How prices are set

Every price is what g1t pays for the thing, at Cloudflare, plus 20%;
[runner minutes](#runner-minutes) are a fixed rate for each machine, set
the same way from what a minute of it costs. The live prices are on
[g1t.sh/pricing](https://g1t.sh/pricing), straight from the price book
billing charges from.

| Meter                                       | Unit                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Runner minutes                              | Per minute, each job rounded up, at a fixed rate for each machine                                                                         |
| Deploy builds                               | Per second                                                                                                                                |
| App requests and CPU                        | Per million requests, per million CPU milliseconds                                                                                        |
| Custom domains                              | Per domain-month                                                                                                                          |
| Container apps                              | Per vCPU-second, GiB-second of memory and GB-second of disk while awake, a second of the Durable Object in front of each, and per GB sent |
| Private storage past the free 1 GB          | Per GB-month                                                                                                                              |
| Actions cache storage                       | Per GB-month                                                                                                                              |
| Git operations past the free 50,000 a month | Per 1,000                                                                                                                                 |
| Search embeddings                           | Per million tokens                                                                                                                        |
| Security scans                              | Per million CPU milliseconds and per million rows written                                                                                 |

Prices keep themselves current as those costs move. Every day, g1t
checks what Cloudflare billed its account against what was used:
Containers and the Durable Objects behind them against the seconds
containers ran, Workers for Platforms per request and per CPU millisecond.
When a cost moves, the price book moves with it, and the change is listed
on the pricing page with the reason. A large move, or a measurement far
from the current cost, waits for a person at g1t to check it, so one odd
day cannot reprice anything.

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
- **A new machine** is priced at what it costs from its first minute, so
  g1t never charges less than it pays. When the standard machine became
  [2 vCPU, 8 GiB and 16 GB](#runner-minutes), its runner minutes and
  deploy builds were priced for it at once.
- **Nothing already charged changes.** Each charge records the price it
  was made at.

Some of the Cloudflare products g1t pays for are in beta and do not yet
define exactly what they bill; see
[What g1t can't do yet](/about/limitations/#billing).

### Runner minutes

Every job g1t runs on its own machines (a workflow job, a check, a merge
queue run) is charged by the minute, at a fixed rate for the machine it
ran on:

| `runs-on`                                                            | Machine             | vCPUs | Memory | Disk  | A minute |
| -------------------------------------------------------------------- | ------------------- | ----- | ------ | ----- | -------- |
| `ubuntu-latest`, any other Linux label, or a label g1t does not know | Standard (`2-core`) | 2     | 8 GiB  | 16 GB | $0.004   |
| `ubuntu-slim`                                                        | `1-core`            | 1     | 6 GiB  | 12 GB | $0.003   |

The labels are GitHub's, at the sizes GitHub gives a private repository,
in public repositories too ([machine sizes](/guides/actions/#machine-sizes)).
A job is charged as the machine it ran on. Checks and the merge queue run
on the standard machine. `g1t-2core` and `g1t-4core`, the labels g1t had
before, get the standard machine, at its rate.

**How a job's minutes are counted.** Each job's time, from when its
machine starts to when it stops, is rounded up to the whole minute: a
job of 61 seconds is 2 minutes, and any job that ran is at least 1. Each
job is rounded on its own, so a run of three 20-second jobs is 3
minutes. There are no free minutes outside the plan's
[included usage](#the-g1t-plan), the [trial](#the-trial) and the
[open-source pool](#the-open-source-pool), which pay for minutes at these
rates.

**Why these rates.** Cloudflare bills g1t for a machine's memory and disk,
and the Durable Object behind it, for every second it runs, busy or idle,
and for its CPU as it is used. Each rate is what a minute of the machine
costs g1t with half its vCPUs busy, plus 20%, rounded up to a tenth of a
cent, and never under what it costs with every vCPU busy:

| Machine             | Costs g1t a minute, idle | With half its vCPUs busy | With every vCPU busy | A minute |
| ------------------- | ------------------------ | ------------------------ | -------------------- | -------- |
| Standard (`2-core`) | $0.0014                  | $0.0026                  | $0.0038              | $0.004   |
| `1-core`            | $0.0010                  | $0.0016                  | $0.0022              | $0.003   |

`ubuntu-slim`'s rate is its cost with its vCPU busy, rounded up: with
half of it busy plus 20%, $0.0020, would be under that. Should a job ever
cost g1t more than its minutes at the rate, it is charged that cost
instead.

Each job is one line on the [statement](#the-statement), naming its
machine and minutes, such as _A workflow job in acme/api on ubuntu-slim:
6m 40s, 7 minutes on the 1-core machine_. Usage, the statement and the API
total them as **Runner minutes, 2-core** and **Runner minutes, 1-core**;
minutes from before the `4-core` machine was retired stay under
**Runner minutes, 4-core**, and months before runner minutes show
**Sandbox time**, by the second.
Deploy builds are not counted here: [Deployments](/guides/deployments/)
charges them by the second, from the first, under **Builds**. Jobs on
[your own runners](/guides/self-hosted-runners/) are free: they show as
**Self-hosted runner time** at $0.

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

Checks, builds and workflow jobs clone, fetch and push through the same
git endpoints you use, and count the same as yours, as does any coding
agent you connect. Each counts for the workspace whose repository it is.
A pull request's working copy counts for the workspace of the repository
the pull request is in. g1t's own nightly
backups are never counted for your workspace.

|                             | Each month (UTC)                                          |
| --------------------------- | --------------------------------------------------------- |
| Free, on every workspace    | 50,000                                                    |
| On the plan, past 50,000    | $0.18 per 1,000 (cost plus 20%). Never slowed or refused. |
| Free workspace, past 50,000 | Not charged. Slowed to 60 an hour until the month turns.  |

50,000 is far more than an active workspace uses. A workspace on the plan pushes and clones on past it and pays for
what it uses, up to its spend limit. A free workspace is never charged for
git operations: past 50,000 in a month, its git requests past 60 in an
hour are answered `429` with when to try again.

Charging starts on 2026-10-14: operations before then are never charged.
**Billing** shows this month's count under **Git operations & storage**.

A month's operations are charged in full, up to its last minute: its
final count is taken once the month has ended (from an hour after
midnight UTC on the 1st), and the month is charged and closed only after
that, at the plan the workspace had that month.

## Storage, search embeddings and scans

These are counted through the month and charged once it is over, as one
line dated the month's last day, so the limit counts them as they happen.
The plan's included usage and the trial pay for them first.

Security scans and search embeddings run on every workspace, with or
without the plan. On a free workspace g1t pays for them itself. They appear on the statement at $0, _covered by g1t_, never count
toward the limit and never use the trial.

|                            | What it costs g1t                                                                      | What is counted                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private repository storage | $0.50 a GB-month (Cloudflare Artifacts)                                                | On the plan, each day, what the workspace's private repositories hold past the free 1 GB. A month's GB-months are those days added up, divided by the days in the month. |
| Search embeddings          | $0.067 per million tokens (Workers AI)                                                 | The text of private repositories, work items and pull requests put in the search index. Public text and searches are not charged.                                        |
| Security scans             | $0.02 per million CPU milliseconds and $1.00 per million rows written (Workers and D1) | The CPU each history scan and dependency check takes and the rows it writes.                                                                                             |

### Actions cache

What a workspace's [`actions/cache`](/guides/actions/#the-cache) entries and its runs'
[artifacts](/guides/actions/#artifacts) hold is measured every hour, and each day's largest figure counts. A
month's GB-months are those days added up, divided by the days in the month, charged at
$0.018 a GB-month: R2's $0.015, plus 20%. It is charged from the first
byte, to workspaces on the plan only, as **Actions cache storage** under
**Git operations & storage**. A free workspace's caches are never charged;
they are held to 10 GiB a repository, where the plan's hold 100 GiB, and to 10 GiB of artifacts a run.

### Private repository storage

Storage is charged at $0.60 a GB-month (cost plus 20%). It is measured from
the packs pushed through g1t's git endpoints to each repository and its
pull requests' working copies, so what is charged is never more than what
is stored. A push, merge or update that storage refused, for example
because its branch moved meanwhile, is not counted. Neither are the copies
g1t makes for its own use, such as a pull request's test merge, or its head
copied in from someone's fork: g1t wrote them, or they were counted where
they were pushed (a fork's to the fork), never to a repository whose owner
did not push them. Public repositories
are never charged, and neither is a free workspace: its pushes to private
repositories stop at 1 GB instead. On the plan they never stop.

A [fork](/concepts/forks/) counts toward the workspace it was forked into
in full, from the moment it is made: its size is what was copied into it,
however much it shares with the repository it came from. A free workspace
cannot take a private fork that would carry its private repositories past
1 GB. Pull requests' working copies are counted with the repository they
belong to.

## How spend is counted

Everything a workspace uses is entered on one ledger, as it happens, and
every figure on every page is read back from it. There is no second count
to disagree with it.

| Figure                           | What it is                                                                                                                                                                                                                                                                                                                                                                                                                            | Where it shows                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Spent**, or usage **at price** | Every entry at its price: what was charged, plus what the plan's included usage, the trial, a pool or g1t paid of it, plus what a discount took off. The one measure of usage.                                                                                                                                                                                                                                                        | The [Usage page](#the-usage-page), the [statement](#the-statement)                            |
| **Charged**                      | What is left for the workspace to pay this month: usage at price, less your discount, less what included usage, the trial, a pool or g1t paid, less what [credit](#credits-from-g1t) paid. Never below zero: a workspace with a 100% discount is charged exactly nothing. Usage metered through the month and charged when it closes (storage, git operations, scans, embeddings, domains, app traffic) counts now on the same terms. | Billing's plan card, and the figure your [spend limit](#your-spend-limit) is measured against |

**This month** is the calendar month in UTC, from its first day to today,
on every page: Billing's plan card and Usage's current billing cycle ask
billing for the same days and show the same figure. Usage metered through the month and
charged when it closes (storage, git operations, scans, embeddings,
domains, app traffic) has no day of its own, so it counts in any range
that reaches into the current month, and Usage's receipt says what of it
will be charged at the close on your terms: your discount and included
usage come off it then, the same as the rest.

Every amount is written the same way: to the cent, rounded half up on
whole millionths of a dollar, so the same sum never reads differently on
two pages. Under a cent reads **<$0.01** rather than $0.00 on a total,
and exactly nothing is $0.00. Where the fraction of a cent is the point,
the [statement](#the-statement) and the
[price book](https://g1t.sh/pricing), amounts carry up to four places
(`$0.0063`).

Through the API, `GET /workspaces/:workspace/usage` answers with the
products and `totals.charged_micros`, with `totals.pending_charged_micros` for what of the pending usage the close will charge;
`GET /workspaces/:workspace/budget` answers with the spend limit and
`spent_micros`, the same charged figure.

## Limits

Every workspace has two limits: **g1t's ceiling** on usage not yet paid
for, and **your spend limit** on what is charged in a month. Work stops at
whichever is lower. Both are in the **Spend limit** section of **Settings →
Billing and plans**, on the plan.

### The ceiling

Usage is charged after it runs, so at any moment some of it is not yet
paid. g1t lets that reach a ceiling that grows with your history:

|                                      | Ceiling on what is unpaid                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Free**                             | None to reach: a free workspace is never charged. The trial and g1t's pools pay for its compute. |
| **First month on the plan**          | $100                                                                                             |
| **Paid**                             | Twice what you have paid, never below $100, up to $1,000                                         |
| **Established**: three steady months | Three times your monthly spend, up to $10,000                                                    |
| **Reviewed**                         | What g1t set with you                                                                            |

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

What the workspace may be charged in a month (UTC): usage at price after
your discount, included usage, the trial, pools and credit, as
[How spend is counted](#how-spend-is-counted) defines it, the same figure
as the plan card's **charged**. At it, new work stops until the month
turns or an owner raises it. Until owners set one, it is
**automatic**: $200, or twice last month's spend, whichever is more, up to
what is available.

Owners set it under **Your monthly spend limit**: **Automatic**, **Fixed
at** an amount, **Everything available**, or, once, **Use my one-time
raise**, then **Save limit**. The section says how far you can go yourself,
and whether the one-time raise is still yours:

|                                            | Up to                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| Any amount                                 | The highest ceiling the workspace has had, plus what is prepaid |
| **The one-time raise**, once per workspace | Twice the highest ceiling                                       |
| Past that                                  | **Raise my limit**: a request to g1t                            |

To ask for more, use the **Raise my limit** section: give the limit you
need, what you expect to spend a month, and what it is for, then **Send the
request**. A person at g1t answers **within one business day**, in the app
and by email, and the section shows the request and its answer. An approved amount becomes a
floor under your ceiling, and your spend limit can go up to it.

### Budget alerts

The spend limit is the workspace's monthly **budget** on usage past what the
plan includes. Under **Budget alerts**, owners choose:

| Setting                 | Means                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Alert at**            | Any of 50, 75, 90 and 100% of the spend limit. Each is emailed to the owners once a month.                                                                                                                                                                                         |
| **Pause usage at 100%** | On (the default), new work stops at the limit: workflows, checks, the merge queue, builds and deploys, until the month turns or an owner raises it. Work already running finishes, so spend can go slightly past it. Off, the budget only alerts; g1t's own ceiling still applies. |
| **Webhook**             | An `https://` address of your own, sent a JSON `POST` at each alert: `event` (`budget.alert`), `workspace`, `level_percent`, `spent_micros`, `budget_micros`, `sent_at`.                                                                                                           |

Choose **Save alerts**. Through the API: `PUT /workspaces/:workspace/budget`,
or the MCP `billing` tool's `set_budget` action.

### Prepay

Paying in advance pays for usage as it happens, after the plan's included
usage, and raises what can be used before work stops by the same amount,
at once. It is never needed to start work. Only an owner can prepay.

1. Open **Workspace → Access → Billing and plans**, and find **Prepay**.
2. Choose **By card, with 3-D Secure** or **By bank transfer** (from
   $1,000).
3. Choose $100, $500 or $1,000, or type your own amount, from $25, and
   choose **Prepay**. By card, the most is $10,000.
4. Pay on the page you are sent to, confirming 3-D Secure if your bank
   asks. A bank transfer page gives the account details, and the amount
   counts when the money arrives.

There is no fee on top, by card or by bank transfer. [Tax](#tax) is added
where it applies. What you prepay is credited in full: the tax does not
come from it.

**Prepaid balance** shows what is paid in advance and not used yet.

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
such as _Credit from g1t: accidental usage on 2026-11-12_.

## Credits from g1t

g1t sometimes adds credit to a workspace: a welcome or referral credit, an
apology, or a refund for something that went wrong. The workspace's owners
get an email when it does, and **Billing** shows a **Credits from g1t**
card with each credit in a line, such as _$25.00 credit, $12.40 left,
expires Jan 5_.

| Kind        | What it is                                                     | Expires                                              |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| Promotional | A welcome, a referral or an event.                             | Sometimes: the date is on the card and in the email. |
| Goodwill    | An apology, or usage past what you meant forgiven.             | Sometimes, as above.                                 |
| Refund      | Money back for something that went wrong, with what it is for. | Never.                                               |

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
  unpaid from before. Prepaid money is taken off as _Paid in advance_.
- **When the workspace nears its ceiling** mid-month, the same, sooner.
- **When the workspace is deleted**, a final invoice for what it owes,
  charged at once with no minimum. See
  [deleting a workspace](/guides/workspaces/#what-billing-needs).

Each is charged to the card on file, with [tax](#tax) as a line of its
own and no card fee. On Stripe's payment page and on receipts, the plan is
named **g1t plan for _workspace_**, such as **g1t plan for acme**. Every invoice and receipt, with its PDF, is on
Stripe's billing page: choose **Manage billing** under **Billing on
Stripe**.

## Tax

Every price on g1t excludes tax. Stripe adds sales tax, VAT or GST where it
applies (Stripe Tax), worked out from the workspace's billing address, and
shows it as its own line before you pay and on every receipt and invoice.
The plan, add-ons, prepaying and invoices are all taxed the same way, as software as a service for business use.

- **The address.** Stripe's payment pages always ask for a billing
  address, and save it on the workspace's Stripe customer. A card check
  saves the card's billing address there too, if there is none yet. You
  change it on Stripe's billing page: see [Your card and billing
  details](#your-card-and-billing-details).
- **A business tax ID.** Add it on Stripe's payment page or on its billing
  page (the kind, such as EU VAT, and the number). Stripe checks it and
  applies it where the law says so, such as a reverse charge.
- **No address, no charge.** Where Stripe has nothing to work tax out
  from, g1t does not charge the card. Billing shows **Add your billing
  address in Stripe** with a **Manage billing** button, the owners are
  emailed once, and the charge goes through once the address is saved. Nothing is lost, and work is not stopped for it.
  In the United States the ZIP code is needed; elsewhere the country.
- **Tax exempt.** If your organisation is exempt, write to
  support@g1t.sh with the certificate; Billing then says **Tax exempt**.
- **Refunds** give the tax back in proportion.

Tax is never part of your balance or usage: the statement shows it as its
own line, beside the payment it came with.

## No card processing fee

g1t's prices include what Stripe charges to take a card. Nothing is added
on top of the plan, a prepayment or an invoice, however you pay. Payments
from before the fee was folded into prices may show **Card processing
fees** on the statement; those stay as they were.

### The minimum charge

If a month closes with less than **$1** owed, the card isn't charged. The
amount moves to the workspace's next invoice, as _Unpaid from earlier_.
Only the month's close has this minimum: a charge made because a workspace
nears [g1t's ceiling](#the-ceiling) always goes through, whatever the
amount, so work can carry on.

## Moving a repository between workspaces

When a repository is [transferred](/guides/transferring-repositories/#billing),
usage from that moment is charged to the workspace it moved to: workflow
jobs, builds, app traffic, git operations and storage. What it used before stays
on the old workspace's bill, and runs already under way finish on the bill
they started on.

## Your card and billing details

Your card, billing address, tax IDs, invoices and receipts live on
**Stripe's billing page**, not on g1t: g1t never sees or stores card
numbers. On **Workspace → Access → Billing and plans**, owners and billing managers
see **Billing on Stripe**:

- the default card (brand, last four digits and expiry), read-only; the
  plan charges it.
- **Manage billing**, which opens Stripe's billing page. There you add,
  remove or replace a card and make one the default; change the billing
  email, name, address and phone; add or remove tax IDs; see and download
  every invoice and receipt (the plan and month-end usage); and end the
  plan at the end of the period, or keep it after all. [Tax](#tax) is
  worked out from the address you keep there.

Invoices and receipts are emailed to the **Billing email** an owner sets
on the workspace's [Profile](/guides/workspaces/#the-workspaces-profile),
which g1t gives to Stripe; without one, they go to an owner's email. More
recipients are added from **Billing and plans**.

**Add-ons** lists what comes with the plan, such as
[Security and quality](/guides/security/pricing/), and whether it is on.

g1t support never takes card details by phone or email.

If a card is declined, work stops until the workspace pays, and the
Billing page and the API say why. Replace the card under **Manage billing**,
or prepay, to clear it.
A payment disputed with the card's bank stops work the same way.

Through the API, `GET /workspaces/:workspace/billing_details` and
`GET /workspaces/:workspace/invoices` (the MCP `billing` tool's
`billing_details` and `invoices` actions) read the same.

## When work is stopped

A workspace that cannot start compute starts nothing new. Starting a
workflow, a merge queue run or a deploy is refused with `402` and a
message saying why and what to do, with the page to do it on: start the
plan, check a card, raise the spend limit, answer a spike, or wait for the
next month's pool.

A workflow job is recorded as failed with "Not started:" and the reason.
Runs already under way finish, so usage can go slightly past a limit.

### When g1t pauses work for everyone

If usage across all of g1t climbs far past normal, g1t can pause some
kinds of work for every workspace while it looks into it. Each pause is
separate, and runs already under way finish:

| Paused    | What you see                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute   | New checks, workflow jobs and deploy builds are refused with `paused` and a message that g1t has paused them across the platform. Try again later. |
| Schedules | Workflows on `schedule:` skip the minutes while it lasts; they are not run late.                                                                   |
| Indexing  | New semantic search embeddings wait. Text search still answers, and search keeps up with new pushes.                                               |
| Renders   | A link to g1t shows g1t's logo instead of the page's own card.                                                                                     |

Nothing in your workspace changes, and nothing is charged while work
waits.

## Security on every plan

Every workspace, free or on the plan, has the [audit log](/guides/audit-log/),
with the same CSV and JSON export, and secret scanning, push protection,
vulnerability alerts and security updates. The rest of the security suite
(custom patterns, validity checks, delegated bypass, code scanning,
dependency review and the security overview) is free on public
repositories and, on private ones, comes with the plan as **Security and
quality**, with no price of its own: its scans are charged at cost plus
20%. See
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
  there is no card fee.
- **A discount**: a percentage off every usage charge, from a few percent
  to 100%, with a reason, sometimes until a date. Prices themselves stay
  the public ones. The statement shows every line at its price and the
  discount beside it: the totals read **Usage at price**, **Discount
  (30%)** and **Charged**, each day or repository has a **Discount** line, and
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

### Complimentary terms

g1t can enroll a workspace in **complimentary** terms, such as for a
design partner. A new workspace is never enrolled on its own: g1t staff
choose each one. An enrollment gives:

- **The plan's features**, without the plan's $21 a month.
- **A monthly usage allowance**, such as $100. Usage counts against it at
  its ordinary price, the same prices everyone pays: it is an amount of
  usage g1t pays for, not a discount. It starts again on the 1st of each
  month (UTC), and what is unused does not carry over.
- **A monthly fee of its own**, often none. When there is one, Stripe
  invoices it each month, apart from the allowance.

**Billing** has a **Complimentary allowance** card: the allowance a month
(or **Unlimited**), the monthly fee or **No monthly fee**, and **Used**,
**Metered, not billed yet**, **Remaining** and **Starts again**. Usage that is measured
at the end of the month, such as storage and git operations, and work
running now count against what is left.

What happens at the allowance is part of the terms, and **Billing** says
which:

- **New work that costs money stops** until the month turns: new runner
  jobs, builds, deployments and other compute, and storage and caches past
  the free amounts. Nothing is ever charged for usage past it, whether or
  not a card is saved. Work already running when the allowance runs out
  finishes, and g1t covers what it cost past the allowance.
- **Or usage past it is charged to your card**, such as when g1t covers a
  set amount of an employee's or a friend's usage. Past the allowance,
  usage is charged at the same prices as on the plan, up to your
  [spend limit](#limits) and the [ceiling](#the-ceiling), and invoiced
  when the month closes. Add a card first, with **Add a card** on the
  allowance card: without one, work stops at the allowance until you do.

If g1t changes the amount, what the month already used still counts:
raising it adds only the difference, and lowering it below what was used
leaves nothing more this month, never a bill.

An owner or billing manager can choose **Start the g1t plan instead** on
the allowance card. The plan uses the same Stripe customer and
subscription, and nothing changes until its first payment goes through:
if the card is declined, the bank asks to confirm the payment, or the page
is closed, the complimentary terms stay as they were. Usage the allowance
paid for before the plan started is never charged afterwards.

Each change is made by g1t staff and recorded with who made it and why. To
ask for one, write to [support@g1t.sh](mailto:support@g1t.sh).

## Earlier plans

Deployments used to be a $5 plan of its own. It is part of the g1t plan
now. A Deployments subscription bought before keeps working until its
current period ends, and is not renewed.

## The Usage page

A workspace's **Usage** page, `g1t.sh/<workspace>/-/settings/usage`, shows what it
used, by product, repository and day. Every member can see it, from **Usage**
under **Billing and plans** in the workspace's sidebar. A repository's own, `g1t.sh/<workspace>/<repository>/usage`,
shows the same for that repository.

Every amount is **usage at price**: what was charged, plus what included
usage, credit or a discount paid for it. It is the one figure Usage and
Billing both show, so they agree.

The filters, in one row:

| Filter       | Choices                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Period       | **Current billing cycle** (the calendar month, UTC), **Last billing cycle**, the last 7, 30 or 90 days, or a **Custom range** of up to 400 days. The days it covers are shown beside it. |
| Products     | Any of Sandboxes, Deployments, Git & storage, Packages, Security & quality and Search.                                                                                                   |
| Repositories | Any of the repositories with usage in the period.                                                                                                                                        |
| Group by     | Product, repository or day, for the breakdown.                                                                                                                                           |
| **⋯**        | **Export CSV** (a row per day, product and meter) and the usage API.                                                                                                                     |

Then:

- **Included usage, credit and this range**: the plan's included usage this
  month, credit from g1t left, and what the range came to:
  usage at price, then the discount (shown as _Discount (100%)_ for a
  workspace g1t covers in full), included usage and pools, credits applied,
  and what is charged.
- **Consumption**: a column per day, week or month (**Daily**, **Weekly**,
  **Monthly**), stacked by product, with **Cumulative** to add them up.
  Hover or focus a column for each product's part; **Show as a table** has
  every number.
- **The breakdown**: each product family with its meters (runner minutes
  for each machine;
  builds; git operations and private storage with what is free; and so
  on), each with a trend line, how much was used and its charge at price.
  Open a meter for its repositories.

Storage, git operations, scans and search embeddings are metered through
the month and charged when it closes; until then they are marked pending.
Through the API: `GET /workspaces/:workspace/usage`, or the MCP `billing`
tool's `usage` action.

## The statement

The **Billing** page ends with the workspace's statement, a month at a
time. Every member can see it.

- **Totals.** What the month charged, what was paid and credited, and how
  many entries make it up.
- **Grouped by day or by repository.** Each day (or repository) has one line
  per kind of charge, with how many entries it holds and what they come
  to:

  | Line                                              | What it holds                                                                                                                             |
  | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
  | Runner minutes, 2-core and Runner minutes, 1-core | Each job on g1t's machines, with the minutes charged on that machine (and Runner minutes, 4-core, for minutes from before it retired).    |
  | Sandbox time                                      | Each sandbox's time, in months before runner minutes.                                                                                     |
  | Self-hosted runner time                           | Each job on your own runners, at $0.                                                                                                      |
  | Deployments                                       | Builds as they finish; each month's requests, CPU time, custom domains and container time when it closes.                                 |
  | Private storage                                   | Storage past the free 1 GB, once a month.                                                                                                 |
  | Actions cache storage                             | What `actions/cache` and artifacts held, on the plan, once a month.                                                                       |
  | Git operations                                    | Operations past the free 50,000, once a month.                                                                                            |
  | Search embeddings                                 | Private text put in the search index, once a month.                                                                                       |
  | Security scans                                    | History scans and dependency checks, once a month.                                                                                        |
  | Payments                                          | Card payments and invoices paid.                                                                                                          |
  | Credits from g1t                                  | Credit g1t added (promotional, goodwill or a refund), and what of it expired or was withdrawn. See [Credits from g1t](#credits-from-g1t). |
  | Refunds                                           | Money given back to your card.                                                                                                            |
  | Tax                                               | Tax paid with that day's payments. Not a charge, and not from your balance.                                                               |
  | Card processing fees                              | Only on payments from before the card fee was folded into prices: the fee paid with them. Not a charge, and not from your balance.        |

  Payments are what reached your balance; the tax paid with them is the
  line below them, and the totals say what it came to.

- **Covered.** Below the totals, what paid for usage before it was
  charged, each with its amount:

  | Line                               | What paid                                         |
  | ---------------------------------- | ------------------------------------------------- |
  | Paid by your plan's included usage | The plan's $10 a month.                           |
  | Paid by your trial credit          | The one-time trial.                               |
  | Paid by g1t's open-source pool     | The pool, for public repositories.                |
  | Covered by g1t                     | A free workspace's last trial run past its trial. |

  Each entry says in its description how much of it was paid this way. A
  month that closed under the [minimum charge](#the-minimum-charge) says
  what carried over.

- **Open a line** to see its entries, 50 at a time, newest first.
- **Pick a month** to see an earlier one.
- **CSV** downloads every entry of the month, with the line it falls under
  and what covered it, for your own books. Invoices from Stripe remain the
  record for what was charged to your card.

## Provider cost reports

g1t counts what its own runs cost. Your team's other agents (CI scripts,
other tools, people's own sessions) are on your AI provider's bill too,
and the provider's own cost report is the record of all of it. Connect
the provider and g1t reads that report, day by day, at
`g1t.sh/<workspace>/-/settings/provider-costs` (**Workspace → Access → Billing and plans → Provider costs**).

**What it reads.** The provider's cost report for the whole organization
the key belongs to, in US dollars, one line per day and line item:

| Provider  | Report                                                                       | Line items                                                                                                          |
| --------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Anthropic | The Usage and Cost Admin API's cost report (`/v1/organizations/cost_report`) | Each description, such as _Claude Opus 5.5 Usage - Input Tokens_, for each of the organization's Console workspaces |
| OpenAI    | The Costs API (`/v1/organization/costs`)                                     | Each line item, for each of the organization's projects                                                             |

**Which key.** An admin key, which only an organization's admins can make:

- **Anthropic**: an Admin API key (it starts `sk-ant-admin`), made in the
  Claude Console under **Settings**, **Admin keys**. An ordinary API key
  or a workspace's key can't read the cost report. Individual accounts have
  no Admin API: set up an organization first.
- **OpenAI**: an admin key (it starts `sk-admin-`), made in the OpenAI
  platform under **Organization settings**, **Admin keys**. A project or
  user API key can't read the Costs API.

Only an owner of the workspace can connect a provider, one key per
provider. g1t checks the key with one small report request and says why
when it doesn't work (the wrong kind of key, no permission), then reads
the last 90 days.

**What g1t keeps.** The key, sealed when it is saved; it is never shown
again, never sent back to anyone and never written to a log. The page shows
its last four characters, who connected it and when, when it was last read
and what went wrong. And the costs: day, provider, line item, the provider's
own workspace or project, and the amount. g1t uses the key for nothing but
reading the report: never to run a model.

**How often.** Once a day, around 04:17 UTC. Each read asks for the last
seven days again, since providers revise recent days (and further back,
up to 90 days, after reads have failed), and replaces what it had for
those days. A provider that fails keeps its error on the page until a
read works; the others are read as usual. The day in progress is
incomplete at the provider too.

**Not added to g1t's own figures.** Runs g1t made on the workspace's own
key, such as Ask and sessions on [your AI providers](/guides/ai/), are on
the provider's report as well. The provider's figure already includes
them, so it is shown beside g1t's, never added to it.

**Disconnecting.** **Disconnect** on the page deletes the key and every cost
read with it. Replacing the key does the same and reads the last 90 days
again, since a new key may belong to another organization. To stop the key
working anywhere, also delete it at the provider.

Members can see which providers are connected and what they reported;
only owners connect, replace and disconnect them. Services read the figures
with the billing service's `provider_costs` RPC.

## For services: entitlements, reserve, settle

Every g1t service that starts something that costs money asks billing
first. These RPCs are internal; they are documented so the behavior above
can be traced.

| RPC            | Takes                                                   | Returns                                                                    |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `entitlements` | `workspace`                                             | What the workspace may do now (below).                                     |
| `reserve`      | `workspace`, `repo`, `public`, `kind`, `estimateMicros` | A reservation, or a refusal.                                               |
| `settle`       | `reservationId`, `actualMicros`                         | `true`, or `false` if it was settled or had lapsed before. Safe to repeat. |

**`entitlements`** returns, among others: `plan` (`free`, `paid`,
`internal` or `enterprise`), `compute` (may start compute at all),
`trialMicrosLeft`, `trialVerified` (a card check is done), `firstMonth`,
`ceilingMicros`, `exposureMicros`, `heldMicros`, `prepaidMicros`,
`includedMicros`, `includedUsedMicros`, `paused` (why compute is paused,
or none), `spike`, `alerts`, `gitOperations` and `gitOperationsIncluded`
(the git operations free for every workspace), `freePrivateStorageBytes`
(the private storage free for every workspace) and `buildSecondsUsed`.
None of these is a quota on the plan.

**`usage_meters`** (`workspace`, `viewer`; members only) returns this
month's usage in five lines, `builds`, `requests`, `domains`,
`git_storage` and `search_scans`, each with `micros` (at cost plus 20%,
before included usage or a pool paid for it) and a `quantity` such as
_42 build minutes_, each at price (what was charged plus what paid for it), as Usage measures it.

**`usage_report`** (`workspace`, `viewer`, `from`, `until`, optional `products` and `projects`; members only) is what the Usage page reads: totals (`priceMicros`, `discountMicros`, `includedMicros`, `creditsMicros`, `chargedMicros`, `pendingMicros`, `pendingChargedMicros`), each day's usage by product, and every product family with its meters, their daily figures and their repositories.

**`reserve`** holds the work's estimated cost before it starts, so starts
at the same moment cannot overshoot together. `kind` is `check`,
`workflow`, `queue`, `deploy` or `embedding`. `estimateMicros` is the most
the work is expected to cost g1t **in millionths of a dollar, before the
margin**; billing adds the margin.

A reservation has an `id`, `paidBy` (`credit` for included usage, `trial`,
`oss` or `on_demand`), `heldMicros` and `expiresAt`. A hold never settled
**lapses after 3 hours**. A refusal has one of these codes and a message
for the owner with the page to fix it on:

| Code             | Why                                                                         |
| ---------------- | --------------------------------------------------------------------------- |
| `not_paid`       | No plan, and nothing else pays for this kind of work, or no card check yet. |
| `trial_used`     | The one-time trial is spent.                                                |
| `limit`          | The spend limit or g1t's ceiling would be passed.                           |
| `paused`         | A spend spike is waiting for an owner, or g1t staff put a hold on compute.  |
| `oss_pool_empty` | The open-source pool, or the repository's share of it, is spent this month. |

**`settle`** releases the hold with what the work cost, at cost before the
margin. It never charges: the charge goes on the ledger the usual way when
the work reports its usage.
