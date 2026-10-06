---
title: What g1t can't do yet
description: The limits you can hit on g1t today, why each one exists, what to do instead, and whether it is planned.
---

This page lists what g1t cannot do today. Each entry says what you can't
do, why, what to do instead, and where it stands.

Where it stands is one of:

- **Planned**: we intend to build it. We don't give dates we can't keep.
- **Depends on Cloudflare**: g1t runs on Cloudflare, and this needs
  something the platform does not offer yet.
- **Not scheduled**: no work is planned on it now.

Several of these depend on Cloudflare; [we wrote to them about it](/about/open-letter-to-cloudflare/).

If you hit a limit that is not here, tell us at
[g1t.sh/support](https://g1t.sh/support), and we will add it.

## Git

### No git over SSH

You can reach repositories only over HTTPS. A `git@g1t.sh:…` remote does
not work.

- **Why.** SSH needs inbound TCP connections on port 22. g1t runs on
  Cloudflare Workers, which accept HTTP, not raw TCP. Cloudflare has a beta
  for inbound TCP; we have applied and are waiting.
- **Instead.** Use the HTTPS remote with an
  [access token](/guides/git/#authentication). It does everything SSH would:
  clone, fetch and push. SSH keys you add under **Settings → SSH keys** are
  kept for when SSH arrives.
- **Status.** Depends on Cloudflare. See [Git](/guides/git/#ssh).

### Repositories up to 1 GB, files up to 32 MB, no LFS

A repository can hold up to 1 GB and a single file up to 32 MB. Git LFS is
not supported. A push that would cross either is declined before it is
stored, and git prints why. See [Size limits](/guides/git/#size-limits).

- **Why.** These are the limits of Cloudflare Artifacts, where every
  repository is stored.
- **Instead.** Keep large binaries out of the repository: in a release
  bucket, a package registry or object storage, fetched at build time.
- **Status.** Large file storage is planned. Raising the limits themselves
  depends on Cloudflare.

### Pushes up to 100 MB each

A single push can carry up to 100 MB. A larger one is refused with HTTP
`413` before g1t sees it.

- **Why.** Cloudflare's network limits the size of one request body on the
  plan g1t.sh is on.
- **Instead.** Push history in steps, oldest first:
  `git push origin <older-commit>:refs/heads/main`, then a newer one, then
  `main`. Each push sends only what the last did not.
- **Status.** Depends on Cloudflare.

### Imports and mirrors up to 40 MB

Importing or mirroring a repository copies it in one piece of at most
40 MB, after compression.

- **Why.** The copy is held in memory while it moves, and a Worker has
  128 MB for everything it is doing at once.
- **Instead.** Clone the repository yourself and push it to g1t, in steps if
  it is over 100 MB. See [Import, mirror or move a repository](/guides/github/#what-comes-across).
- **Status.** Streaming the copy, so size stops mattering, is planned.

### Partial clone works, but is not promised

`git clone --filter=blob:none` returns a real partial clone today. We don't
promise it will keep doing so.

- **Why.** Cloudflare's documentation says filters are not supported, but
  they work with git's protocol version 2. We have asked whether that is
  intended.
- **Instead.** Use it, and fall back to `--depth=1` for a shallow clone,
  which is supported.
- **Status.** Depends on Cloudflare.

### No server-side hooks of your own

You can't run a script of your own on g1t when a push arrives, before or
after its refs move.

- **Why.** The git store has no hook for this. g1t's own checks run in front
  of it, in g1t's code: [protected branches](/guides/git/#protected-branches)
  and [push protection](/guides/security/#push-protection).
- **Instead.** Protect the default branch and make your workflows
  [required checks](/guides/pull-requests/#required-status-checks). To react
  after a push, use a [webhook](/guides/webhooks/) or a workflow on `push`.
- **Status.** Not scheduled for your own scripts. A hook in the store,
  which would let g1t enforce more before refs move, depends on Cloudflare.

### Very large pushes are scanned after they land, not before

A very large push is too large for push protection to read before it is
stored, so it is let through, and g1t scans every commit it added
afterwards, in the background. A secret found that way is an open alert
rather than a refused push, and the workspace's owners are emailed when one
looks real. Most pushes are scanned before they land.

- **Why.** Scanning reads the whole push inside a Worker, which has 128 MB
  for everything it is doing at once. Past a certain size, scanning could fail
  the push outright, and refusing such pushes would block importing real
  repositories.
- **Instead.** To have a large history checked before it lands, push it in
  steps (see above), so each push is scanned first. Secrets already in
  history are listed under
  [Secrets in history](/guides/security/#secrets-in-history).
- **Status.** Planned: scanning while the push streams, at any size.

### Deleting history does not free storage

Storage is counted from what is pushed, and the count only grows. Deleting
a branch, or force-pushing over commits, does not lower it.

- **Why.** The git store does not say whether or when it reclaims space
  from objects nothing points to any more, or report how much a repository
  holds. So g1t cannot see it either.
- **Instead.** Keep large mistakes out with a `.gitignore`. If one landed in
  a private repository and counts against you, tell us at
  [g1t.sh/support](https://g1t.sh/support).
- **Status.** Depends on Cloudflare. See
  [private repository storage](/guides/usage-and-billing/#private-repository-storage).

## Pull requests and forks

### Forks are only for pull requests

You can't fork a repository into your own workspace. On g1t, a fork is a
pull request's own working copy, made when the pull request is opened.

- **Why.** We built forks to isolate agents' work, one per pull request.
  See [Forks and branches](/concepts/forks/).
- **Instead.** To contribute, open a pull request: it gets its own fork. To
  start a copy of your own, clone the repository and push it to a new one
  in your workspace; pushing creates it.
- **Status.** Not scheduled.

### Pull request forks are removed a week after they close

Seven days after a pull request merges or closes, its fork's git data is
removed. The pull request's changes stay readable: its head is kept in the
repository as `refs/pull/<pull request id>/head`. Pushing to the fork, or
reopening the pull request, makes the fork again from there.

- **Why.** Cloudflare has not documented whether a fork shares stored
  objects with its source or copies them, so forks are not kept longer
  than they are useful.
- **Instead.** Nothing you need to do. To keep working on a closed pull
  request's change, fetch `refs/pull/<pull request id>/head` and push it
  to a branch.
- **Status.** Clear fork storage rules depend on Cloudflare.

### No conflict resolution in the browser

You can't resolve a merge conflict on the pull request's page.

- **Instead.** Ask a g1t agent to resolve it, or fix it on the command line.
  See [Conflicts](/guides/pull-requests/#conflicts).
- **Status.** Planned.

## Actions and runners

### No Docker in g1t's sandboxes

On g1t's own machines, a job's `container:` image is not used (its steps
run on g1t's runner image instead), and a step cannot run `docker build`.
Docker container actions (`uses: docker://…`, or an action that runs as a
Docker image) and `services:` containers, such as a database, do not run
on any runner yet, self-hosted ones included.

- **Why.** Jobs run in Cloudflare Containers, which offer no supported way
  to run Docker or another image builder inside a container.
- **Instead.** Run `container:` jobs and image builds on a
  [self-hosted runner](/guides/self-hosted-runners/). A runner in Docker
  mode runs each job in its `container:` image. To build images, register a
  runner with `--no-docker` on a machine that has Docker, and its steps can
  call `docker build` and `docker push`. Self-hosted time costs nothing. For
  a database, start it from a `run:` step on a self-hosted runner.
- **Status.** Docker container actions and `services:` are planned. Image
  builds on g1t's machines depend on Cloudflare.

### Linux only on g1t's machines

A job with `runs-on: windows-latest` or `macos-latest` fails on g1t's own
machines.

- **Instead.** [Self-hosted runners](/guides/self-hosted-runners/) run Linux,
  macOS and Windows, on x64 and arm64.
- **Status.** Not scheduled.

### Machine sizes, time and storage

| Limit | Value |
| --- | --- |
| Largest machine | 4 vCPUs, 12 GiB of memory, 20 GB of disk (`g1t-4core`). No GPUs. |
| One job on g1t's machines | 60 minutes. On a self-hosted runner, 24 hours. |
| One cache entry | 2 GiB, compressed. A larger one is not saved. |
| A repository's caches | 10 GiB together. Past it, the entries restored longest ago are removed. |
| One artifact | 60 MB, kept for 14 days |

The machine sizes are Cloudflare Containers' instance sizes. For more, use a
[self-hosted runner](/guides/self-hosted-runners/). See
[Machine sizes](/guides/actions/#machine-sizes) and [the cache](/guides/actions/#the-cache).

### Workflow features not supported yet

- Reusable workflows from another repository. Ones in the same repository
  work.
- Actions that cache through the hosted toolkit's own cache service, such as
  `setup-node` with `cache: npm`. They run without it; use `actions/cache`.
- Environments' protection rules: required reviewers, wait timers and branch
  limits. A job with `environment:` gets that environment's values and runs
  without waiting.

See [Not yet](/guides/actions/#not-yet). **Status.** Planned.

## Deployments

### Static sites and Workers only

Deployments run static sites and Workers projects. You can't deploy a
long-running server, a container, or an app that needs a process that stays
up.

- **Why.** Apps run on Cloudflare Workers, which run only while they answer a
  request. That is why an app nobody visits costs nothing.
- **Instead.** Deploy the server from a workflow to wherever it runs today,
  with its credentials in [secrets](/guides/secrets-and-variables/).
- **Status.** A runtime for servers is planned.

### Some Workers bindings are not provisioned

A Workers project deploys without D1, KV, R2, Durable Objects, Queues,
service bindings, Vectorize, Hyperdrive, Workers AI or Workflows, and its
cron triggers are not scheduled.

- **Why.** Each of these is a resource g1t has to create and bill per
  project, and that is not built yet.
- **Instead.** Check that a binding exists before using it. The deployment
  lists each binding it left out, and warns when its cron triggers will
  not run.
- **Status.** Planned. See [Workers projects](/guides/deployments/#workers-projects).

### Build and size limits

A build stops after 45 minutes. A static site can have up to 20,000 files
and 25 MiB per file, which are Cloudflare's limits. See
[Static sites](/guides/deployments/#static-sites).

## Data residency

You can't choose where a workspace's data is stored. g1t's databases keep
their primary copy in the United States, with read copies in other regions
so pages load fast. Repositories are not pinned to a region.

- **Why.** Cloudflare fixes the region of a repository store when it is
  created, and g1t has one store so far.
- **Instead.** None today, if your data must stay in the EU.
- **Status.** EU residency, with an EU-only repository store and databases,
  is planned.

## Billing

### Some costs are not fully defined yet

Cloudflare starts billing for Artifacts, where repositories are stored, on
October 14, 2026, and has not yet said exactly which calls count as a
billable operation.

- **What g1t does.** It counts every clone, fetch and push through its git
  endpoints. Each day it checks what Cloudflare billed it for containers and
  apps against what was used. When a cost moves,
  g1t's price moves with it, and every change is listed with its reason on
  [g1t.sh/pricing](https://g1t.sh/pricing).
- **What this means for you.** Prices can change while Cloudflare's beta
  products settle. They follow cost.
  See [How prices are set](/guides/usage-and-billing/#how-prices-are-set)
  and [git operations](/guides/usage-and-billing/#git-operations).
- **Status.** Depends on Cloudflare.

### Payments are in test mode

While payments are in test mode, no real card is charged, so a card check
proves nothing. g1t's hosted models are open only to a few invited
workspaces, g1t's own among them. Every other workspace, trial or not,
runs its agents on its own model provider; without one, assigning an agent
is refused with a message that says so.

- **Instead.** Connect your own [model provider](/guides/models/). Your
  agents then run on your keys, and the provider bills you directly.
- **Status.** Planned: hosted models for every workspace once payments go
  live.

## Agents

### Confidence is a judgement, not a guarantee

The confidence g1t gives an agent's change, high, medium or low, is
worked out from what g1t can observe: checks, reviews, revisions, the size
and reach of the change. It cannot tell whether the change is correct.

- **Instead.** Keep **Ask a person before merging low-confidence changes**
  on, and make your workflows required checks. A high rating on a
  repository with weak tests means less. See
  [How sure the agent is](/guides/g1t-agents/#how-sure-the-agent-is).
- **Status.** The signals and their weights may change as we learn from
  real changes.

### Agents' model calls go through g1t

An agent's model requests always pass through g1t's model proxy,
`models.g1t.sh`, with your keys or g1t's. You can't point an agent's sandbox
straight at a provider.

- **Why.** So that no key is ever inside a sandbox, and so budgets, caps and
  the audit log hold. See [Your keys never reach a sandbox](/guides/models/#your-keys-never-reach-a-sandbox).
- **Status.** Not planned. This is by design.

## Accounts, status and self-hosting

### Sign-up needs an invite

g1t is invite-only for now. See [Invites](/guides/authentication/#invites).
**Status.** Opening sign-up is planned.

### No uptime commitment during the beta

g1t does not promise a particular uptime or offer a service level agreement
unless you have a written agreement with us. Several of the Cloudflare
products g1t is built on are in beta and have none either.
[status.g1t.sh](https://status.g1t.sh/) shows how each part of g1t is doing,
and every incident. Sandboxes are not checked there yet. See
[Status and incidents](/guides/status/). **Status.** Not scheduled during
the beta.

### Self-hosting is early

[Running g1t yourself](/guides/self-hosting/) gives you the core forge:
accounts, repositories over HTTP, issues and pull requests. g1t agents,
Actions, deployments, git over SSH, the REST API and MCP are off, and it is
not ready for the open internet. **Status.** Planned, in phases.

### Not built yet

- **Milestones.** Planned.
- **Releases and package registries.** Planned.
- **Wikis.** Not scheduled. Keep docs in the repository.
