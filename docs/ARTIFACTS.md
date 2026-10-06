# Cloudflare Artifacts: due diligence for g1t at launch scale

Status: research document, 2026-10-06; R1–R5, R9, R10, R13 and R7 groundwork were built the same day (section 9).
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
   peaks.
4. **Hard limits are not enforced in front of Artifacts.** 1 GB per repository, 32 MB per file, and a
   128 MB Worker isolate that buffers each push body twice. Large pushes and imports fail late, without a
   message git can show.
5. **No backup, no exit drill.** Cloudflare replicates data, but there is no SLA, no documented export
   besides git itself, and the self-host git store is not a production fallback yet.

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
| M15 | Direct credentials | Tokens are bearer, repo-scoped | `git_access` hands out raw write tokens; pushes with them skip branch protection and push protection (`refs_open` only stops caching) | Policy bypass if a token leaks out of a sandbox | Keep TTL minimal on this path |
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
- Everything else is resilience and exit planning, ideally done while the product is still invite-only.

## 9. What was built (2026-10-06)

Code in `services/repos` unless named; one migration,
`migrations/0011_artifacts_meters_forks_health.sql` (new columns on `repos`, new tables
`artifacts_meters`, `operation_mapping`, `store_health`; additive, no backfill).

| # | Status | What |
| --- | --- | --- |
| R1 | Built; Cloudflare's answer still needed | Every interaction with the store is metered raw (`meters.rs` → `artifacts_meters`, per day, namespace, repository, workspace and meter, with bytes where known): client git (`git.info_refs`, `git.ls_refs`, `git.fetch`, `git.receive_pack`), g1t's own git (`internal.git.*`: landing, catch-up, mirrors, branch listings, fork retirement), every binding call (`binding.get`, `binding.create_token`, `binding.log`, `binding.read_tree`, …, each retry included), and answers g1t served from its own cache (`cache.*`, never operations). Which meters are operations is data: `operation_mapping` (`cost_operations` for g1t's bill, `billable_operations` for workspaces), read every 5 minutes, changed with `set_operation_mapping` without a deploy. Default: `git.fetch`, `git.receive_pack`, `internal.git.fetch`, `internal.git.receive_pack`, `binding.create`, `binding.fork`, `binding.delete` = 1, everything else 0. `git_operations` (what billing reads) is filled from the meters × `billable_operations`, by the hour. RPCs: `artifacts_usage { from, to, workspace?, by_repo? }` (raw meters and the mapping, for the reconciler), `operation_mapping`, `set_operation_mapping { meter, cost_operations, billable_operations, note? }`. Script: `scripts/ops/artifacts-usage.mjs`. |
| R13 | Built | Nothing on the request path writes D1 for counting. Meters add up per isolate and are written in one batch from `ctx.wait_until` after every request (and at the end of the cron and queue handlers); a failed write is kept for the next. The free-workspace slow-down decides from counts the isolate read back after its last write plus what it added since (`git_ops::standing`, at most 10 minutes old) and billing's plan answer kept 5 minutes. The 63–98 ms `kept` step's D1 upsert is gone. A workspace whose counts this isolate never read is not slowed: nothing slows anyone on a guess. |
| R2 | Built; the fork storage test is yours to run | `pull.merged` and `pull.closed` set the fork's `retire_after` (`FORK_RETENTION_DAYS`, default 7); `pull.reopened` clears it, or makes the fork again. The hourly sweep (`23 * * * *`, 25 a run) keeps the fork's head in its repository as `refs/pull/<pull id>/head` (only missing objects travel; an empty pack when merged), records `retired_at` and `retired_head`, then deletes the fork from the store (a failed delete puts the row back). Reads of a retired fork (the pull request's changes, divergence, tree, blob, log, branches) are answered from the repository with the fork's branch mapped to the kept head (`forks.rs` `Viewed`). Anything that writes or uses git on it (git over HTTPS, `git_access`, catch-up, land, `delete_branch`) makes it again first (`revive`: fork, then move its branch to the head) and schedules it to go again. Work never emits `pull.reopened` today; the handler is ready for it. Script: `scripts/ops/fork-storage-test.mjs`. |
| R3 | Built | Credentials g1t uses itself: TTL 3,600 s, reused for 50 minutes (isolate and KV, key `cred2:<key>:<scope>:internal`). `git_access` hands out its own: TTL 300 s, reused 180 s (`…:handout`); `refs_open` still uses 300 s. Every internal path (land, catch-up, mirrors, branch listing, commits, deleting a branch) now reuses kept credentials instead of minting each time. The remote is worked out as `https://<account>.artifacts.cloudflare.net/git/<namespace>/<name>.git` (the documented format, `api/git-protocol`), learned per namespace from the first `info()` an isolate makes, which runs alongside `createToken` and so costs no time; after that a mint is `get` and `createToken`. Optional `ARTIFACTS_REMOTE_BASE` skips even the first `info()`. |
| R4 | Built | Pushes are read as they arrive (`request.stream()`) and walked by `pack_limits::PackSizer` (each object inflated into a 32 KiB window and thrown away): an object over 32 MB (a delta measured by the object it makes), or a push taking the repository and its forks (`stored_bytes`) past `REPO_STORAGE_LIMIT_BYTES` (950 MB), is declined with `ng` lines and `remote:` text; a repository already at the limit is refused at the push's `info/refs` in plain text. Up to 24 MiB is kept, scanned and sent on as one copy, not three. Past 24 MiB push protection cannot read the push, so it is declined (`LARGE_PUSHES=refuse`, failing closed) with a command to push in parts, the 100 MB network limit named; `LARGE_PUSHES=unscanned` streams it to the store instead, still size-checked (a violation ends the stream before the pack's checksum, so the store keeps nothing). A pack too large for the scanner to inflate (48 MB inflated) is declined the same way instead of let through. Landing streams: upload-pack's side-band answer is taken apart chunk by chunk (`pack_limits::Sideband`) straight into the receive-pack body. |
| R5 | Built | `resilience.rs` sorts errors into rate limited, transient (`INTERNAL_ERROR`, `UPSTREAM_UNAVAILABLE`, `*_IN_PROGRESS`, no code, HTTP 5xx) and permanent. Binding reads, `get`, `info`, `createToken`, `create` and `delete` try up to 3 times with exponential backoff and jitter (80 ms base, 400 ms for rate limits, 2 s cap); `fork` and every receive-pack never retry. Git reads (`info/refs`, upload-pack) retry on 429 and 5xx. Per isolate, each namespace has a breaker that opens after 5 transient failures in a row, for 10 s, then lets one probe through. Busy answers reach git as 429 (rate limited) or 503, with `Retry-After: 5`; the site's read RPCs (`tree`, `blob`, `log`, `branches`, `blame`, `compare`) answer an `Outcome` failure saying the git storage is busy; other RPCs answer 503 with the same words. Health is counted by the minute (`store_health`) and served by the `store_health { minutes }` RPC; status.g1t.sh lists **Git storage** through a new `REPOS` service binding (down: 25% or more of at least 5 calls failed, or the breaker refused calls; degraded: rate limited, or a mean call over 1.5 s). |
| R9 | Built | `log(branch)`, `branches()` and `read_file(ref, path)` are kept in the colo cache under the repository's `refs_version` (5 minutes at most, and only while `refs_cache::usable`), and by commit hash for good; a log by branch also fills the by-hash entry; `readCommit` (parents) is kept for good. Read RPCs open repositories through `read_git`, which sets the version. |
| R10 | Built in repos; work unchanged | `divergence` works out the target's side once per target head per isolate (`coalesce.rs`: the head under the refs version, then the history by hash, kept 60 s), and what the target changed between two trees once per pair (10 minutes). `readCommit` and logs by hash come from the cache. Work's fan-out (`after_push`, up to 100 pull requests) is unchanged: its 100 `divergence` calls now cost one walk of the target instead of 100. |
| R7 | Groundwork | `shards.rs`: bindings named in `ARTIFACTS_NAMESPACES` (JSON, binding → namespace; `ARTIFACTS` → `g1t` always there), a repository's namespace kept in its `store` column as `<namespace>/<key>` (no prefix means the `ARTIFACTS` namespace, so every existing key reads the same), new repositories placed by `ARTIFACTS_NEW_REPOS` (comma-separated, spread by an FNV hash of the repository id; names not bound are skipped), forks always in their repository's namespace, `ARTIFACTS_EU_NAMESPACE` reserved for EU residency (no workspace setting yet). Works with only `ARTIFACTS` bound, as today. |
| R8 | Not touched | Sandbox clone depth belongs to the runner work (`crates/runner`). |

### R1: reading `scripts/ops/artifacts-usage.mjs`

```sh
export CLOUDFLARE_API_TOKEN=<token with Account Analytics: Read (and D1: Read, or set CLOUDFLARE_D1_TOKEN)>
node scripts/ops/artifacts-usage.mjs            # last 31 days, a table
node scripts/ops/artifacts-usage.mjs --days 7 --json > usage.json
ARTIFACTS_NAMESPACE=g1t node scripts/ops/artifacts-usage.mjs
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
  Ratios over 1: something reaches Artifacts that g1t does not meter, such as sandboxes pushing
  directly with handed-out credentials.
- Only days after the meters were deployed compare; before that only `git_operations` exists.
- Binding calls (`binding.*`) never appear among Cloudflare's event types; if Cloudflare says
  they are billed, map them in `operation_mapping`.

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

### R7: making more namespaces (yours to run, when needed)

```sh
# A US shard, unrestricted like today's g1t, and an EU one.
curl -X POST "https://api.cloudflare.com/client/v4/accounts/1e6f2cffa3f445920836e8ebe446bb58/artifacts/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"namespace":"g1t-us-1"}'
curl -X POST "https://api.cloudflare.com/client/v4/accounts/1e6f2cffa3f445920836e8ebe446bb58/artifacts/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"namespace":"g1t-eu","jurisdiction":"eu"}'
```

Then in `services/repos/wrangler.jsonc`:

```jsonc
"artifacts": [
  { "binding": "ARTIFACTS", "namespace": "g1t" },
  { "binding": "ARTIFACTS_1", "namespace": "g1t-us-1" },
  { "binding": "ARTIFACTS_EU", "namespace": "g1t-eu" }
],
"vars": {
  "ARTIFACTS_NAMESPACES": "{\"ARTIFACTS\":\"g1t\",\"ARTIFACTS_1\":\"g1t-us-1\",\"ARTIFACTS_EU\":\"g1t-eu\"}",
  "ARTIFACTS_NEW_REPOS": "g1t,g1t-us-1",   // new repositories spread over both
  "ARTIFACTS_EU_NAMESPACE": "g1t-eu"       // used once a workspace can choose the EU
}
```

Existing repositories stay where they are (`store` without a prefix). Deploy the binding before
naming its namespace in `ARTIFACTS_NEW_REPOS`; a name that is not bound is skipped, never used.
Moving an existing repository between namespaces is not built (a clone and push, then a `store`
update).

### Deploy order and what to watch

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
