# Cloudflare Artifacts: due diligence for g1t at launch scale

Status: research document, 2026-10-06; R1–R5, R9, R10, R13 and R7 groundwork were built the same day (section 9).
R7 (sharding, moves, EU residency) and R12 (the fallback store) were built 2026-10-07, off until their
infrastructure exists ("What you must create", section 9).
Scope: everything g1t stores in Cloudflare Artifacts (open beta since 2026-10-01; billing from 2026-10-14),
measured against what Cloudflare documents, and what we must build so that a few thousand workspaces
can run on it.

## Summary

Artifacts fits what g1t does: one Durable Object per repository, smart HTTP for clones and pushes, a
read-only binding for commits, trees and blobs, forks and short-lived tokens. Nothing we rely on is
missing outright. Five things are not yet safe at a few thousand workspaces.

1. **We do not know what an "operation" is.** Pricing says "repo operations, such as `create`, `push`,
   `pull`, and `clone`". Metrics list only `create`, `fork`, `push`, `pull`, `delete`. If binding reads
   (`get`, `info`, `createToken`, `log`, `readTree`, `readBlob`, `readCommit`, `readFile`) and every git
   HTTP request also count, our bill at launch scale is roughly **15× larger** (about $31k a month instead
   of about $1.8k). We must settle this before 2026-10-14.
2. **Pull request forks are never deleted.** Every pull request is an Artifacts fork (`pulls--<id>`). They
   are purged only with their parent repository. Cloudflare does not say whether a fork shares objects
   with its source. If forks copy objects, an agent-heavy workload reaches the **1 TB account storage
   limit in days**, and every push then fails. If they share, storage still grows without bound.
3. **One namespace carries everything.** All repositories and forks live in the `g1t` namespace. The
   control-plane limit is **2,000 requests per 10 seconds per namespace** (200 per second). If binding
   calls count against it, page views, token mints and mergeability checks together exceed it at launch
   peaks. Sharding is now built (R7, section 9); the extra namespaces are not made yet.
4. **Hard limits are not enforced in front of Artifacts.** 1 GB per repository, 32 MB per file, and a
   128 MB Worker isolate that buffers each push body twice. Large pushes and imports fail late, without a
   message git can show.
5. **No backup, no exit drill.** Cloudflare replicates data, but there is no SLA, no documented export
   besides git itself, and the self-host git store is not a production fallback yet. Nightly bundles
   to R2 and a restore drill are now built (R11, section 9), and so is the fallback path (R12): a
   restore into the git store and a switch by configuration. The host it runs on is not made yet.

None of these blocks an invite-only launch. Items 1 and 2 must be answered before billing starts on
2026-10-14, and the fork cleanup must ship before agent pull requests reach thousands a day.

## 1. What Cloudflare documents

All quotes are from developers.cloudflare.com, retrieved 2026-10-06.

### Limits ([Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/), updated 2026-10-01)

| Limit | Value |
| --- | --- |
| Control-plane request rate | 2,000 requests per 10 seconds **per namespace** |
| Git request rate | 2,000 requests per 10 seconds **per repository** |
| Storage per repository | **1 GB** |
| Largest file or blob | **32 MB** |
| Storage per account | **1 TB** (can be raised on request) |
| Repositories, namespaces | Unlimited |
| Names | 2 to 63 characters; letters, digits, `.`, `_`, `-`; start with a letter or digit |

### Pricing ([Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/))

- Workers Paid only. "Cloudflare will begin billing for Artifacts operations and storage on October 14, 2026."
- Operations: first 10,000 a month, then **$0.15 per 1,000**. Defined only as "the number of repo
  operations, such as `create`, `push`, `pull`, and `clone`."
- Storage: first 1 GB, then **$0.50 per GB-month**, "calculated by averaging peak storage per day over a
  30-day billing period". "Replicas do not add storage charges." "Repos remain stored until you
  explicitly delete them."

### Architecture ([announcement blog](https://blog.cloudflare.com/artifacts-git-for-agents-beta/), 2026-04-16, Matt Carey and Matt Silverlock)

- Each repository is a Durable Object; the git server is Zig compiled to WebAssembly (about 100 KB).
- "Files are stored in the underlying Durable Object's SQLite database." "Durable Object storage has a
  2MB max row size, so large Git objects are chunked and stored across multiple rows."
- "DOs have ~128MB memory limits." Fetch and push stream (`ReadableStream<Uint8Array>`).
- "Artifacts also uses R2 (for snapshots) and KV (for tracking auth tokens)."
- Deltas are stored as received; "if the requesting client already has the base object, Zig emits the
  delta instead."
- Durability ([How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)):
  "Cloudflare replicates repo data synchronously across multiple data centers and copies it
  asynchronously to object storage and snapshots."
- A repository is "a single logical instance that Cloudflare can route to from any region", like a
  Durable Object. Durable Objects have a soft limit of 1,000 requests per second each
  ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).

### Git protocol ([Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/))

| Feature | Documented support |
| --- | --- |
| Clone and fetch | Protocol v1 and v2 (`ls-refs`, `fetch`); v1 shallow and deepen |
| Push | v1 receive-pack only; v2 receive-pack not supported |
| `filter` (partial clone), `include-tag` | "not supported" for v1 |
| Tokens | `art_v1_<40 hex>?expires=<unix seconds>`; scopes `read`, `write`; TTL 60 s to 1 year, default 24 h |

**Measured differently:** a protocol v2 `git clone --filter=blob:none` of `flagon-io/g1t` through g1t
returned a real partial clone (2,789 objects, 903 KB) instead of the full 6,187 objects and 5.5 MB. So
v2 filtering works today, despite the table. Ask Cloudflare whether this is supported or accidental.

### Binding API ([Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/); generated types in `services/*/worker-configuration.d.ts`)

- Namespace: `create`, `get`, `list`, `import`, `delete`. `get()` is a lookup that throws `NOT_FOUND` or
  `*_IN_PROGRESS`, so it costs a round trip.
- Repository handle: `info()` ("Each call performs a fresh lookup"), `createToken`, `listTokens`,
  `revokeToken`, `log` (first-parent only, at most 1,000), `readCommit`, `readTree` (one level),
  `readBlob`, `readFile`, `fork` (`defaultBranchOnly` defaults to true).
- Not available: listing refs, updating refs, writing objects, repository size, gc or repack, hooks.
  g1t works around the first three over smart HTTP (`refs.rs`, `land.rs`, `catch_up.rs`).
- Errors: `MEMORY_LIMIT` (10402) "if the object cannot be buffered safely", `INTERNAL_ERROR` (10400),
  `UPSTREAM_UNAVAILABLE`, `IMPORT_IN_PROGRESS`, `FORK_IN_PROGRESS`, `CREATE_IN_PROGRESS`
  ([Errors](https://developers.cloudflare.com/artifacts/api/errors/)).
- Doc drift: the [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)
  still says the binding "cannot read or write files inside them". It can read; it cannot write.

### Observability, events, data location

- Metrics: GraphQL dataset `artifactsEventsAdaptiveGroups`, 31 days, with `eventType` in `create`,
  `fork`, `push`, `pull`, `delete`, and errors `storageLimitReached`, `serverError`, `clientError`,
  `rateLimited` ([Metrics](https://developers.cloudflare.com/artifacts/observability/metrics/)).
  **This is the fastest way to learn what Cloudflare counts.**
- Events: account level `repo.created|deleted|forked|imported`; per-repository `pushed`, `cloned`,
  `fetched`, `token.created|revoked`, which need one subscription per repository
  ([Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)).
  g1t reports pushes itself for that reason (`record_push`).
- Jurisdictions `eu` and `us`, chosen when a namespace is created and never changeable
  ([Data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/)). A binding
  names one namespace, so EU residency needs a second binding.
- Best practices: "Do not keep every repo in one default namespace once usage grows" and "When one
  namespace becomes hot, shard new repos into additional namespaces"
  ([Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/)).
- Beta: the docs state no SLA, no support tier, and no backup or export feature beyond git itself.

### Platform limits that bound us

| Limit | Value | Source |
| --- | --- | --- |
| Worker memory | 128 MB per isolate, shared by concurrent requests | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Request body | 100 MB on Free and Pro zones, 200 MB Business, up to 5 GB Enterprise | same |
| Response body | No limit (CDN cache 512 MB) | same |
| CPU | 30 s default, up to 5 min | same |
| Subrequests | 10,000 per invocation (Paid); 6 connections waiting for headers at once | same |
| Cache API | Per data center only; calls share the subrequest quota | [Cache](https://developers.cloudflare.com/workers/runtime-apis/cache/) |
| KV | 1 write per second per key; 25 MiB values; 60 s minimum TTL | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) |
| D1 | 10 GB per database; 30 s per query; one writer | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Cloudflare REST API | 1,200 requests per 5 minutes per user | [API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) |
| Containers | Up to 4 vCPU, 12 GiB, 20 GB disk (ephemeral) | [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/) |
| Smart Placement | Applies to fetch handlers, not RPC entrypoints | [Placement](https://developers.cloudflare.com/workers/configuration/placement/) |

The REST API's 1,200 requests per 5 minutes means the hot path must use the binding, never the REST API.

## 2. How g1t uses Artifacts

All Artifacts traffic goes through `services/repos` (`g1t-repos`), binding `ARTIFACTS`, namespace `g1t`,
placement off. Store keys are `<workspace>--<repo>`; pull request forks are `pulls--<pull id>`.

### Calls per user action

"Binding" counts calls on `env.ARTIFACTS`; "git" counts HTTP requests to the repository's remote.

| Action | Path in code | Binding calls | Git requests to Artifacts |
| --- | --- | --- | --- |
| Credential (mint) | `store.rs` `mint_access` | 3: `get`, then `info` and `createToken` at once | 0 |
| Clone, protocol v2 | `lib.rs` `answer_git` → `git_http::forward` | mint if none kept (3) | `info/refs` and `ls-refs` (0 on a `refs_cache` hit), `fetch` 1 |
| Clone, protocol v0 | same | mint if none kept | `info/refs` (0 on hit), `upload-pack` 1 |
| Fetch, nothing new | same | as above | `ls-refs` (0 on hit), `fetch` 1 |
| Push | same, then `record_push` | mint; then `get` + `log(branch, 1)` per pushed branch | `info/refs` 1, `receive-pack` 1 |
| Tree page | `Repos::tree` | `get`, `log(ref, 1)`, `readTree` per path segment (Cache API), `readBlob` README (cached) | 0 |
| File page | `Repos::blob` | `get`, `readFile` (not cached) | 0 |
| Branches list | `GitRepo::branches` (`refs.rs`) | mint (3) | `info/refs` 1 (does not use `refs_cache`) |
| Blame | `blame.rs` | `log(ref, 400)`, then trees and blobs per commit | 0 (one view took 6.6 s wall in the tail) |
| Open a pull request | `fork_for_pull` | `get`, `fork` | 0 |
| Mergeability (each time the target branch moves, for up to 100 open pull requests) | `divergence` | `get` ×2, `log(…, 1000)` ×2, `readCommit` per commit off the first-parent chain, `readTree` per changed directory | 0 |
| Catch-up (no conflicts) | `catch_up.rs` | `get` ×2, `log` ×2, trees | `upload-pack` 1, `receive-pack` 1 |
| Land a pull request | `land.rs` | 2 mints (6) | `upload-pack` 1 from the fork, `receive-pack` 1 to the target |
| Commit one file | `commit_file.rs` | mint, `log` | `info/refs` 1, `receive-pack` 1 |
| Mirror sync or import | `mirror.rs`, `import.rs` | mint | `info/refs` 1–2, `upload-pack` and `receive-pack` 1 each; packs capped at 40 MB |
| Search indexing | `listing.rs` | trees by level, blobs in groups | 0 |
| Push protection | `secret_scan.rs` | trees and blobs for bases, up to 24 MB scanned | 0 |
| Delete (purge) | `lifecycle.rs` | `delete` per key, including forks | 0 |

Every sandbox job clones in full (`crates/runner/src/{main,checks,review,plan,queue,reply,update,deploy,mergecheck}.rs`:
`git clone --quiet`, no depth, no filter), and most then fetch an upstream branch. Only Actions'
checkout fetches with `--depth=1` (`crates/runner/src/actions/uses.rs`).

### What already saves calls

| Mitigation | Where | What it saves |
| --- | --- | --- |
| Credential cache | `store.rs` `Credentials` (per isolate) and `shared.rs` (KV, sealed), TTL 300 s, reused 180 s | 3 binding calls and about 800 ms per git request on a hit |
| Ref listing cache | `refs_cache.rs`, keyed by `refs_version`, 60 s TTL, colo Cache API then KV | the `info/refs` and `ls-refs` round trip (330–400 ms) on a hit; measured hits answer in 3–6 ms |
| Object cache | `store.rs` `cached`/`keep`, Cache API, immutable | `readTree`, `readBlob` (≤ 1 MB), and `log` by commit hash |
| Recent row cache | `registry.by_path_recent` | D1, not Artifacts |
| Soft delete | `lifecycle.rs` | an accidental `delete` cannot lose data for `RESTORE_DAYS` |

Gaps in those caches: the Cache API is per data center, so each colo pays its own misses; `log` by branch
name, `readFile`, `branches()` and `readCommit` are never cached; the credential reuse window is 180 s,
so a busy repository mints about 20 times an hour per scope.

## 3. Measured in production

Read-only, from a client in Denver (`CF-Ray …-DEN`), 2026-10-06 07:40 UTC, git 2.45 user agent.
`flagon-io/hello`: 239 objects, 44 KB pack. `flagon-io/g1t`: 6,187 objects, 5.5 MB pack.

| Measurement | hello | g1t |
| --- | --- | --- |
| `info/refs`, cold: credential minted | n/a | 1,306–1,425 ms total: `mint` 807–856 ms, `store` 334–399 ms |
| `info/refs`, `refs_cache` hit | 3–6 ms server, 80–150 ms client | 3–6 ms server |
| `ls-refs` / v2 advertisement miss with kept credential | 436 ms (`store` 349) | 458 ms (`store` 332) |
| Full upload-pack (replayed v0 want, kept credential) | 674–1,104 ms, `store` 607–997 | 1,960–2,223 ms to first byte, `store` 1,855–2,156; 3.2 s total |
| `git clone --bare`, first / repeats | 5.1 s / 2.0–2.4 s | 5.4 s / 4.2 s (4.8–5.8 s during the tail) |
| `git fetch`, nothing new | 0.99 s first, then 0.39–0.42 s | 0.95 s first, then 0.35–0.41 s |
| `clone --depth=1` | 1.6 s | 3.8 s |
| `clone --filter=blob:none` | 1.4 s | 3.4 s, 903 KB |
| `kept` step on every POST | 63–98 ms | same |

Observations:

- Artifacts builds the whole pack before the first byte: about 2 s for 5.5 MB. Every full clone pays
  this, every time, because nothing caches packs.
- Minting a credential costs about 0.8 s, almost all in `get` then `info` and `createToken`.
- The 63–98 ms `kept` step on every POST is not Artifacts. It is `git_limits` doing a D1 upsert into
  `git_operations` before the request is forwarded.
- `wrangler tail g1t-repos` for 75 s: 87 events, all `ok`, no exceptions or error logs. The slowest were a
  blame RPC (6.6 s wall, 178 ms CPU) and an `info/refs` miss with a mint (2.6 s).

## 4. Where we and the docs disagree

| # | Topic | Documented | What g1t does or assumes | Risk | Fix |
| --- | --- | --- | --- | --- | --- |
| M1 | What an operation is | "create, push, pull, clone"; metrics events `create`, `fork`, `push`, `pull`, `delete` | `git_ops.rs` bills workspaces per upload-pack or receive-pack POST, including `ls-refs` answered from our cache; binding reads assumed free | Cost could be about 15× the plan; customers billed for operations that never reach Artifacts | R1 |
| M2 | Fork storage | Not documented; fork returns `objects: N` | `store.rs` calls forks "copy-on-write"; forks never deleted until the parent is purged | 1 TB account limit; storage grows forever | R2 |
| M3 | Namespace rate | 2,000 per 10 s per namespace | One namespace for all repositories and forks | 429s across all of g1t at peak | R7 |
| M4 | Repository size | 1 GB | Free private storage is 1 GB per workspace; no per-repository check; imports capped at 40 MB | Late `storageLimitReached` failures with no explanation | R4 |
| M5 | File size | 32 MB | No check before forwarding | Push fails inside Artifacts | R4 |
| M6 | Push bodies | Workers 128 MB per isolate; 100 MB body cap on our zone plan | `git_http::forward` reads the body (`request.bytes()`) and copies it into a `Uint8Array`; push protection also reads it | Pushes above roughly 40–50 MB can exceed isolate memory, taking concurrent requests with them | R4 |
| M7 | Landing and mirrors | Fetch streams | `land::fetch_pack` buffers the pack, `unpack_sideband` copies it, `push_pack` copies again | Large pull requests can fail to land | R4 |
| M8 | Token lifetime | 60 s to 1 year | 300 s, reused 180 s | Mint load and 0.8 s latency on each miss | R3 |
| M9 | `info()` | "Each call performs a fresh lookup" | Called on every mint only to read `remote` | One wasted call per mint; `remote` is fixed per key | R3 |
| M10 | Partial clone | v1 `filter` unsupported | v2 `blob:none` works in production | Building on undocumented behaviour | Q3 |
| M11 | Read-after-write | Not documented | `record_push` reads `log(branch, 1)` right after the push response; `refs_moved` assumes refs are final when the response ends | Missed push events if a read lags | Q5 |
| M12 | Errors | Typed `ArtifactsError`, `rateLimited` events | `ALREADY_EXISTS`/`NOT_FOUND` tolerated; everything else returns 500; no retry, no breaker | Brief Artifacts errors become user-visible failures | R5 |
| M13 | Durability | Synchronous replication, asynchronous snapshots; no SLA; no export | No copy outside Artifacts | Beta incident or account issue with no recovery path | R11 |
| M14 | Data location | Jurisdiction per namespace, fixed | `PLAN.md` promises residency per workspace; only `g1t` exists | EU customers cannot be offered residency | R7 |
| M15 | Direct credentials | Tokens are bearer, repo-scoped | `git_access` hands out raw write tokens (no caller is deployed today: sandboxes use g1t's git endpoints, and only backups get a read token); pushes with them skip branch protection and push protection (`refs_open` only stops caching) | Policy bypass if a token leaks out of a sandbox | Keep TTL minimal on this path |
| M16 | Hot repository | 2,000 git requests per 10 s per repository; DO soft limit 1,000 req/s | Agents clone the same repository many times per pull request | Not near the limit today; a monorepo with many agents could be | R6 |

## 5. Capacity model: 3,000 workspaces

### Assumptions

- 3,000 workspaces, 10,000 repositories, 6,000 active people, average repository 25 MB stored.
- People: 6 fetches and 3 pushes per person per day.
- Agent pull requests: 15,000 a day (5 per workspace). Human pull requests: 3,000 a day.
- Per agent pull request: 1 fork; 1.5 agent runs × (clone + upstream fetch + push); 1.5 check clones;
  review clone + fetch; mergecheck in 30% of cases (clone + fetch); 0.5 catch-up push; merge queue clone +
  fetch; landing upload-pack + receive-pack; 0.3 deploy clones. About **14 git operations**.
- Actions: 1.5 checkouts per push. Mirrors: 1,000 repositories × 24 syncs × 2.
- Web: 60 page views per person per day, about 5 uncached binding calls each.
- Mergeability: 18,000 default-branch moves a day × 8 open pull requests × about 20 binding calls.

### Operations per day

| Source | Scenario A: git data operations only | Scenario B: every Artifacts call |
| --- | ---: | ---: |
| People: fetch and push | 54,000 | 54,000 |
| Agent pull requests (15,000 × 14) | 210,000 | 210,000 |
| Human pull requests (3,000 × 8) | 24,000 | 24,000 |
| Actions checkouts | 60,000 | 60,000 |
| Mirrors | 48,000 | 48,000 |
| Credential mints (≈ 200,000 × 3) | 0 | 600,000 |
| Ref listing misses (`info/refs`, `ls-refs`) | 0 | 300,000 |
| Web pages (360,000 × 5) | 0 | 1,800,000 |
| Mergeability (18,000 × 8 × 20) | 0 | 2,900,000 |
| Search indexing, push protection, `record_push` | 0 | 900,000 |
| **Total per day** | **≈ 400,000** | **≈ 6,900,000** |
| **Per month** | **≈ 12 M** | **≈ 207 M** |
| **Cost per month at $0.15 / 1,000** | **≈ $1,800** | **≈ $31,000** |

Rates: scenario A averages 5 operations per second. Scenario B averages 80 calls per second and peaks
around 250–400, above the 200 per second a single namespace allows, if binding calls count toward it.

Hot spots, largest first in scenario B: mergeability fan-out (42%), web reads (26%), credential mints
(9%), indexing and scanning (13%), sandbox clones (6%, but they carry almost all the bytes and the
latency).

### Storage

| Item | Estimate | Cost per month |
| --- | --- | ---: |
| 10,000 repositories × 25 MB | 250 GB | ≈ $125 |
| Pull request forks if shared (about 0.5 MB of new objects each) | +270 GB every month, never deleted | +$135, growing each month |
| Pull request forks if copied (25 MB each, 540,000 a month) | +13.5 TB a month | ≈ $6,750 the first month, and the 1 TB account limit is reached in about 2 days |

### Free tier exposure

`GIT_OPERATIONS_FREE_CAP` is 50,000 operations per workspace per month, never charged. At $0.15 per 1,000
that is at most $7.50 per free workspace, or $22,500 a month if all 3,000 used it. Realistic use is far
lower, but the cap should be sized to what Cloudflare actually counts (R1).

## 6. Recommendations, ranked by risk × effort

P0 means before 2026-10-14 or before agent volume ramps. Effort assumes one engineer.

| # | Priority | What to build | Where | Expected effect | Effort |
| --- | --- | --- | --- | --- | --- |
| R1 | P0 | Find out what counts. Query `artifactsEventsAdaptiveGroups` grouped by `eventType` for the last 31 days and compare with `git_operations`; ask Cloudflare in writing. Then make `git_ops::count` count what Cloudflare counts (skip `ls-refs` and cache hits if they are free). | `services/repos/src/git_ops.rs`, a script under `scripts/` | Removes the 15× uncertainty; billing matches cost | 0.5 day plus Cloudflare's answer |
| R2 | P0 | Delete pull request forks after merge or close plus a grace period (for example 14 days), and verify fork storage semantics with a 100 MB test repository and the storage metric. | `lifecycle.rs` sweep (`23 * * * *`), `work` events `pull.merged`/`pull.closed` | Storage proportional to open work instead of all history; removes the 1 TB cliff | 1–2 days |
| R3 | P0 | Mint less and faster: TTL 3,600 s with a 50 min reuse window for credentials that never leave the service; keep 300 s for `git_access`. Derive `remote` from the key (`https://<account>.artifacts.cloudflare.net/git/g1t/<key>.git`) or keep it in the registry `store` column instead of calling `info()`. Retry a 401 once with a fresh token (already done for GET). | `store.rs` `TOKEN_TTL_SECONDS`, `TOKEN_REUSE_MS`, `ArtifactsRepo::access` | Mints about 15× fewer; cold git requests about 0.5 s faster | 0.5 day |
| R4 | P0 | Enforce limits in front of Artifacts: refuse objects over 32 MB and pushes that would take a repository over about 950 MB, with a git `ng` line (same framing as `declined`); stream the push body to Artifacts instead of buffering it twice, keeping only the command section and at most `MAX_SCANNED_PUSH` for scanning; stream `land` packs straight from upload-pack into receive-pack. | `git_http.rs` `forward`, `secret_scan.rs`, `land.rs` | Clear errors instead of late failures; no isolate OOM on 50–100 MB pushes | 2–3 days |
| R5 | P0 | Resilience: map `ArtifactsError.code` and HTTP 429/5xx to retry with jittered backoff (reads, mints, ref listings only; never a receive-pack), a per-isolate circuit breaker, `Retry-After` to git, and an "Artifacts" component on status.g1t.sh fed by the GraphQL error metrics (`rateLimited`, `serverError`, `storageLimitReached`). | `store.rs`, `git_http.rs`, `apps/status` | Brief Artifacts errors stop reaching users; incidents are visible | 2 days |
| R6 | P1 | Pack cache for full clones: when an upload-pack request has wants and no haves, key it by (repo id, `refs_version`, hash of the request) and serve the pack from R2; fill it on a miss with a tee of the response. Sandboxes clone the same commit repeatedly per pull request. | `git_http.rs`, `refs_cache.rs` pattern, new R2 bucket | Removes about 2 s of pack building per repeat clone and a large share of `pull` operations | 3–4 days |
| R7 | P1 | Shard namespaces: bindings `ARTIFACTS_0…N` plus `ARTIFACTS_EU`; record each repository's namespace in the registry `store` column (already read by `remember_store`); new repositories and forks go to the least-loaded shard; forks in their own namespaces. | `services/repos/wrangler.jsonc`, `store.rs`, `registry.rs` | Multiplies the control-plane ceiling; enables EU residency | 3 days |
| R8 | P1 | Sandboxes clone less: `--depth=1` for checks and deploy; `--filter=blob:none` only where lazy blob fetches are few (review of a small diff); keep full clones for agent runs and merges. Or restore a cached sandbox snapshot and `git fetch` (Sandbox SDK backups). | `crates/runner/src/*.rs` clone calls | Measured: 3.8 s (depth 1) and 3.4 s (blobless) against 5.4 s for g1t; fewer bytes from Artifacts | 1–2 days |
| R9 | P1 | Cache mutable reads by `refs_version`: `log(branch, n)`, `branches()` (parse the kept `refs_cache` advertisement instead of a new `info/refs`), and `readFile` (resolve the path through cached trees, then a cached `readBlob`). | `store.rs`, `refs.rs`, `lib.rs` `tree`/`blob`/`branches` | Most web page views stop reaching Artifacts | 2 days |
| R10 | P1 | Calm mergeability: coalesce re-checks per repository (one pass per target head, at most once a minute), resolve the target head once and `log` by hash (already cached), and cache `readCommit` like other objects. | `services/work/src/mergeability.rs`, `lib.rs` `divergence`, `descends_from` | The largest scenario-B hot spot drops by an order of magnitude | 1–2 days |
| R11 | P2 | Back up every repository to R2: a nightly incremental `git bundle` per repository whose `refs_version` changed, made in a Container (Workers cannot run git), with a restore drill. | new job in `services/runner` or a Container | Durability independent of the beta; also the export path | 3–5 days |
| R12 | P2 | Make the git store a real fallback: run `deploy/self-host/gitstore` on a host with persistent disk (Containers' disk is ephemeral and at most 20 GB), restore from the R2 bundles, and switch `GitStore` per namespace shard. | `deploy/self-host/gitstore`, `store.rs` | A tested exit path; not a hot standby | 1–2 weeks |
| R13 | P2 | Take the operation counter off the request path: record the count in `waitUntil` (or Analytics Engine), and check limits against a value cached for a minute. | `lib.rs` `git_limits`, `git_ops.rs` | Saves 63–98 ms on every fetch and push; removes a hot D1 row per workspace-hour | 1 day |
| R14 | P2 | Try Smart Placement or a placement hint for `g1t-repos`, which makes several sequential calls to Artifacts per request; compare `Server-Timing` before and after. | `services/repos/wrangler.jsonc` | Possibly lower latency for distant users | 0.5 day |
| R15 | P3 | Large files: an LFS endpoint backed by R2 for files over 32 MB. | new route in `services/repos` | Repositories with binaries can move to g1t | 1–2 weeks |

## 7. Questions for Cloudflare

Ask in the Artifacts beta channel (the [beta request form](https://forms.gle/DwBoPRa3CWQ8ajFp7) is the
listed contact), through our account team, and in the Cloudflare Developers Discord. As a git
competition entrant (due 2026-10-14) we can also ask the competition organisers. Get answers in writing.

1. Exactly what is billed as an operation? Is each `upload-pack` and `receive-pack` request one, or each
   clone or fetch? Do `info/refs`, `ls-refs`, binding calls (`get`, `info`, `createToken`, `log`,
   `readTree`, `readBlob`, `readCommit`, `readFile`) or token creation count?
2. Does `fork` share objects with its source or copy them? How is a fork's storage billed? Does
   `objects` in the fork response mean objects copied?
3. Is protocol v2 `filter` (partial clone) supported, given it works today but the docs say it does not?
4. Do binding calls count toward "2,000 requests per 10 seconds per namespace"? What happens past it
   (429, `rateLimited`, queueing)? Can it be raised per namespace?
5. Read-after-write: once a receive-pack response has ended, are refs visible to `log`, `info/refs` and
   other locations at once?
6. Is `receive-pack` with `atomic` supported for multi-ref pushes?
7. Where does a repository's Durable Object live, can it move, and can we hint a region per repository?
8. What SLA, support path and incident communication apply during open beta? When is GA?
9. Is there an export or snapshot restore for a deleted or corrupted repository? How long are R2
   snapshots kept?
10. Can the 1 GB per repository and 32 MB per file limits be raised, and what does a client see when a
    push crosses them?
11. Does Artifacts garbage-collect or repack? Do deleted branches and force pushes free storage, and when?
12. Can the 1 TB account limit be raised now, ahead of launch?
13. Are per-repository event subscriptions practical at tens of thousands of repositories, or is an
    account-level `pushed` event planned?

## 8. Launch blockers

- **Before 2026-10-14:** R1 (know what is billed and count the same thing) and R2's verification (fork
  storage semantics). If forks copy objects, R2's deletion is a launch blocker for agent-heavy
  workspaces, because the 1 TB account limit would stop every push.
- **Before agent volume ramps (about 1,000 pull requests a day):** R2 deletion, R3, R4, R5.
- **Before a few thousand active workspaces:** R6, R7, R9, R10.
- **Before git over SSH ships:** SSH's git operations are metered (see "where the gap came
  from" under R1). Until then `crates/sshd` stays undeployed.
- Everything else is resilience and exit planning, ideally done while the product is still invite-only.

## 9. What was built (2026-10-06)

Code in `services/repos` unless named; one migration,
`migrations/0011_artifacts_meters_forks_health.sql` (new columns on `repos`, new tables
`artifacts_meters`, `operation_mapping`, `store_health`; additive, no backfill). R11 added
`migrations/0013_backups.sql` (a new table, `repo_backups`, and one `operation_mapping` row;
additive). R7 added `migrations/0014_namespace_moves.sql` (two columns on `repos`,
`writes_paused_until` and `writes_paused_for`; new tables `repo_moves` and `repo_move_copies`;
additive) and, in identity, `services/identity/migrations/0026_workspace_residency.sql` (one column,
`workspaces.data_residency`; additive). R12 needs no migration.

| # | Status | What |
| --- | --- | --- |
| R1 | Built; Cloudflare's answer still needed | Every interaction with the store is metered raw (`meters.rs` → `artifacts_meters`, per day, namespace, repository, workspace and meter, with bytes where known): client git (`git.info_refs`, `git.ls_refs`, `git.fetch`, `git.receive_pack`), g1t's own git (`internal.git.*`: landing, catch-up, mirrors, branch listings, fork retirement), every binding call (`binding.get`, `binding.create_token`, `binding.log`, `binding.read_tree`, …, each retry included), and answers g1t served from its own cache (`cache.*`, never operations). Which meters are operations is data: `operation_mapping` (`cost_operations` for g1t's bill, `billable_operations` for workspaces), read every 5 minutes, changed with `set_operation_mapping` without a deploy. Default: `git.fetch`, `git.receive_pack`, `internal.git.fetch`, `internal.git.receive_pack`, `binding.create`, `binding.fork`, `binding.delete` = 1, everything else 0. `git_operations` (what billing reads) is filled from the meters × `billable_operations`, by the hour. RPCs: `artifacts_usage { from, to, workspace?, by_repo? }` (raw meters and the mapping, for the reconciler), `operation_mapping`, `set_operation_mapping { meter, cost_operations, billable_operations, note? }`. Script: `scripts/ops/artifacts-usage.mjs`. Sandboxes' git goes through `git_http` and is metered there; a pull request's working copy counts for its repository's workspace; a request that counts something plans the write that follows in its own `wait_until`, so counts are not stranded in an idle isolate (2026-10-07, see "2026-10-07: where the gap came from"). |
| R13 | Built | Nothing on the request path writes D1 for counting. Meters add up per isolate and are written in one batch from `ctx.wait_until` after every request (and at the end of the cron and queue handlers); a failed write is kept for the next. The free-workspace slow-down decides from counts the isolate read back after its last write plus what it added since (`git_ops::standing`, at most 10 minutes old) and billing's plan answer kept 5 minutes. The 63–98 ms `kept` step's D1 upsert is gone. A workspace whose counts this isolate never read is not slowed: nothing slows anyone on a guess. |
| R2 | Built; the fork storage test is yours to run | `pull.merged` and `pull.closed` set the fork's `retire_after` (`FORK_RETENTION_DAYS`, 1 day in production; 7 when unset); `pull.reopened` clears it, or makes the fork again. The hourly sweep (`23 * * * *`, 25 a run) keeps the fork's head in its repository as `refs/pull/<pull id>/head` (only missing objects travel; an empty pack when merged), records `retired_at` and `retired_head`, then deletes the fork from the store (a failed delete puts the row back). Reads of a retired fork (the pull request's changes, divergence, tree, blob, log, branches) are answered from the repository with the fork's branch mapped to the kept head (`forks.rs` `Viewed`). Anything that writes or uses git on it (git over HTTPS, `git_access`, catch-up, land, `delete_branch`) makes it again first (`revive`: fork, then move its branch to the head) and schedules it to go again. Work never emits `pull.reopened` today; the handler is ready for it. Script: `scripts/ops/fork-storage-test.mjs`. |
| R3 | Built | Credentials g1t uses itself: TTL 3,600 s, reused for 50 minutes (isolate and KV, key `cred2:<key>:<scope>:internal`). `git_access` hands out its own: TTL 300 s, reused 180 s (`…:handout`); `refs_open` still uses 300 s. Every internal path (land, catch-up, mirrors, branch listing, commits, deleting a branch) now reuses kept credentials instead of minting each time. The remote is worked out as `https://<account>.artifacts.cloudflare.net/git/<namespace>/<name>.git` (the documented format, `api/git-protocol`), learned per namespace from the first `info()` an isolate makes, which runs alongside `createToken` and so costs no time; after that a mint is `get` and `createToken`. Optional `ARTIFACTS_REMOTE_BASE` skips even the first `info()`. |
| R4 | Built | Pushes are read as they arrive (`request.stream()`) and walked by `pack_limits::PackSizer` (each object inflated into a 32 KiB window and thrown away): an object over 32 MB (a delta measured by the object it makes), or a push taking the repository and its forks (`stored_bytes`) past `REPO_STORAGE_LIMIT_BYTES` (950 MB), is declined with `ng` lines and `remote:` text; a repository already at the limit is refused at the push's `info/refs` in plain text. Up to 24 MiB is kept, scanned and sent on as one copy, not three. Past 24 MiB push protection cannot read the push, so it is declined (`LARGE_PUSHES=refuse`, failing closed) with a command to push in parts, the 100 MB network limit named; `LARGE_PUSHES=unscanned` streams it to the store instead, still size-checked (a violation ends the stream before the pack's checksum, so the store keeps nothing). A pack too large for the scanner to inflate (48 MB inflated) is declined the same way instead of let through. Landing streams: upload-pack's side-band answer is taken apart chunk by chunk (`pack_limits::Sideband`) straight into the receive-pack body. |
| R5 | Built | `resilience.rs` sorts errors into rate limited, transient (`INTERNAL_ERROR`, `UPSTREAM_UNAVAILABLE`, `*_IN_PROGRESS`, no code, HTTP 5xx) and permanent. Binding reads, `get`, `info`, `createToken`, `create` and `delete` try up to 3 times with exponential backoff and jitter (80 ms base, 400 ms for rate limits, 2 s cap); `fork` and every receive-pack never retry. Git reads (`info/refs`, upload-pack) retry on 429 and 5xx. Per isolate, each namespace has a breaker that opens after 5 transient failures in a row, for 10 s, then lets one probe through. Busy answers reach git as 429 (rate limited) or 503, with `Retry-After: 5`; the site's read RPCs (`tree`, `blob`, `log`, `branches`, `blame`, `compare`) answer an `Outcome` failure saying the git storage is busy; other RPCs answer 503 with the same words. Health is counted by the minute (`store_health`) and served by the `store_health { minutes }` RPC; status.g1t.sh lists **Git storage** through a new `REPOS` service binding (down: 25% or more of at least 5 calls failed, or the breaker refused calls; degraded: rate limited, or a mean call over 1.5 s). |
| R9 | Built | `log(branch)`, `branches()` and `read_file(ref, path)` are kept in the colo cache under the repository's `refs_version` (5 minutes at most, and only while `refs_cache::usable`), and by commit hash for good; a log by branch also fills the by-hash entry; `readCommit` (parents) is kept for good. Read RPCs open repositories through `read_git`, which sets the version. |
| R10 | Built in repos; work unchanged | `divergence` works out the target's side once per target head per isolate (`coalesce.rs`: the head under the refs version, then the history by hash, kept 60 s), and what the target changed between two trees once per pair (10 minutes). `readCommit` and logs by hash come from the cache. Work's fan-out (`after_push`, up to 100 pull requests) is unchanged: its 100 `divergence` calls now cost one walk of the target instead of 100. |
| R7 | Built; the namespaces are yours to make | `shards.rs`: bindings named in `ARTIFACTS_NAMESPACES` (JSON, binding → namespace; `ARTIFACTS` → `g1t` always there), a repository's namespace kept in its `store` column as `<namespace>/<key>` (no prefix means the `ARTIFACTS` namespace, so every existing key reads the same), forks always in their repository's namespace. **Placing** (`Placement::choose`, loads from `namespaces.rs`): among `ARTIFACTS_NEW_REPOS`, the healthy namespaces (bound, taking writes, not failing, under `ARTIFACTS_NAMESPACE_LIMITS`' `max_repos`, busiest minute under 70% of the 12,000-a-minute limit) within 100 repositories or 5% of the emptiest, spread by an FNV hash of the id; loads are read (one D1 query each for the registry and `store_health`, kept a minute) only when there is more than one to choose from. **Moving** (`moves.rs`): `move_repository` or `scripts/ops/artifacts-namespaces.mjs move` queues one; the hourly sweep pauses writes, copies every ref of the repository and its working copies over git (one streamed upload-pack into one receive-pack each), switches every `store` key in one batch, and deletes the old copies after 7 days. **EU residency**: identity's `workspaces.data_residency`, set by an owner in the workspace's settings (shown only once `storage_options` says an EU namespace takes repositories), read by the repos service at creation only while `ARTIFACTS_EU_NAMESPACE` is set; an EU workspace's repository goes to that namespace or is not made. **Health and limits**: `namespaces` RPC and `scripts/ops/artifacts-namespaces.mjs`. Nothing changes until bindings and variables name new namespaces. See "R7: sharding, moves and EU residency" below. |
| R8 | Built | `crates/runner/src/clone.rs`: every sandbox clones at `--depth=1` (a full g1t clone took 5.4 s, depth 1 took 3.8 s). Work that merges (catch-up, the merge queue, merge checks, a review's diff) deepens 50, 500, then 5000 commits until the two sides share one, and fetches everything only as the last resort (`share_history`). `G1T_CLONE_DEPTH` (0 or `full` for everything) and `G1T_CLONE_FILTER=blob:none` change it per runner. |
| R6 | Built; the bucket must exist before it deploys | `pack_cache.rs`: an upload-pack POST with wants and no `have` or `shallow` lines (a fresh clone, the sandboxes' `deepen 1` ones included), uncompressed and at most 1 MiB, is keyed `packs/<repo id>/<refs_version>/<sha256>` over the request normalized: protocol v2 capabilities without `agent=`/`session-id=` and its arguments, each sorted and deduplicated; v0/v1 wants sorted, the first want's capabilities split off, sorted and without `agent=`, then `deepen`/`filter` lines, a flush and `done`. Only while `refs_cache::usable` (the version known, and no push credential out of g1t's hands), so never across a refs change. Looked up after authorization, alongside the free-workspace limits and the kept refs answer; a hit streams from the bucket (`Server-Timing` `pack;desc=hit`). A miss streams the store's 200 to git through a tee that copies it to a fill in `ctx.wait_until` (at most 5 MiB queued between them, 2 fills per isolate, one per key): under 5 MiB it is one `put` once it all arrived; larger, 5 MiB multipart parts completed only after the last part and a check that it is one whole side-band pack (well-formed pkt-lines, `PACK` on channel 1, no `ERR` or channel 3, a closing flush). Over 200 MB, a queue that falls behind, git going away or the store's stream failing lets the fill go and aborts the upload; nothing partial can be read. Meters `pack_cache.hit` (with the bytes served) and `pack_cache.miss` (counted with `record`, bytes added at the end), neither an operation by default; a hit records no `git.fetch`. Storage is behind the `PackStore` port, whose adapter puts the shared `BlobStore` (`crates/blobstore`) behind it: R2 hosted (`GIT_PACKS`, bucket `g1t-git-packs`, lifecycle: packs deleted after 7 days, unfinished uploads after 1), or with `PACK_STORE=s3` the S3 bucket `PACK_S3_BUCKET` names (self-hosted: RustFS's `g1t-git-packs`, with the same lifecycle rule, put by the compose file's `storage-setup`; `node services/repos/dev/clone-check.mjs --s3` checks it). With neither, nothing is kept. |
| R11 | Built; not yet deployed | Nightly `git bundle` backups to the `g1t-backups` R2 bucket, and a restore drill. Migration `0013_backups.sql` (`repo_backups`, and an `operation_mapping` row). See "R11: backups and the restore drill" below. |
| R12 | Built; the host is yours to make | `scripts/ops/restore-to-gitstore.mjs` rebuilds every repository from its bundle chain into the git store (`deploy/self-host/gitstore`, now with namespaced keys, `<root>/<namespace>/<name>.git`, and `GITSTORE_READ_ONLY=1`), on the host or over its API, and later lists and reconciles what the fallback took. `fallback.rs`: with `GIT_FALLBACK_URL`, `GIT_FALLBACK_SECRET` and `GIT_FALLBACK_NAMESPACES` set, a namespace's `GitStore` calls go to the git store's API instead of the Artifacts binding (same metering, retries and breaker, its own health as `<namespace>@fallback`), read-only unless `GIT_FALLBACK_WRITES=allow`: writes are refused before they are asked, and say so in words; kept ref listings and packs are not used, nor backups cut. status.g1t.sh shows Git storage degraded meanwhile. See "R12: the fallback store and the outage runbook" below. |

### R1: reading `scripts/ops/artifacts-usage.mjs`

```sh
export CLOUDFLARE_API_TOKEN=<token with Account Analytics: Read (and D1: Read, or set CLOUDFLARE_D1_TOKEN)>
node scripts/ops/artifacts-usage.mjs            # last 31 days, a table
node scripts/ops/artifacts-usage.mjs --days 7 --json > usage.json
ARTIFACTS_NAMESPACE=g1t node scripts/ops/artifacts-usage.mjs
node scripts/ops/artifacts-usage.mjs --hours 2026-10-07   # one UTC day, hour by hour
```

It prints, per day, Cloudflare's `pull`, `push`, `create`, `fork` and `delete` events and its
errors beside g1t's fetch and push meters and `git_operations`, then, for each Cloudflare event,
the ratio Cloudflare ÷ g1t for several combinations of meters. Read it like this:

- `pull` ≈ `git.fetch + internal.git.fetch` (ratio 1.00): Cloudflare counts one pull per
  upload-pack fetch, as assumed. Keep the default mapping.
- `pull` ≈ a combination with `git.ls_refs` or `git.info_refs`: listing refs counts too. Set
  `cost_operations` for those meters to 1 (`set_operation_mapping`), and decide whether
  `billable_operations` follows (cost pass-through says yes).
- Every ratio well under 1: Cloudflare counts per clone or fetch session, not per request.
  Ratios over 1: something reaches Artifacts that g1t does not meter, or metered counts were
  lost before they were written. Sandboxes are not it: every sandbox but a backup's clones,
  fetches and pushes through g1t's git endpoints (see "2026-10-07: where the gap came from").
- Only days after the meters were deployed compare; before that only `git_operations` exists.
- A fix that lands mid-day is judged with `--hours DAY`: Cloudflare's operations and errors
  against `git_operations` hour by hour, then the day's errors by message and repository.
- Binding calls do appear: Cloudflare's events include `read` and `token_create` actions (and
  `namespace_*`) besides the five documented ones. If Cloudflare says they are billed, map the
  `binding.*` meters in `operation_mapping`.

A global API key works in place of the token: `CLOUDFLARE_API_KEY` with `CLOUDFLARE_EMAIL`
(both scripts).

**Result, 2026-10-06** (31 days; g1t's meters cover only 2026-10-06, the day they shipped):

| Cloudflare event | 31 days | 2026-10-06 | g1t's meters, 2026-10-06 |
| --- | --- | --- | --- |
| `read` | 137,225 | 107,616 | `binding.get` 85,206, `read_file` 49,846, `read_tree` 9,208, `read_blob` 4,964, `log` 2,798 |
| `pull` | 646 | 101 | `git.fetch` 29, `git.ls_refs` 26, `git.info_refs` 426 (+ 129 internal) |
| `push` | 385 | 10 | `git.receive_pack` 3 |
| `token_create` | 2,721 | 338 | `binding.create_token` 34 |
| `fork` / `create` / `delete` | 96 / 14 / 8 | 2 / 0 / 0 | |
| errors | 699 (688 client) | 476 client | |

- `pull` is not one per upload-pack fetch: 101 pulls against 29 fetches on the one day both
  exist. Over 31 days `pull` ≈ fetch + ls-refs + info/refs (ratio 1.06), so listing refs likely
  counts as a pull. Not yet changed in `operation_mapping`: one day of meters is too little, and
  re-check after a week before setting `cost_operations` for `git.info_refs` and `git.ls_refs`.
- `read` is the open question that matters. If reads are billed as operations at $0.15 per
  1,000, today's demo-scale traffic alone is about 3.2 million a month (~$480). Ask Cloudflare
  (Q1) before 2026-10-14. Either way the volume is mostly waste: every repos call opens a handle
  with `get` even when the answer is cached, and the object cache may not be hitting (no hit/miss
  meter yet). Done on 2026-10-06: the handle's `get` waits for the first call that needs the
  store (an answer from a cache, or `branches` over git, costs none); objects named by hash are
  kept in the isolate (16 MB, oldest out first) ahead of the Cache API, and every look is
  metered (`cache.memory_hit`, `cache.edge_hit`, `cache.miss`); issue and comment events start
  nothing and read nothing when the synced `workflows` table has no workflow listening. Next:
  read `cache.edge_hit` against `cache.miss` after a day; if the Cache API never hits from a
  Worker reached only by service bindings, put objects in KV instead. Still to do: caller
  attribution in the meters.
- Client errors (576 on 2026-10-06, 985 on 2026-10-07) are all `read rejected`: a binding
  `readFile` for a path that is not a file at that ref (missing, or a directory). Tested on
  2026-10-07: four anonymous views of a missing file on a public repository made four, a real
  file none. Nearly all came from crawlers (ClaudeBot, GPTBot) on public `blob/<sha>/…` pages
  and pull requests' working copies, hour after hour with no git at all. The site answers 404
  correctly; each is one store read, and a miss is not cached. They are not operations.
  `--hours DAY` lists them by message and repository.

**2026-10-07: where the gap came from.** Cloudflare counted 581 operations (pull 535, push 39,
create 3, fork 4) against g1t's 458 (`git.fetch` 417, `git.receive_pack` 33, ...). The suspicion
was that agents' sandboxes clone and push straight to the store with `git_access` credentials.
They do not. Read from the code:

- Every sandbox's remote is `https://g1t.sh/<path>.git` (`services/runner/src/index.ts`,
  `bump.ts`; Actions' checkout from `services/actions/src/plan.rs`), with a run credential passed
  per command (`crates/runner/src/main.rs` `auth_option`, `clone.rs`). Agent runs, answers,
  checks, reviews, plans, updates, the merge queue, merge checks, bumps, deploys and workflow
  jobs all clone, fetch, deepen (`share_history`) and push through `git_http`, metered as
  `git.info_refs`, `git.ls_refs`, `git.fetch` and `git.receive_pack`. Git an agent runs itself
  in its sandbox has the same remote and no other credential, so it is metered the same way.
- `git_access` has no caller that is deployed: only `crates/sshd`, whose `/_internal/ssh/*`
  endpoints do not exist yet. **SSH must not ship until its git is metered.** Its bridge
  (`crates/sshd/src/git.rs`) talks to the store directly with the handed-out token, so nothing
  in `git_http` sees it: every SSH clone, fetch and push would be an operation Cloudflare bills
  and g1t never counts. Two ways to close it, either is enough:
  1. Report, as backups do: when a session ends, sshd posts the service, the repo and the bytes
     each way to a repos RPC that records `git.info_refs` plus `git.fetch` or
     `git.receive_pack` against the repo's store key (`meters::record`, like `backups.rs`
     `meter_fetch`). A session that dies before reporting is lost, so count the operation when
     `git_access` hands out the token and add only the bytes from the report.
  2. Send the bridge through `git_http` instead of the store, with the user's identity, so SSH
     is metered, cached and protected (branch and push protection) like HTTPS. This also closes
     M15 for SSH.

  Building this is not small today: the Worker side (`/_internal/ssh/user` and
  `/_internal/ssh/access`) does not exist either, so it belongs with shipping SSH.
- The one sandbox that reads the store directly is a nightly backup (`backups.rs`
  `store.handout`): its runner reports the clone with `fetched_bytes`, metered as
  `internal.git.info_refs` and `internal.git.backup_fetch` (g1t's cost, never a workspace's).
  A clone that fails before reading anything, or a sandbox that dies without reporting, is not
  metered.

Two things were wrong instead, both fixed:

1. **Counts left in memory.** An isolate wrote its counts only when a request found the last
   write 5 s old. Whatever was counted since stayed in memory until the next request on that
   isolate, and was lost if none came: when the isolate went idle, or a deploy replaced it. A
   clone is `info/refs`, `ls-refs` and `fetch` within a second, so its last request, the fetch
   (the one that is an operation), was the one most often stranded. Now a request that counts
   something before a write is due plans that write in its own `wait_until`, waiting until it is
   due (`meters::plan_flush`, `flush_after`): still one write per isolate every 5 s at most, and
   nothing on the request path. Only an isolate that dies outright loses its last few seconds.
2. **Working copies counted for nobody.** A pull request's working copy has the path
   `pulls/<pull id>`, so everything asked of it (an agent cloning it and pushing to it, checks
   and reviews cloning it, catching up, landing's fetch from it, making it with `fork`, removing
   it with `delete`) was counted for a workspace called `pulls`, which nobody is charged as. The
   counts now go to the workspace of the repository it came from, looked up when they are written
   (one query per write, kept 10 minutes), in `artifacts_meters.workspace` and `git_operations`
   alike. `artifacts_meters.repo` keeps the working copy's own name. The free-workspace limits
   still go by the path asked for, so requests to a working copy are counted but never slowed.

What can still differ from Cloudflare's count: an isolate that dies with counts in memory; a
store request that fails on g1t's side before it is metered; an `info/refs` GET retried after
the store refused a kept credential (asked twice, metered once; not an operation by default);
backups' unreported clones; and whatever Cloudflare counts that g1t does not ask (its `pull` may
include ref listings, still open). Compare again with `scripts/ops/artifacts-usage.mjs` a day
after this deploys. No migration: `operation_mapping` is unchanged.

### R2: running and reading `scripts/ops/fork-storage-test.mjs`

```sh
export CLOUDFLARE_API_TOKEN=<token: Artifacts edit, Account Analytics read>
node scripts/ops/fork-storage-test.mjs schema        # which Artifacts analytics datasets exist
node scripts/ops/fork-storage-test.mjs run --keep    # namespace g1t-storage-test: 100 MB repository, 5 forks
node scripts/ops/fork-storage-test.mjs measure       # again tomorrow (storage is billed as a daily peak)
node scripts/ops/fork-storage-test.mjs cleanup       # delete the 6 repositories
```

It works only in its own namespace, through Cloudflare's REST API, never through g1t. Read:

- Fork timing and response: a fork that returns in well under a second, with `objects` near the
  source's count, is metadata (sharing). Seconds per fork, growing with size, suggests copying.
- Storage figures (any dataset `schema` lists besides `artifactsEventsAdaptiveGroups`): about
  100 MB after the forks means sharing; about 600 MB means each fork copied. The documentation
  lists no storage dataset today, so this may print nothing: then the next day's usage in the
  dashboard (Billing → Artifacts storage) is the measure, and the question stays with Cloudflare (Q2).
- `events`: `storageLimitReached` or other errors during the test.

Either way R2 retires forks; the answer decides `FORK_RETENTION_DAYS` (shared: a week is fine;
copied: shorten it to 1 or 2 days and ask Cloudflare to raise the 1 TB account limit).

**Result, 2026-10-06: forks are stored and billed as copies.** A 100 MB source took 57 s to
push; each of 5 forks took 4–6 s. The storage dataset (`artifactsStorageAdaptiveGroups`,
`max.repositorySizeBytes`) gave every fork the source's full 105,582,592 bytes: about 633 MB for
the six, not about 106 MB. Whatever Artifacts shares underneath, storage billing and the 1 TB
account limit see full copies. So:

- `FORK_RETENTION_DAYS` is 1 in production (changed 2026-10-07).
- g1t meters a workspace's storage once per repository (`stored_bytes`), so an open pull
  request's working copy is Cloudflare cost g1t absorbs: about $0.05 a month per 100 MB per open
  pull request. Small now; decide whether open working copies count toward a workspace's
  storage before agent pull requests reach thousands.
- Ask Cloudflare whether forks share objects physically, and for a higher account limit.

Also found while testing (fixed in `git_http.rs`): the store answers a protocol v2 fetch that is
still negotiating, and whose `have`s it does not know, with `acknowledgments`, `NAK`, then a pack.
git refuses that ("expected no other sections to be sent after no 'ready'"). g1t now ends such
an answer after the acknowledgments with a flush, and the client negotiates again. Report it to
Cloudflare.

### R7: sharding, moves and EU residency

Every piece is built and off. Production behaves exactly as before until the namespaces below are
made, bound and named: with only `ARTIFACTS` bound and `ARTIFACTS_NEW_REPOS` empty, new repositories
go to `g1t`, nothing extra is read from D1 when one is made, and identity is never asked about
residency.

| Variable (`services/repos/wrangler.jsonc`) | What it does |
| --- | --- |
| `ARTIFACTS_NAMESPACES` | JSON, binding to namespace. `ARTIFACTS` is always there (`g1t` unless named). A name without a binding is logged and left out. |
| `ARTIFACTS_NEW_REPOS` | Comma-separated namespaces new repositories go to. Empty: `g1t`. A name that is not bound is passed over. |
| `ARTIFACTS_EU_NAMESPACE` | The namespace EU workspaces' new repositories go to. Unset: residency is never read, and the setting is never offered. |
| `ARTIFACTS_NAMESPACE_LIMITS` | Optional JSON, `{"g1t": {"max_repos": 50000}}`. A namespace at its limit takes no new repositories while another can. |

**Placing a new repository** (`shards.rs` `Placement::choose`, loads from `namespaces.rs`). For a
workspace that keeps its data anywhere: among the namespaces in `ARTIFACTS_NEW_REPOS`, the healthy
ones (bound, taking writes, not failing, under `max_repos`, their busiest minute in the last hour
under 70% of the 12,000-a-minute control-plane limit), and of those the ones within 100 repositories
or 5% of the emptiest, spread by the id's FNV hash. If none is healthy, the usable ones the same way
(never a read-only one); if none is usable, `g1t`. Failing means this isolate's breaker is open, or a
quarter of at least 5 calls in the last 5 minutes failed (`store_health`). Loads cost two D1 queries
(the registry grouped by namespace, `store_health` for the last hour), kept a minute per isolate, and
are read only when more than one namespace could take the repository. A pull request's working copy
always goes where its repository is. For an EU workspace: `ARTIFACTS_EU_NAMESPACE` if it is bound and
takes writes; otherwise the repository is not made, and the person is told why (409, "This workspace
keeps its data in the EU, and EU storage cannot take new repositories right now."). It is never placed
elsewhere.

**EU residency, as a workspace sees it.** Identity keeps `workspaces.data_residency` (NULL for
anywhere, `eu`), changed by an owner with `set_workspace_residency` and read with
`workspace_residency`; a change is audited as `workspace.residency_changed`. The workspace's
**Settings** page shows **Data residency** only when the repos service's `storage_options` says
`euAvailable` (an EU namespace is bound and takes writes), or when the workspace already chose the EU.
It applies to repositories made after it is saved, by any path that creates one (the site, the API,
push to create, imports). Existing repositories stay where they are until moved. A transfer keeps a
repository's store key, so a repository transferred into an EU workspace stays where it was: move it.
The guide is `apps/docs/src/content/docs/guides/workspaces.md`, "Data residency". Not in the public
API or MCP yet.

**Moving a repository** (`moves.rs`, migration 0014). It keeps its id, path, rows and history; only
`store` changes.

```sh
node scripts/ops/artifacts-namespaces.mjs move acme/rocket g1t-us-1   # queues it (one INSERT)
node scripts/ops/artifacts-namespaces.mjs moves                       # queued, moving, moved, failed, cleaned, diverged
```

Services can queue one with the `move_repository { repo_id, namespace, requested_by? }` RPC, which
checks it first, and list them with `repository_moves { limit? }`. The hourly sweep (`23 * * * *`)
runs one queued move per hour:

1. Writes to the repository and every working copy of its pull requests are paused
   (`writes_paused_until`, 20 minutes at most, so a move that dies releases them on its own). A push
   waits up to 20 seconds, polling every 2, and then is told: "acme/rocket is paused for maintenance
   (moving to g1t-us-1); changes to it wait a few minutes. Try again shortly." Merges, catch-ups,
   commits from the web, branch changes, mirror catch-ups, new pull request working copies and push
   credentials for sandboxes wait the same way. Removing a working copy waits for the next sweep.
2. Push credentials already handed out reach the store directly, so the move waits for
   `refs_open_until` to pass (up to 7 minutes in the run; longer goes back in the queue), then 5
   seconds for pushes in flight.
3. Each one is made in the new namespace under the same name, and every ref is copied with one
   upload-pack from the old copy streamed into one receive-pack to the new (`land.rs` `copy_refs`),
   never held in memory. Until both list the same refs and the old one did not move during the copy,
   only what changed is copied again, three rounds at most. Removed working copies have nothing to
   copy: their rows follow.
4. One D1 batch points every row at its new key, moves its `refs_version` (so no kept ref listing,
   pack or versioned read is used again), lifts the pause, and records each copy's refs in
   `repo_move_copies`.
5. After 7 days the sweep deletes each old copy whose refs still say what was copied. One that
   changed (a push that slipped past the pause and landed in the old copy) is kept, and the move is
   marked `diverged` with the keys; push its refs to the new copy by hand. While an old copy is kept,
   its name stays taken, so no new repository adopts it.

A move that fails before step 4 deletes what it made in the new namespace, lifts the pause, and is
tried again in the next sweep, three times in all. The copy is metered like landing
(`internal.git.fetch` and `internal.git.receive_pack`, billable 1 each to the repository's workspace
by default), plus `binding.create`. A copy is bounded by the cron's wall time (15 minutes), which
streams well past the 1 GB repository limit. Not verified against Artifacts yet: run the first move on
a test repository and compare `git ls-remote` of both copies.

**Health and limits.** `namespaces` (RPC) answers each bound namespace's repositories, working copies
and stored bytes from the registry; its busiest minute in the last hour against 12,000 a minute;
calls, errors and rate limits in the last hour; whether it is failing, on the fallback, writable,
default, EU, and takes new repositories; and its `max_repos`.

```sh
node scripts/ops/artifacts-namespaces.mjs               # a table, and a line for anything to act on (exit 1 then)
node scripts/ops/artifacts-namespaces.mjs --cloudflare  # also Cloudflare's event counts and each namespace's jurisdiction
node scripts/ops/artifacts-namespaces.mjs --json
```

It reads `services/repos/wrangler.jsonc` for what is configured, so it says what the next deploy
will do: a namespace named but not bound or not made, an EU namespace made without the EU
jurisdiction, one past 70% of the limit or at its `max_repos`, one rate limited, one served from the
fallback.

#### What you must create (R7)

None of this is needed until one namespace is not enough, or an EU customer asks.

1. Make the namespaces, with a token that can edit Artifacts. A namespace's jurisdiction is fixed when
   it is made, and is not part of the binding (Wrangler's schema has only `binding`, `namespace` and
   `remote`):

   ```sh
   # A US shard, unrestricted like today's g1t, and an EU one.
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/1e6f2cffa3f445920836e8ebe446bb58/artifacts/namespaces" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     --data '{"namespace":"g1t-us-1"}'
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/1e6f2cffa3f445920836e8ebe446bb58/artifacts/namespaces" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     --data '{"namespace":"g1t-eu","jurisdiction":"eu"}'
   node scripts/ops/artifacts-namespaces.mjs --cloudflare   # both listed, g1t-eu with jurisdiction eu
   ```

2. Bind them, and deploy `g1t-repos` (migrations 0014 and identity's 0026 go first, as the deploy tool
   always does). Nothing is placed in them yet:

   ```jsonc
   "artifacts": [
     { "binding": "ARTIFACTS", "namespace": "g1t" },
     { "binding": "ARTIFACTS_1", "namespace": "g1t-us-1" },
     { "binding": "ARTIFACTS_EU", "namespace": "g1t-eu" }
   ],
   "vars": {
     "ARTIFACTS_NAMESPACES": "{\"ARTIFACTS\":\"g1t\",\"ARTIFACTS_1\":\"g1t-us-1\",\"ARTIFACTS_EU\":\"g1t-eu\"}",
     "ARTIFACTS_NEW_REPOS": ""
   }
   ```

3. Name them, and deploy again: `"ARTIFACTS_NEW_REPOS": "g1t,g1t-us-1"` spreads new repositories over
   both (the emptier first), and `"ARTIFACTS_EU_NAMESPACE": "g1t-eu"` puts **Data residency** in every
   workspace's settings. Optionally `"ARTIFACTS_NAMESPACE_LIMITS": "{\"g1t\":{\"max_repos\":50000}}"`.
4. Move a test repository there and back (`move`, then `moves` after the next :23), and compare both
   copies with `git ls-remote`.

More shards later are the same steps (`g1t-us-2`, `ARTIFACTS_2`). Deploy a binding before naming its
namespace anywhere; a name that is not bound is passed over, never used.

### R11: backups and the restore drill

Every repository whose refs moved is bundled once a night and kept outside the git store, so a
repository can be rebuilt without Artifacts. The flow is in `crates/contracts/src/backups.rs`;
the chain, the manifest and the record are in `services/repos/src/backups.rs`.

1. **Queued.** At 02:53 UTC (`53 2 * * *` in `services/repos/wrangler.jsonc`) the repos service
   queues the repositories that are due, at most `BACKUPS_PER_NIGHT` (200), the longest since
   their last backup first. A repository is due when it has never been backed up, when its
   `refs_version` went past the one its last backup was cut at, or when a credential that can
   push was handed out (`refs_open_until`) after that backup's clone began: a push with such a
   credential does not move `refs_version`. Deleted repositories, retired working copies and
   pull request working copies (`pulls/…`, whose heads end up in their repository as
   `refs/pull/<id>/head`) are not backed up.
2. **Claimed.** The runner's five-minute sweep claims `BACKUPS_PER_SWEEP` (4) at a time, with at
   most `BACKUPS_RUNNING` (6) running (`claim_backups`), and starts a sandbox for each in
   `MODE=backup` (`crates/runner/src/backup.rs`). The sandbox is given the job's id and a token
   for it, nothing else; the repos service keeps only the token's hash. It has a 60-minute time
   cap. Its time is g1t's: it is not metered to the workspace.
3. **Cut.** The sandbox asks for its job (`POST api.g1t.sh/backups/{job}/spec`, the token in
   `x-g1t-backup-token`) and gets a read-only credential for the repository in the store (a
   `git_access`-style handout, 5 minutes), the bundle's kind, and the commits the last bundle
   ended at. It clones with `--mirror` (every ref, never shallow), writes those commits as refs
   of its own, and runs `git bundle create --all --not <them>`, then `git bundle verify`.
   When the clone has exactly the refs of the last backup, or git finds nothing new to bundle
   (a branch deleted, a ref moved to a commit already kept), no bundle is cut and only the refs
   are recorded.
4. **Sent.** The bundle goes in 32 MiB parts (`PUT /backups/{job}/parts/{n}`), which the API
   passes to the repos service and the repos service to an R2 multipart upload; then
   `POST /backups/{job}/complete` with every ref, the size, the SHA-256 and the parts. A failure
   is `POST /backups/{job}/fail`; a sandbox that dies is failed by the runner. A job is tried 3
   times a night; one running past 3 hours is queued again.
5. **Recorded.** The manifest gains the entry, and `repo_backups` the refs version the clone began
   at, so a push during the backup leaves the repository due the next night.

Storage, through the `BlobStore` port in `crates/blobstore` (the adapters packages already used):
the `BACKUPS` binding (bucket `g1t-backups`) with `BACKUP_STORE=r2`; any S3-compatible store with
`BACKUP_STORE=s3` and `BACKUP_S3_BUCKET` (self-hosted: RustFS). Without either, backups are off and
the nightly cron does nothing.

```text
backups/<repo id>/manifest.json
backups/<repo id>/20261006T025300Z-full.bundle
backups/<repo id>/20261007T025302Z-incr.bundle
```

The manifest (version 1) lists `chain`, oldest first, and `previous`, the chain before it. Each
entry has `id`, `kind` (`full` or `incremental`), `key` (null when only refs moved),
`created_at`, `refs_version`, `refs` (every ref and `HEAD` once it is applied), `prerequisites`,
`size` and `sha256`. The first backup is full; the next ones are incremental, their
prerequisites the last entry's tips, until the chain holds `BACKUP_FULL_EVERY` (30) incremental
ones, when a full one starts a new chain. The chain before that is kept until the next full one
replaces it, so the oldest backup kept is about two chains old. Backups of purged repositories
are removed the night after (50 a night).

Meters: the clone counts as `internal.git.info_refs` and `internal.git.backup_fetch` with the
bytes it read, on the repository (they show in `artifacts_usage` and
`scripts/ops/artifacts-usage.mjs`). `operation_mapping` has `internal.git.backup_fetch` at 1 for
`cost_operations` and 0 for `billable_operations`: an operation on g1t's bill, never on the
workspace's. The credential's `binding.create_token` is metered as before.

**The restore drill** (read-only against production: SELECTs on `g1t-repos`, reads of
`g1t-backups` through Wrangler, `git ls-remote` of the live repository):

```sh
node scripts/ops/backup-restore-drill.mjs                      # a repository unchanged since its last backup
node scripts/ops/backup-restore-drill.mjs --repo acme/rocket   # this one
G1T_USER=you G1T_TOKEN=g1t_... node scripts/ops/backup-restore-drill.mjs --repo acme/private-thing
```

It downloads the manifest and each bundle of the chain, checks each against its size and SHA-256,
`git bundle verify`s it, fetches it into a new bare repository without following tags, sets every
ref to what the last entry says (and removes the rest), points `HEAD` at the branch at its commit,
and runs `git fsck --connectivity-only`. Then it compares every ref with the manifest and with
`git ls-remote` of the live repository and prints each difference. Exit 0: every ref matches;
1: a difference; 2: it could not run (a bundle that does not match its manifest is this). Picked
at random, the repository is one whose refs have not moved since its last backup, so any
difference is the backup's. Run it after the first night, then monthly, and after any change to
`backups.rs` or `backup.rs`. `--bundles <dir>` reads a local copy of the bucket instead
(self-hosted: `aws --endpoint-url <S3_ENDPOINT> s3 sync s3://g1t-backups <dir>`), with `--repo-id` and `--live <url or path>`.
`npm run test:ops` runs it against bundles cut with git.

**A real restore into the store**, as it can be done today:

1. Run the drill for the repository with `--keep`. It prints where the restored copy is
   (`…/restored.git`). Go on only if every ref matches the manifest; differences from the live
   repository are what the restore is for.
2. Tell the workspace, and stop the repository's agents and merge queue for the time.
3. If its default branch is protected, turn protection off in the repository's settings for the
   push: a push that changes a protected branch is declined.
4. From the restored copy, push every ref as an owner, with an access token that has
   `code:write`:

   ```sh
   cd /tmp/g1t-drill-…/restored.git
   git -c "http.extraHeader=Authorization: Basic $(printf 'you:g1t_...' | base64)" \
     push --force https://g1t.sh/acme/rocket.git 'refs/*:refs/*'
   ```

   It goes through the git door like any push: size limits, push protection (pushes over 24 MiB
   per `LARGE_PUSHES`) and the audit log apply, and the refs version moves, so the next night
   backs the repository up again. `--force` rewinds refs that went wrong; refs the live
   repository has that the backup does not are left alone (`git push --mirror` would delete
   them).
5. Turn protection back on, and run the drill again: every ref now matches the live repository.

When the repository is gone from the store itself (its key answers not found), there is still no
operator call to make an empty repository under an existing row's key in Artifacts. Until there is,
the fallback store can serve it from its backup (R12).

To deploy: make the bucket (`npx wrangler r2 bucket create g1t-backups`, a setup step of `repos`
in `deploy/stack.jsonc`), then migration 0013, then `g1t-repos` (the `BACKUPS` binding and the
new cron), `g1t-api` (the `/backups/` door), and `g1t-runner` (a new image: the `backup` mode).
Until the runner is out, queued backups wait; nothing fails. Set `BACKUPS_PER_SWEEP` to `0` on the
runner to stop starting them.

What is not covered: a pull request's working copy while its pull request is open (its head is
kept in the repository only once the working copy is retired), and anything that is not a git
ref (issues, pull requests and the rest live in D1, which has its own Time Travel). Every backup
clones the whole repository, so a night reads each changed repository in full from the store;
incremental bundles save storage, not reads.

### R12: the fallback store and the outage runbook

A cold fallback, not a hot standby: when Artifacts is down for a namespace, g1t can serve that
namespace's repositories from the self-hosted git store (`deploy/self-host/gitstore`), rebuilt from the
nightly backups (R11). Reads work from the last backup; writes wait, unless you choose otherwise. It is
switched by configuration, per namespace, in seconds and without a build.

| | Kept restored nightly (recommended) | Restored when needed |
| --- | --- | --- |
| Data served | As of the last backup: at most about a day old | The same |
| Time to switch | Minutes: a last restore pass, then one secret | Download plus restore: about an hour per 100 GB of bundles, 4 at a time |
| Cost | The host, always on | The host only while it is needed, if you make it then |

**The pieces.**

- `scripts/ops/restore-to-gitstore.mjs restore` rebuilds each repository from its chain as the restore
  drill does (each bundle checked against its size and SHA-256, `git bundle verify`, fetched in order,
  refs set to the last entry's, `git fsck --connectivity-only`) into `<root>/<namespace>/<name>.git`,
  configured as the git store configures its own, with a `g1t.json` that records what it was restored
  from. A second run skips repositories already restored from the same last backup, so a nightly run
  only does what changed. `--into <root>` writes on the host; `--gitstore <url>` (with `GITSTORE_SECRET`)
  goes through the store's API and git, for a store that is not read-only. `--bundles <dir>` reads a
  local copy of the bucket; `--offline` takes the repositories from the manifests in it, so the host
  needs no database access (a repository moved between namespaces since its last backup is restored
  under its old namespace until the next backup records the new one).
- The git store (`deploy/self-host/gitstore/server.mjs`) now takes namespaced keys
  (`g1t-us-1/acme--rocket`, served at `/git/g1t-us-1/acme--rocket.git`, the shape Artifacts gives
  remotes) beside plain ones, and `GITSTORE_READ_ONLY=1` refuses pushes, write tokens, and making,
  forking or deleting repositories.
- `services/repos/src/fallback.rs` and `store.rs`: for each namespace in `GIT_FALLBACK_NAMESPACES`
  (`*` for all), the `GitStore` sends every call it would make on the Artifacts binding (`create`,
  `get`, `delete`, `info`, `createToken`, `log`, `readCommit`, `readTree`, `readBlob`, `readFile`,
  `fork`) to the store's API at `GIT_FALLBACK_URL` with `GIT_FALLBACK_SECRET`, and git's smart HTTP to
  its remotes. Calls keep their retries and breaker, counted as `<namespace>@fallback` in
  `store_health`, never as Artifacts' own health, and are not metered as binding calls (git requests
  still are). Credentials are kept apart from Artifacts' (`fallback:<key>`). Answers kept under a refs
  version (ref listings, packs, logs and files by branch) are neither used nor kept, since the
  fallback may be behind them; objects named by their hash are.
- Read-only, the default (`GIT_FALLBACK_WRITES` unset or `refuse`): a write is refused before it is
  asked. Git hears 503 with `Retry-After: 300` and "g1t's git storage is read-only while it
  recovers: clones, fetches and pages work, and pushes, merges and new repositories wait until it is
  back."; the site's reads work, and its writes fail with the same words. New repositories are placed
  in a namespace that still takes writes, if `ARTIFACTS_NEW_REPOS` has one. Backups are not cut from a
  switched namespace (they would record an older state). status.g1t.sh shows **Git storage**
  degraded: "Served from the backup store: reads work, pushes and merges wait".

**What does not work while switched.** Working copies of open pull requests are not backed up, so
their changes and branches do not read; working copies already removed read from their repository's
`refs/pull/<id>/head` as usual. Anything pushed after the last backup is not there until Artifacts is
back. Agent runs that only read work (their sandboxes clone from the fallback through handed-out
credentials); runs that push wait. Mirror catch-ups wait; pushes out to mirrors work.

#### The host

| Need | Why | What |
| --- | --- | --- |
| Outside Cloudflare | It is the exit if Artifacts, or the account, is the problem | A VM with a provider of your choice |
| Persistent disk | Repositories and a copy of the bucket live there; Containers' disk is ephemeral and at most 20 GB | Block storage or a local SSD that survives reboots |
| Disk size | Restored repositories about equal the newest full bundles; the bucket's copy holds up to two chains | 2.5 times the bucket's size; today 100 GB is ample, at 3,000 workspaces (about 250 GB stored, section 5) 1 TB |
| Near the repos Worker | Every read crosses to it; `g1t-repos` runs near D1 in WNAM | US West, for example Oregon. The EU namespace's fallback on a second, EU host, so EU data stays in the EU |
| HTTPS on a public name | Workers reach it with `fetch` | Caddy in front of port 8080, a name such as `fallback-git.g1t.sh` |
| Software | | Docker (the git store's image), or Node 24 and git; `rclone` |
| CPU and memory | `git upload-pack` for clones, restores 4 at a time | 4 vCPU, 8 GB |

**What it costs**, at list prices for such a host (check before buying): a 4 vCPU, 8 GB VM is about
$15 to $50 a month depending on the provider; block storage $0.04 to $0.10 per GB-month, so $4 to $10
a month for 100 GB today and $40 to $100 for 1 TB at launch scale. Reading the bucket costs nothing in
egress (R2 charges none) and a few cents a month in R2 operations for a nightly `rclone sync`. In all,
about $20 to $60 a month now and $60 to $150 at 3,000 workspaces, per host; the EU host only once there
is an EU namespace.

#### What you must create (R12)

1. The host above, with a DNS name and TLS.
2. An R2 API token that can only read `g1t-backups` (Cloudflare dashboard, R2, Manage API tokens:
   Object Read, that bucket), for `rclone` on the host:

   ```ini
   # ~/.config/rclone/rclone.conf on the host
   [r2]
   type = s3
   provider = Cloudflare
   access_key_id = <the token's access key id>
   secret_access_key = <its secret>
   endpoint = https://1e6f2cffa3f445920836e8ebe446bb58.r2.cloudflarestorage.com
   ```

3. The git store and its secret, read-only from the start:

   ```sh
   git clone https://g1t.sh/flagon-io/g1t.git /opt/g1t   # node, git and rclone installed
   openssl rand -hex 32 > /srv/gitstore.secret
   GITSTORE_ROOT=/srv/gitstore GITSTORE_PORT=8080 GITSTORE_URL=https://fallback-git.g1t.sh \
     GITSTORE_SECRET="$(cat /srv/gitstore.secret)" GITSTORE_READ_ONLY=1 \
     node /opt/g1t/deploy/self-host/gitstore/server.mjs     # as a systemd unit, or the image in deploy/self-host/gitstore
   # Caddyfile: fallback-git.g1t.sh { reverse_proxy 127.0.0.1:8080 }
   ```

4. The first restore, then every night after the backups (02:53 UTC) have run, say at 07:00 UTC:

   ```sh
   rclone sync r2:g1t-backups /srv/backups
   node /opt/g1t/scripts/ops/restore-to-gitstore.mjs restore --into /srv/gitstore --bundles /srv/backups --offline --jobs 4
   ```

5. Tell `g1t-repos` where it is, ahead of time. These change nothing until a namespace is named:

   ```sh
   cd services/repos
   echo https://fallback-git.g1t.sh | npx wrangler secret put GIT_FALLBACK_URL
   npx wrangler secret put GIT_FALLBACK_SECRET            # paste /srv/gitstore.secret
   ```

6. Drill it once a quarter on a namespace that holds only test repositories (make `g1t-drill` as in
   R7, bind it, move a test repository there), with the runbook below.

#### Runbook: an Artifacts outage

**Detect.**

1. status.g1t.sh shows **Git storage** down, or `node scripts/ops/artifacts-namespaces.mjs` shows a
   namespace failing (errors, `rejected` calls from an open breaker). `npx wrangler tail g1t-repos`
   shows `git store <namespace>: ... failed`.
2. Check Cloudflare's status page and the Artifacts metrics (`serverError`, `rateLimited`).
3. Switch when it has lasted 15 minutes with no sign of ending, or at once if Cloudflare says it will
   be long. A short blip needs nothing: retries and the breaker already answer git with 503 and
   `Retry-After`.

**Switch.**

1. On the host: `curl -s https://fallback-git.g1t.sh/healthz` answers `ok read-only`. If the nightly
   restore did not run today, run step 4 of the setup; a run over a restored store only does what
   changed.
2. Switch the failing namespace (or `*`). A secret takes effect in seconds, with no build:

   ```sh
   cd services/repos
   echo g1t | npx wrangler secret put GIT_FALLBACK_NAMESPACES
   ```

3. Check: `git ls-remote https://g1t.sh/flagon-io/hello.git` answers; a repository page loads;
   status.g1t.sh shows Git storage degraded; `artifacts-namespaces.mjs` lists `@fallback` calls.
4. Open an incident on status.g1t.sh: reads work from last night's backup; pushes, merges and new
   repositories wait.

**Serve reads.** Nothing more to do. Watch the host's disk and load; `upload-pack` is the work.

**Take writes, only if the outage will be long.** Everything pushed then must be sent back
afterwards, and anything pushed to Artifacts after the last backup will conflict with it.

```sh
# On the host: restart the git store without GITSTORE_READ_ONLY. Then:
echo allow | npx wrangler secret put GIT_FALLBACK_WRITES
```

**Switch back**, once Artifacts answers again (`artifacts-namespaces.mjs` shows no errors from it;
the namespace's own calls are none while switched, so check Cloudflare's status and the metrics):

1. If writes were taken: stop them first (`echo refuse | npx wrangler secret put GIT_FALLBACK_WRITES`,
   and restart the git store with `GITSTORE_READ_ONLY=1`), then list and send back what came in, while
   the namespace is still switched, so nothing else writes to Artifacts meanwhile:

   ```sh
   node scripts/ops/restore-to-gitstore.mjs changed --into /srv/gitstore
   CLOUDFLARE_API_TOKEN=<Artifacts edit, D1 edit> node scripts/ops/restore-to-gitstore.mjs reconcile --into /srv/gitstore
   ```

   A ref Artifacts still has as it was backed up takes the fallback's value (leased on that value, so
   nothing newer is overwritten). One that moved on both sides keeps Artifacts' value, and the
   fallback's goes beside it as `refs/fallback/<rest of the name>` (exit 3 says some did): tell the
   repository's owners to merge it. Each reconciled repository's `refs_version` is moved. To push,
   `reconcile` mints a write token with Cloudflare's REST API
   (`POST /accounts/<id>/artifacts/namespaces/<ns>/repos/<name>/tokens`, taken to mirror the binding's
   `createToken`); that endpoint is not verified yet, so run `reconcile` on one repository in the
   drill before relying on it.
2. Switch back: `npx wrangler secret delete GIT_FALLBACK_NAMESPACES` (and `GIT_FALLBACK_WRITES`).
3. Check as in "Switch", step 3: Git storage is no longer degraded once the fallback's calls age out
   of the five-minute window.
4. Backups resume the next night. Close the incident.

Tested by `npm run test:ops` (`scripts/ops/restore-to-gitstore.test.mjs`): bundles cut as the runner
cuts them are restored into a store's root, served read-only by the git store itself (a namespaced
remote, a read token, a clone; write tokens and new repositories refused), pushed to, listed by
`changed`, reconciled into a live copy, and reconciled again after the live copy moved too; and a
restore through the store's API. `cargo test` covers the routing, answers, read-only refusals and
kept credentials (`fallback.rs`, `store.rs`, `resilience.rs`). Not yet run against production: the
switch itself, which wants the host.

### Deploy order and what to watch

R7 and R12 (2026-10-07): migrations `repos/0014` and `identity/0026` first (the registry reads
`writes_paused_until`, and `claim_store_key` reads `repo_move_copies`, so the new repos code must not
run before 0014); then `g1t-repos`, `g1t-identity`, `g1t-web` and `g1t-status`. No new bindings or
variables: with today's configuration nothing is placed, moved, offered or switched. Watch that
repository creation still answers as fast (it reads nothing new), and that `repository_moves` stays
empty.

For 2026-10-06's work:

1. Migration 0011 (the deploy tool applies migrations first). `forks_of` reads `retired_at`, so
   the new code must not run before it.
2. `g1t-repos` (new vars in `wrangler.jsonc`; no new bindings).
3. `g1t-status` (a new `REPOS` service binding; **Git storage** appears once deployed).
4. After a day: `scripts/ops/artifacts-usage.mjs`; then the fork test.

Expected: `Server-Timing` `kept` on POSTs drops from 63–98 ms to the KV and Cache lookups only (a
few ms); `mint` happens about once per repository and scope every 50 minutes per isolate instead
of every 3 minutes, and costs `get` and `createToken` (about 0.5 s instead of 0.8 s) once an
isolate knows its namespace's prefix; branch pages and repeated tree and file views skip
Artifacts while the refs version holds; a burst of 100 mergeability checks walks the target once.

Risks: what Cloudflare bills is still theirs to confirm (the mapping makes changing it cheap).
Counts held by an isolate that is evicted before its `wait_until` write are lost (seconds of
traffic). Pushes over 24 MiB now fail closed: bringing a large existing repository needs the
push-in-parts command (in `guides/git.md`). Moving a revived fork's branch back to its old head
is a non-fast-forward update, which depends on Artifacts accepting it as git does by default; if
it refuses, the fork of a closed pull request cannot be made again and the error says so.
`refs/pull/*` refs appear in full ref advertisements (mirrors, `--mirror` clones). Operations on
pull request forks are metered under the workspace `pulls`, so they are counted for g1t's bill
but not charged to a workspace (except the fork itself, metered on its repository).
