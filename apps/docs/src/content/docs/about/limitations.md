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

### Imports up to 40 MB

Importing a repository copies it in one piece of at most 40 MB, after
compression.

- **Why.** The copy is held in memory while it moves, and a Worker has
  128 MB for everything it is doing at once.
- **Instead.** Clone the repository yourself and push it to g1t, in steps if
  it is over 100 MB. See [Import a repository](/guides/github/#what-comes-across).
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

### A fork's storage counts in full

A fork counts toward its workspace's private repository storage at its
whole size, even where it is the same as the repository it came from.

- **Why.** Cloudflare has not documented whether a fork shares stored
  objects with its source or copies them, so g1t never assumes a fork is
  cheaper than a copy.
- **Instead.** Fork with **Copy the default branch only** (the default)
  unless you need every branch and tag, and delete forks you no longer use.
- **Status.** Depends on Cloudflare. See
  [What a fork costs](/concepts/forks/#what-a-fork-costs).

### Pull requests' working copies are removed a day after they close

A day after a pull request merges or closes, its working copy's git data
is removed. The pull request's changes stay readable: its head is kept in the
repository as `refs/pull/<pull request id>/head`. Pushing to the working
copy, or reopening the pull request, makes it again from there.

- **Why.** Cloudflare has not documented whether a fork shares stored
  objects with its source or copies them, so working copies are not
  kept longer than they are useful.
- **Instead.** Nothing you need to do. To keep working on a closed pull
  request's change, fetch `refs/pull/<pull request id>/head` and push it
  to a branch.
- **Status.** Clear storage rules for copies depend on Cloudflare.

### Some dependency update options are not applied yet

g1t reads and checks every option of a `dependabot.yml` file, but does not
act on all of them yet:

- Version update pull requests are opened for npm, Cargo, Go and pip only.
  Entries for other ecosystems are checked and listed, and open nothing.
- A multi-ecosystem group opens one pull request per ecosystem, not one
  for the group.
- Registries that sign in with OIDC are not used.

**Instead.** Keep a separate entry per ecosystem and directory, and check
the Security page, which lists what each entry reads but does not act on.
See [Dependency updates](/guides/dependency-updates/#options).
**Status.** Planned.

### Very large changes are shown in parts

A pull request, commit or comparison lists at most 300 changed files. Of
those, lines are read for the first ones until about 20,000 lines; the
rest are listed without their counts and load one batch at a time as you
scroll to them. A single text file over 4 MB is not shown at all, nor is
one over 512 KB with more than 5,000 lines changed; one with a diff over
1,000 lines waits for **Load diff**.

- **Instead.** For a change of more than 300 files, compare the commits
  with git (`git diff --stat base...head`). From the API, ask for the files
  a large answer left out by `paths`.
  See [Files changed](/guides/pull-requests/#files-changed).
- **Status.** Not planned to change.

### No conflict resolution in the browser

You can't resolve a merge conflict on the pull request's page.

- **Instead.** Fix it on the command line.
  See [Conflicts](/guides/pull-requests/#conflicts).
- **Status.** Planned.

### Large merges, squashes and rebases

g1t merges, squashes, rebases and updates a pull request's branch by itself
up to 1,000 changed files, 100 files merged line by line (each up to 8 MiB,
with up to 10,000 lines added and removed on either side) and 250 commits in
a rebase. Beyond them it refuses, and nothing changes.

- **Instead.** Squash or merge instead of rebasing, or merge the base into
  the branch in a clone and push. See
  [Merge methods](/guides/pull-requests/#merge-methods).
- **Status.** Not scheduled.

## Actions and runners

### Docker shares the job's network

A job's Docker Engine runs its containers on the job's own network, not on
networks of their own. A service is reached at `localhost` and by its
name, as on GitHub, but two containers cannot listen on the same port, and
`docker network create` gives no separation between containers.

- **Why.** Jobs run in Cloudflare Containers, which let a container run
  Docker but not route a container network of its own out, or change its
  packet filter.
- **Instead.** Give containers that would clash different ports.
- **Status.** Not scheduled.

### No `type=gha` build cache

Buildx's GitHub Actions cache backend (`cache-to: type=gha`) is skipped on
g1t, and the build runs without a cache.

- **Why.** It talks to GitHub's cache service, which g1t's cache does not
  speak yet.
- **Instead.** Use a registry cache in g1t's container registry
  (`type=registry`), or `type=local` with `actions/cache`. See
  [caching image builds](/guides/actions/#caching-image-builds).
- **Status.** Planned.

### No multi-platform image builds on g1t's machines

Building an image for another platform, such as `linux/arm64`, needs QEMU's
emulators, which g1t's machines do not have set up.

- **Instead.** Build other platforms on a
  [self-hosted runner](/guides/self-hosted-runners/) of that architecture,
  or one with QEMU set up.
- **Status.** Planned.

### Linux only on g1t's machines

g1t's hosted runners are Linux only. A job with `runs-on: windows-latest`,
`macos-latest` or any other Windows or macOS label fails at once on g1t's
own machines, saying so, rather than running on Linux. Arm Ubuntu labels
(`ubuntu-24.04-arm`) run on x64.

- **Instead.** [Self-hosted runners](/guides/self-hosted-runners/) run Linux,
  macOS and Windows, on x64 and arm64.
- **Status.** Not scheduled.

### No background steps

GitHub's background steps (`background: true` on a step, and `wait`,
`wait-all`, `cancel` and `parallel` steps) are refused: a workflow with one
does not run on g1t. A schedule's `timezone`, `concurrency.queue`,
`cancel-timeout-minutes` and `snapshot` are read but not applied: schedules
run in UTC, a concurrency group keeps one run waiting, a cancelled job stops
in its usual time, and no runner image is made from a job. The workflow's
page says so.

- **Why.** They are newer than g1t's runner, which runs a job's steps one
  after another.
- **Instead.** Start a long-running process with `&` in a `run:` step and
  stop it in a later one; write a schedule's `cron` in UTC.
- **Status.** Not scheduled.

### Self-hosted macOS jobs run on the host

On a self-hosted runner, a job native to macOS runs directly on the Mac,
unsandboxed, in host mode, which is deprecated. Linux jobs run in a
sandbox of their own on every computer, and Windows jobs in a Windows
Sandbox per job on Windows 11 Pro, Enterprise and Education. Windows 11
Home has no Windows Sandbox, so it runs Linux jobs only.

- **Why.** Sandboxed macOS jobs are designed, not built: an ephemeral
  macOS virtual machine per job, at most two per Mac by Apple's licence.
- **Instead.** Run Linux jobs in
  [the sandbox on your computer](/guides/self-hosted-runners/#sandbox-on-your-computer),
  and keep host-mode Mac runners for repositories whose code you trust.
  Host mode refuses public repositories' work.
- **Status.** Planned. See
  [how each computer runs it](/guides/self-hosted-runners/#how-each-computer-runs-it).

### The runner's sandbox is checked end to end on Windows only

The sandbox for Linux jobs on macOS (a VM under Apple's Virtualization
framework) and on Linux without Sysbox (a VM under QEMU with KVM) is
built to the same design as on Windows, but has not yet been run on a
Mac or on such a Linux machine.

- **Instead.** Run `g1t-runner sandbox status` first: it says what the
  computer lacks. On Linux, the runner's container under Sysbox needs no
  VM. See [what it cannot stop](/guides/self-hosted-runners/#what-it-cannot-stop).
- **Status.** Planned.

### A self-hosted job's Docker can reach its runner's container

On a runner in its container under Sysbox, a job that uses Docker gets an
engine of its own that is privileged inside the runner's container. It
cannot reach the machine, but it can reach the runner's container,
including the runner's credential.

- **Instead.** Use ephemeral runners for code you do not trust, or
  register with `--no-job-docker`.
- **Status.** Not scheduled.

### `actions/checkout` with Git LFS, or without git on a large repository

`actions/checkout` is the action itself. With `lfs: true`, it finds no
LFS files: g1t keeps none. In a job container whose image has no git, it
downloads the commit as a tarball from
`GET /repos/{owner}/{repo}/tarball/{ref}`, as on GitHub. g1t makes that
tarball when it is asked, of up to 10,000 files and 24 MB, so the
checkout of a larger repository fails there.

- **Why.** The tarball is made in a Worker, which holds the files and the
  archive in memory at once.
- **Instead.** Keep large files out of Git LFS for now. For a large
  repository, use an image with git, or install git in a step before the
  checkout.
- **Status.** Planned.

### No `gh` command in jobs

The runner does not include the `gh` command, and pointing it at g1t
(`GH_HOST=g1t.sh`) does not work.

- **Why.** Most of `gh`'s commands use a GraphQL API, and the rest expect
  the REST API under `/api/v3` on the same host. g1t's API is REST, at
  `api.g1t.sh`.
- **Instead.** Call the API with `curl` and the job's token. See
  [calling g1t's API from a job](/guides/actions/#calling-g1ts-api-from-a-job).
- **Status.** Not scheduled.

### One Ruby for `ruby/setup-ruby`

On g1t's machines, `ruby/setup-ruby` finds Ruby 3.3, which the runner
includes, and fails for any other version.

- **Why.** Its prebuilt Rubies are for other Linux systems, so on Debian it
  uses only the Rubies already in `RUNNER_TOOL_CACHE`.
- **Instead.** Use 3.3, run the job in a `container:` with the Ruby you
  need (such as `ruby:3.4`), or build it in a step with `ruby-build`. See
  [languages and their setup actions](/guides/actions/#languages-and-their-setup-actions).
- **Status.** Not scheduled.

### Machine sizes, time and storage

| Limit                     | Value                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Largest machine           | 4 vCPUs, 12 GiB of memory, 20 GB of disk (`ubuntu-latest` in a public repository). No GPUs. GitHub's machine for public repositories has 16 GB of memory. |
| Standard machine          | 2 vCPUs, 8 GiB of memory, 16 GB of disk (`ubuntu-latest` in a private repository, and any label g1t does not know).                                       |
| Smallest machine          | 1 vCPU, 6 GiB of memory, 12 GB of disk (`ubuntu-slim`).                                                                                                   |
| Larger runners            | Not offered yet: GitHub's larger runners (more vCPUs, GPUs, named by the organization) have no g1t equivalent. Use a self-hosted runner.                  |
| One job on g1t's machines | 60 minutes. On a self-hosted runner, 24 hours.                                                                                                            |
| One cache entry           | 2 GiB, compressed. A larger one is not saved.                                                                                                             |
| A repository's caches     | 10 GiB together, 100 GiB on the g1t plan. Past it, the entries restored longest ago are removed.                                                          |
| One artifact              | 5 GiB, zipped. Kept 14 days unless the repository says otherwise, at most 90.                                                                             |
| A run's artifacts         | 10 GiB together.                                                                                                                                          |

The machine sizes are Cloudflare Containers' instance sizes. For more, use a
[self-hosted runner](/guides/self-hosted-runners/). See
[Machine sizes](/guides/actions/#machine-sizes) and [the cache](/guides/actions/#the-cache).

### Workflow features not supported yet

- Actions that upload or download artifacts with the toolkit's artifact
  library themselves. The library refuses to run against any server but
  github.com. `actions/upload-artifact`, `actions/download-artifact` and
  `actions/upload-artifact/merge` work, as g1t runs them itself.
- A cache entry between 100 and 128 MB saved by `actions/cache` or another
  action built on the toolkit, such as `setup-node` with `cache: npm`. The toolkit sends an
  entry under 128 MB in one request, and g1t takes at most 100 MB in one
  request, as for [pushes](#pushes-up-to-100-mb-each). The step warns and
  the job goes on; smaller and larger entries are saved.
- `on: label`: creating, editing or deleting a label starts no workflows.
  Putting a label on a work item or a pull request starts `work_item` and
  `pull_request` workflows with the `labeled` type.
- The `pull_request` activity types `unassigned`, `locked`, `unlocked`,
  and `edited` for a new title or description, and the `work_item` types
  `unassigned`, `locked`, `unlocked`, `pinned` and `unpinned`: g1t starts
  no workflows for them.

See [Not yet](/guides/actions/#not-yet). **Status.** Planned.

### No npm trusted publishing or provenance

A workflow on g1t can't publish to npm with trusted publishing, or with
`--provenance`.

- **Why.** Both trade the job's OIDC token with npm and Sigstore, which
  accept tokens only from the CI services they list. g1t's
  [OIDC tokens](/guides/actions/#oidc-tokens) work with any cloud that
  lets you add an issuer, and npm does not.
- **Instead.** Publish with a granular access token in a secret
  (`NODE_AUTH_TOKEN`); see [npm](/guides/actions/#npm).
- **Status.** Depends on npm.

## Deployments

### A container is one instance, and keeps nothing

A container app runs one instance at a time, sleeps after five minutes
without a request, and starts from its image each time it wakes.

- **Why.** Each app's container is one Durable Object's, and Cloudflare
  Containers' disks last only as long as the container runs.
- **Instead.** Keep data in a database or a bucket the app reaches over
  the network. A larger **Container size** gives one instance more room.

### What a container sends out is not counted

The data a container sends back to visitors is metered; what it sends to
other hosts on the internet (a database elsewhere, an API) is not.

- **Why.** It leaves the container without passing through g1t.
- **Instead.** Nothing to do: it is not charged.
- **Status.** A runtime for servers is planned.

### Some Workers bindings are not provisioned

A Workers project deploys without D1, KV, R2, Durable Objects, Queues,
service bindings, Vectorize, Hyperdrive, Workers AI or Workflows, and its
cron triggers are not scheduled.

- **Why.** Each of these is a resource g1t has to create and bill per
  app, and that is not built yet.
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

Cloudflare Artifacts, where every repository is stored, started billing in
mid-October 2026. Its [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
counts repository operations such as create, push, pull and clone, and
storage measured from daily peaks. g1t's own counts are still being
reconciled against that bill.

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

### Payments in test mode

A g1t whose payments use Stripe's test mode, such as a self-hosted one set
up with test keys, charges no real card, so a card check there proves
nothing. g1t.sh takes live payments: the card check and every charge are
real. **Status.** By design
for test setups.

## Accounts, status and self-hosting

### Tokens for one workspace you belong to

A personal access token can be made for one workspace only when you are a
member of it. For a repository where you are an outside collaborator, make
a token for all your workspaces. A workspace's
[rules for tokens](/guides/authentication/#a-workspaces-rules-for-tokens)
cover personal access tokens only, not applications you signed in to with
OAuth. **Status.** Planned.

### No uptime commitment during the alpha

g1t does not promise a particular uptime or offer a service level agreement
unless you have a written agreement with us. Several of the Cloudflare
products g1t is built on are in beta and have none either.
[status.g1t.sh](https://status.g1t.sh/) shows how each part of g1t is doing,
and every incident. Sandboxes are not checked there yet. See
[Status and incidents](/guides/status/). **Status.** Not scheduled during
the alpha.

### Self-hosting is early

[Running g1t yourself](/guides/self-hosting/) gives you the core forge:
accounts, repositories over HTTP, work items and pull requests, the REST API
and MCP, container images, search, webhooks and observability. Hosted
runners, deployments, billing and git over SSH are off. The merge queue
can accept pull requests, but cannot test or land them without g1t's
runner. Use the hosted service to try that integration loop. Self-hosting
is not ready for the open internet. **Status.** Planned, in phases.

### No wikis

A repository has no wiki. **Instead.** Keep docs in the repository, or
write them together in [Artifacts](/guides/artifacts/). **Status.** Not
scheduled.
