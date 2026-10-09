# Building a git platform on Cloudflare: a field report

Status: feedback document, 2026-10-06. For Cloudflare's Artifacts, Workers, D1 and Containers teams,
and for the organisers of "Build the Next-Gen Git Platform on Cloudflare".

g1t (g1t.sh) is a git hosting platform where people and coding agents work in the same issues, pull
requests and merge queue. It runs entirely on Cloudflare: about twenty Workers (Rust compiled to
WebAssembly, plus TypeScript), one D1 database per service, Artifacts for every repository and pull
request fork, Containers for agent sandboxes and CI, KV, R2, Queues and Cloudflare for SaaS for custom
domains. The source lives on g1t itself at [g1t.sh/flagon-io/g1t](https://g1t.sh/flagon-io/g1t); code
pointers below are paths in that repository.

We went from an empty repository to an invite-only launch on this stack, and most of it worked the
first time. This report is about where it did not, written so that each point can become a ticket:
what we tried to do, what we hit (with numbers, dates and doc quotes), what we built around it and what
that costs us, and what we would ask for. The full Artifacts due diligence, with every citation and the
capacity model, is in [ARTIFACTS.md](ARTIFACTS.md). Latency work is in [PERFORMANCE.md](PERFORMANCE.md);
deploys in [DEPLOYING.md](DEPLOYING.md).

Severity:

- **Blocking**: we cannot price, launch or scale a feature safely until it is answered or changed.
- **Costly**: we ship, but only with a workaround that costs us engineering time, latency or money on
  every request.
- **Friction**: a sharp edge that cost hours once, or a doc that disagrees with behaviour.

All quotes are from developers.cloudflare.com, retrieved 2026-10-06, unless stated.

## Executive summary: the five asks

1. **Define a billable Artifacts operation, and meter exactly that.** Pricing says "repo operations,
   such as `create`, `push`, `pull`, and `clone`"; metrics count `create`, `fork`, `push`, `pull`,
   `delete`. Depending on whether binding reads, token mints and ref advertisements count, our cost at
   3,000 workspaces is about $1,800 or about $31,000 a month. Billing starts 2026-10-14. (A1)
2. **Document what a fork stores, and give forks a lifecycle.** Forks are the obvious per-pull-request
   primitive, but nothing says whether they copy or share objects. If they copy, an agent-heavy
   workload reaches the 1 TB account limit in about two days and every push in the account fails. Ask:
   documented semantics, per-repository storage in the binding, fork expiry, and a warning before the
   account cliff. (A2)
3. **A write path and a policy hook in the binding.** List refs, compare-and-swap ref updates
   (atomic across refs), object and pack writes, and a pre-receive hook a Worker can answer. Today we
   speak smart HTTP to our own storage, buffer packs in 128 MB isolates, and parse every push in the
   Worker before forwarding it. (A3, A5)
4. **Account-level ref-change events and cheaper git credentials.** One subscription per repository
   does not scale to tens of thousands of repositories, so we version refs ourselves and guard it with a
   test that scans our source. Every git access costs three binding calls and about 0.8 s to mint a
   token. (A4, A6)
5. **Placement that follows the data.** Smart Placement ran our site in Amsterdam for a visitor in
   Denver while every D1 primary is in WNAM. Explore took 0.85 s that way and 0.17 s with placement off. Ask: placement that
   understands D1 primaries and service-binding chains, D1 regions as placement hints, and D1 Sessions
   that work across service bindings. (W1, W2, D1)

## Artifacts

Artifacts is the reason g1t exists in this form. One Durable Object per repository, smart HTTP that
stock git understands, forks, scoped tokens and a binding that reads commits, trees and blobs is the
right shape for a git platform. Everything below is about taking it from "it works" to "we can bill
for it and sleep at night at a few thousand workspaces".

### A1. What is a billable operation? (blocking)

- **What we tried.** Price g1t from cost: pass Artifacts through to each workspace with a modest
  uniform overhead, so a workspace's bill tracks what it really costs us.
- **What we hit.** [Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) defines
  operations only as "the number of repo operations, such as `create`, `push`, `pull`, and `clone`",
  $0.15 per 1,000 after 10,000 a month. [Metrics](https://developers.cloudflare.com/artifacts/observability/metrics/)
  (`artifactsEventsAdaptiveGroups`) list `eventType` values `create`, `fork`, `push`, `pull`, `delete`:
  a different list, with no `clone`. Neither says whether binding calls (`get`, `info`, `createToken`,
  `log`, `readTree`, `readBlob`, `readCommit`, `readFile`), `info/refs`, or protocol v2 `ls-refs` count.
- **What it means.** Our capacity model (ARTIFACTS.md section 5) at 3,000 workspaces gives about
  12 million operations a month if only git data transfers count (about $1,800), and about 207 million
  if every call counts (about $31,000). A 15x spread, with billing starting 2026-10-14.
- **What we built.** `services/repos/src/git_ops.rs` counts every upload-pack and receive-pack POST per
  workspace, including `ls-refs` answers served from our own cache that never reach Artifacts. It is a
  guess. We also had to size the free tier (`GIT_OPERATIONS_FREE_CAP`, 50,000 a month) against a
  number we cannot see.
- **Ask.** A table: each binding method and each git endpoint, billable or not, and how many operations
  it is. Metrics with the same event names as the invoice, per repository, so a platform can attribute
  cost to its own customers. A usage endpoint for the current billing period.

### A2. Fork storage, fork lifecycle, and the 1 TB cliff (blocking)

- **What we tried.** One fork per pull request (`pulls--<id>` in `services/repos/src/store.rs`), so an
  agent's work is isolated until it lands. Forks are the most natural primitive Artifacts offers for
  this, and agents open pull requests by the thousand.
- **What we hit.** The docs do not say whether `fork` copies objects or shares them with its source.
  The fork response returns `objects: N`, which reads like a copy count. Pricing says "Repos remain
  stored until you explicitly delete them", and [limits](https://developers.cloudflare.com/artifacts/platform/limits/)
  put account storage at 1 TB ("can be raised on request"). There is no repository size in the binding,
  no fork expiry and no guidance on fork lifecycle.
- **What it means.** At 15,000 agent pull requests a day on 25 MB repositories: if forks share objects,
  storage grows by about 270 GB a month; if they copy, by about 13.5 TB a month, and the account limit
  is reached in about two days. At that point every push in the account fails with
  `storageLimitReached`, for every customer at once.
- **What we built.** Nothing yet that we trust. We must add a sweep that deletes forks after a pull
  request merges or closes plus a grace period (`lifecycle.rs`), and measure semantics ourselves with a
  100 MB test repository and the storage metric.
- **Ask.** Document fork storage (copy, copy-on-write, or shared packs, and how it is billed). Report a
  repository's stored bytes in `info()`. Allow an expiry on `fork()` (or on any repository). Warn by
  event or email at 80% and 95% of the account limit, and fail per repository rather than account-wide.

### A3. The binding cannot write (costly)

- **What we tried.** Land pull requests, catch branches up, mirror external repositories, commit a
  file from the web, delete and rename branches: all server-side operations a platform does without a
  git client.
- **What we hit.** The [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
  reads (`log`, `readCommit`, `readTree`, `readBlob`, `readFile`) but cannot list refs, update refs,
  write objects or packs, or update several refs atomically. The
  [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/) still
  says the binding "cannot read or write files inside them", which is half out of date.
- **What we built.** A smart HTTP client inside the Worker. `services/repos/src/land.rs` asks the fork
  for a pack (`fetch_pack`), strips the side-band (`unpack_sideband`), and pushes it to the target
  (`push_pack`, `fast_forward`, `delete_ref`), each a hand-built receive-pack command with pkt-lines.
  Branch listing parses `info/refs` (`refs.rs`). Mirrors and imports do the same (`mirror.rs`,
  `import.rs`), capped at 40 MB a pack (`MAX_PACK_BYTES`) because everything is buffered.
- **What it costs.** Every landing is two token mints (six binding calls), an upload-pack and a
  receive-pack. Each pack is held in memory two or three times in an isolate with 128 MB shared by
  concurrent requests, so a large pull request can fail to land, and can take other requests in the
  same isolate with it. Ref updates are one ref per request; there is no documented `atomic` support.
- **Ask.** `repo.refs()` (with peeled tags), `repo.updateRefs([{ name, old, new }], { atomic: true })`,
  `repo.copyObjects(from, wants, haves)` or `repo.writePack(stream)` that stream rather than buffer,
  and confirmation that receive-pack `atomic` is supported.

### A4. Three calls and 0.8 s for every credential (costly)

- **What we tried.** Proxy git over HTTPS: authenticate the person or agent ourselves, then forward to
  the repository's Artifacts remote with a short-lived token.
- **What we hit.** Each credential needs `namespace.get()` (a lookup that throws `NOT_FOUND` or
  `*_IN_PROGRESS`), then `info()` for the remote URL ("Each call performs a fresh lookup") and
  `createToken`. Measured from Denver on 2026-10-06: 807 to 856 ms per mint, most of a cold `info/refs`
  that took 1.3 to 1.4 s end to end.
- **What we built.** Two credential caches in `services/repos/src/store.rs`: per isolate (`Credentials`)
  and shared across isolates through KV, sealed with AES-256-GCM (`shared.rs`). Tokens live 300 s and
  are reused for 180 s. That bounds staleness and leak exposure but still means about 20 mints an hour
  per busy repository and scope, and a KV round trip on many requests.
- **Ask.** Return `remote` from `get()` (it is fixed for a repository) or document its format so
  `info()` is not needed. A way for a Worker with the binding to forward git requests without a bearer
  token at all, for example `repo.fetch(request)`, authenticated by the binding. Failing that, document
  whether `get`, `info` and `createToken` are billed (A1).

### A5. No server-side hooks (costly)

- **What we tried.** Branch protection, push protection (secret scanning) and blocking pushes that
  would publish a person's private email, as every git host does, before refs move.
- **What we hit.** Artifacts has no pre-receive or update hook, and tokens are bearer credentials.
  Anything holding a write token can push past every policy.
- **What we built.** `services/repos/src/git_http.rs` `forward` reads the whole push body
  (`request.bytes()`), checks protected branches (`refusal`), then `secret_scan.rs` `scan_push` parses
  the pack in WebAssembly, walks trees and scans up to 24 MB (`MAX_SCANNED_PUSH`) before the
  body is copied again and forwarded. Pushes larger than that are let through unscanned, and we say so in
  the logs. To check a pack without reading its delta bases back through the binding, g1t adds
  `no-thin` to the receive-pack advertisement it forwards, so git sends every base in the pack; a
  client that sends a thin pack anyway has up to 200 bases read for it (`supply_bases`). Write tokens
  handed to sandboxes (`run_access.rs`) bypass all of it, so we keep their life
  minimal.
- **What it costs.** A second implementation of git's pack format in our code, memory pressure on every
  push, and a policy that only holds for pushes that come through our proxy.
- **Ask.** A pre-receive hook: Artifacts calls a Worker (service binding) with the ref updates and a
  streaming view of the new objects, and the Worker answers accept, or reject with a message git shows
  the user. Even a hook that sees only ref updates, with object reads through the binding, would remove
  most of this code.

### A6. No account-level push or ref-change events (costly)

- **What we tried.** React to pushes: run checks and Actions, recompute mergeability of open pull
  requests, reindex search, and invalidate caches of the ref advertisement.
- **What we hit.** [Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)
  give account-level `repo.created|deleted|forked|imported`, but `pushed`, `cloned`, `fetched` and token
  events need one subscription per repository. At tens of thousands of repositories and forks that is not
  practical to manage. Read-after-write for refs is not documented either.
- **What we built.** We record pushes ourselves (`record_push`), reading `log(branch, 1)` right after
  the receive-pack response and assuming it is final. Every code path that moves refs bumps a
  `refs_version` in D1, and `services/repos/src/refs_cache.rs` keys cached ref advertisements by it.
  Because a missed bump would serve stale refs, a unit test (`every_ref_writer_records_the_change`)
  scans our own source files for every ref writer and fails the build if one does not call
  `refs_moved`.
- **What it costs.** Correctness depends on a convention enforced by text search. Pushes made directly
  to Artifacts with a sandbox token are invisible to it until the 60 s cache TTL runs out.
- **Ask.** An account- or namespace-level `refs.updated` event with repository, ref, old and new ids,
  delivered to a Queue. A documented guarantee that refs are visible to `log` and `info/refs` everywhere
  once receive-pack responds. A cheap `refsVersion` or ref-advertisement ETag on `info()`.

### A7. Every full clone rebuilds its pack; partial clone docs disagree with behaviour (costly, friction)

- **What we tried.** Agent sandboxes, checks and the merge queue each clone the repository, often the
  same commit several times per pull request.
- **What we hit.** Measured 2026-10-06 from Denver: a full upload-pack of `flagon-io/g1t` (6,187
  objects, 5.5 MB) takes 1.96 to 2.22 s to the first byte, every time; the pack is built before anything
  is sent and nothing is cached. Separately, the [git protocol page](https://developers.cloudflare.com/artifacts/api/git-protocol/)
  marks `filter` "not supported" for v1, yet a protocol v2 `git clone --filter=blob:none` returned a real
  partial clone (2,789 objects, 903 KB). We cannot tell whether to build on it.
- **What we built.** Ref advertisement caching (above). A pack cache in R2 keyed by repository,
  `refs_version` and request hash is planned (ARTIFACTS.md R6), as is moving checks to `--depth=1`.
- **Ask.** Cache or reuse packs for identical wants with no haves (or bitmaps, so pack building is
  cheap). State partial clone support for protocol v2 explicitly, including which filters.

### A8. Namespace rate limit and sharding left to the customer (costly)

- **What we tried.** One namespace (`g1t`) for every repository and fork, one `ARTIFACTS` binding.
- **What we hit.** Control-plane requests are limited to "2,000 requests per 10 seconds per namespace".
  It is not documented whether binding calls count. Our model peaks at 250 to 400 calls a second against
  a ceiling of 200. [Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/)
  say "Do not keep every repo in one default namespace once usage grows", but a binding names exactly one
  namespace, and [data location](https://developers.cloudflare.com/artifacts/guides/data-localization/)
  (`eu` or `us`) is fixed per namespace at creation.
- **What we have to build.** Bindings `ARTIFACTS_0..N` plus `ARTIFACTS_EU`, a shard column per
  repository in our registry, least-loaded placement of new repositories, and forks in their own
  namespaces (ARTIFACTS.md R7). Every platform on Artifacts will build this same router.
- **Ask.** Say whether binding calls count toward the namespace limit, and what a client sees past it
  (429, `rateLimited`, queueing, `Retry-After`). One binding that can address many namespaces
  (`env.ARTIFACTS.namespace("g1t-eu-3")`). Either automatic sharding behind one namespace or a
  per-namespace limit that can be raised on request like the account storage limit.

### A9. Limits whose failure modes are undocumented (friction)

- **What we hit.** 1 GB per repository and 32 MB per file, but nothing on what a git client sees when a
  push crosses them, whether storage is garbage-collected or repacked, and when deleted branches or
  force pushes free space. `MEMORY_LIMIT` (10402) is raised "if the object cannot be buffered safely",
  with no stated size. No repository size in the binding.
- **What we have to build.** Our own checks in front of Artifacts that refuse objects over 32 MB and
  pushes that would cross about 950 MB, with an `ng` line git can show (ARTIFACTS.md R4), without knowing
  the true current size of a repository.
- **Ask.** Document the client-visible behaviour at each limit, GC and repack policy, and expose stored
  bytes per repository.

### A10. Durability, export and support during the beta (costly)

- **What we hit.** [How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/):
  "Cloudflare replicates repo data synchronously across multiple data centers and copies it
  asynchronously to object storage and snapshots." Good. But there is no SLA, no support path for the
  beta, no export or snapshot restore, and no statement of how long snapshots are kept.
- **What we have to build.** Nightly `git bundle` backups of every changed repository to R2, made in a
  Container because Workers cannot run git, and a restore drill (ARTIFACTS.md R11).
- **Ask.** Snapshot restore (point in time, per repository) and export to an R2 bucket we own, a beta
  support channel, and a GA date with an SLA.

### A11. No region or placement hint for a repository (friction)

- **What we hit.** A repository is "a single logical instance that Cloudflare can route to from any
  region". We cannot see or influence where its Durable Object lives, so we cannot put a busy team's
  repository next to them, or our `g1t-repos` Worker next to the repository.
- **Ask.** A `locationHint` on `create`/`fork`, as Durable Objects have, and the chosen location in
  `info()`.

## Workers and placement

### W1. Smart Placement chose Amsterdam for a Denver visitor (costly)

- **What we tried.** `"placement": { "mode": "smart" }` on the site and every data-holding service, as
  recommended for Workers that talk to a backend.
- **What we hit.** On 2026-10-06 production answered with `cf-placement: remote-AMS` for a visitor in
  Denver, and the git Worker had earlier run as `remote-ATL`, while every D1 primary is in WNAM. Services
  reached through service bindings run where their caller runs, so every D1 query crossed the Atlantic
  (about 85 to 150 ms each), and loaders that chain a few rounds of calls took 1.4 s or more. Pages
  measured from Colorado, signed out, warm (PERFORMANCE.md):

  | Page | Smart (AMS) | Placement off |
  | --- | ---: | ---: |
  | `/` | 270 ms | 140 ms |
  | `/explore` | 850 ms | 170 ms |
  | `/flagon-io/g1t/pulls` | 600 ms | 220 ms |
  | `/flagon-io/g1t/issues` | 780 ms | 230 ms |
  | `/pricing` | 500 ms | 120 ms |

  The [placement docs](https://developers.cloudflare.com/workers/configuration/placement/) say Smart
  Placement weighs "the Worker's performance and the network latency added by forwarding the request",
  and that it "only affects the execution of fetch event handlers. It does not affect RPC methods or
  named entrypoints." Neither the D1 primary's location nor the chain of service bindings behind the
  Worker seems to enter the decision, and the decision stuck.
- **What we built.** Placement off everywhere, D1 read replicas through the Sessions API (D1 below), a
  probe script (`scripts/perf/placement-probe.mjs`) that deploys throwaway Workers to measure D1 latency
  per placement, and a `Server-Timing` header on every page so we can see the next regression.
- **Ask.** Let Smart Placement account for D1 primaries and the bindings a Worker calls, re-evaluate
  placement when it is clearly worse than local, and keep `cf-placement` (the docs say it "may be removed
  before Smart Placement exits beta"; please keep it, it is how we found this).

### W2. Placement hints name cloud regions, not Cloudflare data (friction)

- **What we hit.** Hints like `"region": "aws:us-west-1"` place a Worker next to a cloud region. D1 is
  not one, and Cloudflare does not say which city WNAM is, so pinning a primary-only service beside its
  database means measuring candidates by hand.
- **Ask.** Accept a D1 database (or a Durable Object, or an Artifacts namespace) as a placement target,
  for example `"placement": { "near": { "d1": "g1t-repos" } }`.

### W3. Git over SSH needs inbound TCP (friction)

- **What we hit.** Git users expect `git@host:owner/repo.git`. Workers have no inbound TCP, so g1t
  serves HTTPS only. We submitted the inbound TCP request form on 2026-10-05 and are waiting.
- **Ask.** A path to inbound TCP on a Worker or Container for SSH, even rate-limited, and a published
  timeline.

## D1

### D1-1. Read replication across service bindings needs hand-built plumbing (costly)

- **What we tried.** One D1 database per service, read replicas near people, read-your-writes after a
  form submits.
- **What we hit.** D1 has one primary region. Replication is free and good, but the Sessions API's
  bookmarks live in one Worker's code. Our site calls seven services through service bindings, and each
  service owns its database, so a bookmark must travel from the database, through the service, back to
  the site, into a cookie, and back on the next request.
- **What we built.** An `x-d1-bookmark` header protocol (`crates/kit/src/d1.rs`,
  `packages/contracts/src/d1.ts`), per-service bookmarks in an HttpOnly cookie, a 30 s "read the primary
  after a write" window to cover services the site never sees write, and a list of known-read RPC methods
  so new ones are treated as writes by default (`apps/web/app/lib/perf.ts`).
- **Ask.** First-class session propagation across service bindings (a bookmark carried with the call,
  like trace context), and a `wrangler d1` command to turn replication on and off. Today it is dashboard
  or REST only, and turning it off "takes up to a day".

### D1-2. Transient and inconsistent errors from Wrangler (friction)

- **What we hit.** During launch week, `wrangler d1 migrations apply` intermittently failed with 7403
  ("account not valid or not authorized") with the same credentials that worked minutes later. On
  2026-10-05 `wrangler d1 execute --file` failed with authentication error 10000 while
  `wrangler d1 execute --command` with the same SQL and the same login worked; we applied a migration
  with `--command` to get unblocked.
- **Ask.** Make `--file` and `--command` use the same authorization, and make 7403 say which permission
  or account it was checking.

## Containers

### C1. No Docker inside a sandbox (friction)

- **What we tried.** Run g1t's own CI on g1t: the workflow that rebuilds our sandbox base image weekly
  runs in a Containers sandbox.
- **What we hit.** We found no supported way to run Docker or BuildKit inside a Container, so a sandbox
  cannot build or push an image. `.g1t/workflows/runner-base.yml` waits for a self-hosted runner with a
  `docker` label, and image builds happen on a laptop (DEPLOYING.md, "The runner's images").
- **Ask.** Rootless BuildKit in a Container, or a managed image build service that takes a Dockerfile
  and a context and pushes to `registry.cloudflare.com`.

### C2. Ephemeral disk rules Containers out as a durable store (costly)

- **What we tried.** Make our self-hostable git store (`deploy/self-host/gitstore`) a warm fallback for
  Artifacts, running on Cloudflare.
- **What we hit.** Container disk is ephemeral and at most 20 GB
  ([limits](https://developers.cloudflare.com/containers/platform-details/limits/)). A git store needs
  persistent disk, so the fallback has to live off Cloudflare.
- **Ask.** Persistent volumes for Containers (or R2-backed volumes with local caching).

### C3. Image rebuilds without a remote cache (friction)

- **What we hit.** After a local prune of Docker's build cache, rebuilding the sandbox base image (Debian, Node,
  Python, Go, Rust, toolchains) took about 20 minutes, because nothing on the registry side served as a
  build cache.
- **What we built.** `BUILDKIT_INLINE_CACHE` and `--cache-from` the previous base, and a two-layer image
  so a runner change pushes about 5 MB (`scripts/deploy/image.mjs`).
- **Ask.** Document `--cache-to type=registry` support on `registry.cloudflare.com`, or a hosted build
  cache.
- **Also hit (2026-10-06).** The first push of the 2.7 GB base to `registry.cloudflare.com` failed after
  several layers with `error from registry: blob unknown to registry`, from `docker push` and from
  `wrangler containers push` alike. The same push, run again an hour later, found every layer there and
  finished in 17 s. The image was an OCI index carrying a BuildKit provenance attestation (an
  `unknown/unknown` manifest), the default for `docker buildx build --load`; Wrangler's own builds pass
  `--provenance=false`. We now build as Wrangler does (one manifest, no provenance or SBOM) and push up
  to three times, failing loudly when no digest comes back. Ask: say whether manifests may reference
  just-uploaded blobs at once, and whether indexes with attestation manifests are supported.

## Tooling and account

### T1. Wrangler credentials are easy to get wrong silently (friction)

- **What we hit.** The global API key needs the account email as well as the key. Wrangler loads the
  repository's `.env` itself, so a `CLOUDFLARE_API_TOKEN` there (with fewer permissions) overrides a
  working `wrangler login`, and `unset` in the shell does not help; only an explicitly empty variable
  does. A missing token permission fails with `Authentication error [code: 10000]` and no permission
  name, and there is no published list of what `wrangler deploy` needs for each binding type (we wrote
  our own, DEPLOYING.md "The API token").
- **Ask.** Print which credential source Wrangler chose. Name the missing permission in 10000 errors.
  Publish the permissions each binding needs at deploy time.

### T2. Two accounts and non-interactive mode (friction)

- **What we hit.** A login that sees two accounts makes `wrangler d1` and `wrangler tail` refuse to pick
  one in non-interactive mode (CI, agents), even when `account_id` is in `wrangler.jsonc`. Every command
  needs `CLOUDFLARE_ACCOUNT_ID` set.
- **Ask.** Honour `account_id` from the config for every command, as `deploy` does.

### T3. Cloudflare for SaaS route refused right after enabling (friction)

- **What we hit.** On 2026-10-05, right after enabling Cloudflare for SaaS on `g1t.page`, adding the
  `*/*` Worker route failed with 10022 and 100327. The same request succeeded a few minutes later.
- **Ask.** Return a "still provisioning, retry in N seconds" error instead of a refusal, or block until
  ready.

## What we'd love to see

In rough order of how much code it would delete for us:

1. A published definition of a billable Artifacts operation, with matching per-repository metrics.
2. Fork storage semantics, fork expiry, repository size in `info()`, and an account-limit warning.
3. Ref listing, atomic compare-and-swap ref updates and streaming object or pack writes in the binding.
4. A pre-receive hook answered by a Worker.
5. Account-level `refs.updated` events to a Queue, and a read-after-write guarantee for refs.
6. Binding-authenticated git forwarding (`repo.fetch(request)`) with no token mint.
7. Pack reuse for identical full clones, and documented protocol v2 partial clone.
8. One binding over many namespaces, clear namespace rate-limit behaviour, raisable limits.
9. Snapshot restore and export to our own R2 bucket; a beta support path; a GA date and SLA.
10. Location hints for repositories.
11. Smart Placement aware of D1 and service bindings; D1 as a placement target; keep `cf-placement`.
12. D1 sessions that cross service bindings; replication in Wrangler.
13. Persistent volumes and image builds for Containers.
14. Inbound TCP for git over SSH.
15. Wrangler: visible credential source, named missing permissions, config `account_id` everywhere.

## What worked well

- **One Durable Object per repository.** The right isolation unit. A hot repository does not affect
  its neighbours, and there is nothing to shard by hand at the repository level.
- **Smart HTTP compatibility.** Stock git, protocol v0 and v2, clones, fetches, shallow clones and
  pushes worked through our proxy from the start. Because Artifacts speaks real git, our proxy only adds
  authentication, policy and caching.
- **Speed when warm.** With a kept credential and a cached ref advertisement, `git fetch` with nothing
  new answers in 0.35 to 0.42 s from Denver, and a cached `info/refs` in 3 to 6 ms on our side.
- **Forks as a primitive.** `fork()` is one call. Per-pull-request isolation for agents fell out of it
  almost for free.
- **Scoped, expiring tokens.** `read` and `write` scopes and TTLs from 60 s let us hand sandboxes a
  credential that dies on its own.
- **Durability design.** Synchronous replication plus R2 snapshots is the right design, clearly
  explained in the launch post and docs.
- **The binding reads.** `readTree`, `readBlob`, `log` and `readCommit` power every web page, blame,
  mergeability and search indexing without a git client.
- **Typed errors.** `ArtifactsError` codes (`NOT_FOUND`, `*_IN_PROGRESS`, `MEMORY_LIMIT`) are easy to
  handle precisely.
- **The rest of the platform.** Workers with Rust and WebAssembly, D1 with free read replication, KV,
  R2, Queues, Containers with three instance sizes, and Cloudflare for SaaS gave a small team a global
  git platform with no servers to run. With placement off, most pages answer in under 250 ms.

We are glad to share traces, test repositories or a call with the teams involved. Contact us through
g1t.sh.
