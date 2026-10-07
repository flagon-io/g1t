# Self-hosting g1t

The goal (2026-10-05): g1t should not be locked to Cloudflare. Anyone should
be able to run it on their own machine with `docker compose up`. The free
core is MIT and self-hostable; managed hosting at g1t.sh is the paid
product, and it stays on Cloudflare. Self-hosting must never make hosted
g1t worse, so hosted code paths do not change to make room for it.

This document covers:

1. An inventory of every Cloudflare dependency in the code.
2. The design: ports and adapters, with the runtime choice weighed.
3. What phase 1 ships today: `deploy/self-host/`, and what was verified.
4. The phased plan, with estimates.
5. The risks.

The user guide is `apps/docs/src/content/docs/guides/self-hosting.md`.

## The short version

- **g1t is already shaped for this.** Every service talks to every other
  over plain HTTP: `POST /rpc/<method>` with a JSON body (`crates/kit`,
  `packages/contracts/src/clients.ts`). Every database is SQLite (D1).
  Git storage sits behind a `GitStore` port (`services/repos/src/store.rs`),
  and everything past that port speaks git's smart HTTP to a remote URL
  with a bearer token.
- **The fastest credible path is to run the Workers themselves in
  workerd**, the open-source Workers runtime, not to port them. Phase 1
  runs every core Worker unchanged (the same WebAssembly and the same
  bundles that deploy to Cloudflare) in one workerd process under
  `wrangler dev`. D1, KV and Queues are kept on a volume as SQLite files.
- **Three things replace Cloudflare-only bindings**, as small Workers bound
  in their place, with no change to the services:
  - `ARTIFACTS` becomes an Artifacts-compatible shim in front of a git
    store, which keeps plain bare repositories on disk and serves them
    with `git http-backend`.
  - `EMAIL` becomes a shim that logs each message and hands it to Mailpit,
    which can relay to any SMTP server.
  - The runner and the context hub are bound to an "off" Worker, which
    answers "agents are off" instead of failing.
- **Proven on this machine with Docker:** sign up, confirm the email
  through Mailpit, create a workspace and a repository, push and clone over
  HTTP (the second clone from the clone pack cache in MinIO), open an
  issue, and browse code, commits and files in the site; then the REST API,
  OAuth metadata and MCP on their own port, pull requests from a branch and
  from a fork merged onto `main`, the merge queue taking a pull request and
  giving it back, and every cron handler the scheduler runs. All of it runs
  against local storage. See [Phase 1: what works today](#3-phase-1-what-works-today).
- **Long term:** keep workerd as the runtime, because it is what hosted
  runs. Replace `wrangler dev` with a production workerd configuration.
  Move the binding shims into code-level ports in `g1t_kit` and a TS
  `@g1t/platform` package, so each primitive has a hosted and a
  self-hosted adapter behind one interface.

## 1. Inventory

The sources are every `wrangler.jsonc` plus a grep of the code. Coupling
is graded:

- **thin**: one call site or a config switch;
- **adapter**: already behind a port, or easy to put behind one;
- **woven**: the logic is shaped around the product.

### By primitive

| Primitive | Where | Coupling | Self-hosted equivalent |
| --- | --- | --- | --- |
| **Workers runtime**, service bindings | Every service. Rust through `worker` 0.8 (`#[event(fetch\|queue\|scheduled)]`, `Env`, `Fetcher`); TS as `export default { fetch, queue, scheduled }` | woven (as a runtime), thin (as an API) | **workerd**: the same runtime, open source. Service bindings work as they do hosted. Calls are HTTP (`POST /rpc/<method>`), so a native port could use plain HTTP clients. |
| **Workers RPC** (JS methods across a binding) | Only `RUNNER`: `RunnerService extends WorkerEntrypoint` (`services/runner/src/index.ts:626`). `apps/web` calls `env.RUNNER.enabled/run/plan/...` directly in 11 routes. | thin | workerd supports it. A native port needs these on `/rpc/*` as well; the runner already has a `fetch` shim for Rust callers. |
| **D1** | System of record for 13 services. Rust: `env.d1("DB")`; TS: `D1Database`; `db.batch()` in `crates/kit` `rename` | woven (SQL), thin (API) | **SQLite files**. workerd/Miniflare implements D1 on SQLite, and the same `migrations/` apply with `wrangler d1 migrations apply --local`. A native port would need a `Database` port over `rusqlite`/`better-sqlite3`; the SQL is already SQLite, including FTS5. |
| **KV** | `BLOBS`: Actions artifacts and cache (`apps/api/src/blobs.rs`, `apps/web/app/lib/artifacts.server.ts`). `AVATARS`: `services/identity/src/avatars.rs`, `apps/web/workers/app.ts`, `services/og`. `DOMAINS`: `services/deployments/src/domains.ts`, `services/pages` | thin | Miniflare KV on disk (SQLite plus blob files). Natively: a `BlobStore` port on the filesystem or S3/MinIO. |
| **Queues**: the event bus | Producer: `services/events` `BUS.sendBatch` (`lib.rs:67`). The consumer writes the log, then fans out to every binding named `SUBSCRIBER_*` (`lib.rs:161`). Twelve consumers, one queue each. Private job queues in search (`g1t-search-jobs`) and context (`g1t-context-jobs`); consumers branch on the queue name. | woven | Miniflare Queues: in-process and persisted, which works today. Natively: a `Bus` port with a SQLite outbox and a poller per subscriber, or NATS/Redis Streams. At-least-once delivery and idempotent consumers are already the contract. |
| **Durable Objects** | Only `AttemptSandbox` (runner), as the containers library's base class. Uses `ctx.storage.get/put/delete`, `schedule()` (alarm), `idFromName`/`idFromString`, DO RPC (`run`, `destroy`, `noteBlocked`). **Not used:** WebSocket hibernation, raw `alarm()`, `ctx.storage.sql`, `ctx.exports`. | woven, in the runner only | workerd supports Durable Objects (on-disk SQLite). Runner state can move to the sandbox supervisor (phase 2). |
| **Containers** (`@cloudflare/containers`) | `services/runner`: one sandbox per agent run, Actions job and deploy build. `sleepAfter`, `start({ envVars, enableInternet })`, `onStop`. Image: `services/runner/Dockerfile` (node 24, git, toolchains, Claude Code, `g1t-runner`). | woven | **Docker or Podman** through the socket, with the same image. Wrangler can already run Containers locally through Docker; whether that covers outbound interception has to be tested. |
| **Outbound interception** (guardrails egress) | `services/runner/src/guard.ts` (`egress()`, `abuse()`), `egress.ts` (`sandboxHosts`, `buildHosts`, `EGRESS_CA = /etc/cloudflare/certs/cloudflare-containers-ca.crt`), `AttemptSandbox.outboundHandlers`, `interceptHttps = true`, `setOutboundHandler("egress", { hosts })`, `setOutboundByHost("sandbox.g1t.internal", "abuse")` (a sandbox reporting it stopped itself for mining; `crates/runner/src/abuse.rs`) | woven | The sandbox joins an internal network with no route out, and gets `HTTP(S)_PROXY` pointing at an allow-list proxy that checks the `CONNECT` host. The CA bundle is then not needed, because nothing is re-signed. Blocked hosts are reported to the runner as `noteBlocked` does today. |
| **Artifacts** (git storage) | Only `services/repos/src/store.rs` (`ArtifactsStore`, behind the `GitStore`/`GitRepo` traits). Methods used: `create`, `get`; then `info`, `createToken`, `log`, `readCommit`, `readTree`, `readBlob`, `readFile`, `fork`, and `[Symbol.dispose]`. Everything else (push, fetch, landing, catch-up, import, ref listing) is smart HTTP to `info().remote` with `Bearer <token>`: `land.rs`, `catch_up.rs`, `refs.rs`, `import.rs`, `git_http.rs`. | adapter | **Bare repositories on disk plus `git http-backend`.** Built in phase 1: `deploy/self-host/gitstore`. Forks are local clones with hard links. Tokens are HMAC-signed, scoped, and expire. |
| **Cache API** | `services/repos/src/store.rs` (trees and blobs up to 1 MiB, by hash), `apps/web/workers/app.ts` (avatars), `services/og` | thin, optional | Miniflare's cache, or none. Every use tolerates a miss. |
| **Vectorize** | `services/context/src/index.ts` (`VECTORS.upsert/deleteByIds/query`); optional, guarded by `if (!AI \|\| !VECTORS)` | thin | **sqlite-vec** (default: one file, next to D1), pgvector or Qdrant behind a `VectorIndex` port; or off, which already degrades to keyword search. |
| **Workers AI** | `services/context` only: `@cf/baai/bge-base-en-v1.5` embeddings (768 dims) | thin | An OpenAI-compatible `/v1/embeddings` endpoint (Ollama, vLLM, LM Studio, or a hosted API) behind an `Embedder` port. Changing models means re-embedding (a backfill job already exists). |
| **AI Gateway** | `services/runner/src/model-env.ts` (`modelEnv`), `services/models/src/route.ts:70` (gateway URL, `cf-aig-*` headers), `services/billing/src/keeper.rs` (reads gateway logs to settle) | thin | Optional already: an empty `AI_GATEWAY_ID` goes straight to the provider. Any Anthropic- or OpenAI-compatible base URL works for a workspace's own provider. |
| **Workers for Platforms** | `services/pages` (dispatcher: `env.APPS.get(script).fetch`), `services/deployments/src/cloudflare.ts` (script and asset upload through the REST API) | woven | Phase 1: off. Later: a self-hosted app host in workerd, using the Worker Loader binding to load uploaded scripts, or a workerd per app (see [Deployments](#deployments)). |
| **Cloudflare for SaaS** (custom hostnames) | `services/deployments/src/custom-hostnames.ts` (`/zones/{id}/custom_hostnames`) | thin | Caddy with on-demand TLS, asking g1t whether a hostname is allowed. |
| **Cloudflare REST API** | deployments: script upload, list, delete, assets, GraphQL usage. Billing keeper: AI Gateway logs, `billable-usage`, GraphQL container usage. Ops scripts in `scripts/`. | thin (deployments), woven (keeper pricing) | Deployments: the app-host adapter. Keeper: off when self-hosted, because there is no bill to reconcile. |
| **Email Sending** | `services/identity/src/email.rs` (`EMAIL.send({to, from, subject, text, html})`); callers: verification, password reset, `admin.rs` limit warnings | thin | Built in phase 1: a shim that logs and hands mail to Mailpit, which relays over SMTP. Later: a `Mailer` port with an SMTP adapter. |
| **Cloudflare Access** | `apps/sudo/app/lib/access.ts` (verifies `Cf-Access-Jwt-Assertion` against `/cdn-cgi/access/certs`, `ACCESS_AUD`, `STAFF_EMAILS`) | woven, in sudo only | A local admin flag: `G1T_ADMINS` usernames checked against the normal g1t session. Self-hosters rarely need sudo, which is about billing. |
| **Cron Triggers** | actions (every minute), webhooks (every minute), identity (`*/15`), security (`*/30`), repos and packages (hourly), events (daily), billing (`*/15` and daily), deployments (`*/10`), runner (`*/5`) | thin | workerd runs `scheduled()` when asked, but never on its own. `deploy/self-host/scheduler.mjs` asks: once a minute, inside the g1t container, it runs each due cron through Wrangler's local API (`POST /cdn-cgi/local/explorer/api/local/scheduled?worker=<name>`, answered only on localhost), the same handler Cron Triggers run. The services and crons come from `schedules.json`, which `configs.mjs` writes from each `wrangler.jsonc` for the services in its `SELF_HOST_CRONS`: repos, events, identity, security, webhooks and packages. Not run: actions (it would start scheduled workflows with no runner), billing (Cloudflare and Stripe) and deployments (Cloudflare's API). A handler still running from the minute before is not started again, and one is given up on after ten minutes. `scheduler.mjs --once` runs every cron of every service now and exits non-zero if one failed (smoke.sh uses it). The status page has its own loop (`status.sh`). |
| **`cloudflare:workers` imports** | `apps/web` (`env` in 15 files), `apps/sudo`, `services/runner` (`WorkerEntrypoint`) | thin | Provided by workerd. A Node port would pass `env` through context instead. |
| **Static Assets** | `apps/web` (Vite plugin build), `apps/docs`, `apps/sudo` (`run_worker_first`) | thin | workerd serves them. |
| **`placement`, `observability`, routes, custom domains** | every `wrangler.jsonc` | config only | Dropped by `deploy/self-host/configs.mjs`. |
| **`cf-ray`** | Used as an audit request id, with a fallback: `services/repos/src/run_access.rs:131`, `apps/api/src/audit.rs:37` | thin | Falls back already. |
| **R2** | `services/packages` (`BLOBS`: container layers and other package files), `services/repos` (`BACKUPS`: nightly backup bundles; `GIT_PACKS`: the clone pack cache), the API's Actions cache (`ACTIONS_CACHE`), the runner's downloads | thin | **S3-compatible storage**: the `BlobStore` port in `crates/blobstore` has an R2 adapter and an S3 one (`s3.rs`, SigV4 over fetch); each service names its own bucket (`BLOB_STORE`/`S3_BUCKET` for packages, `BACKUP_STORE`/`BACKUP_S3_BUCKET` for backups, `PACK_STORE`/`PACK_S3_BUCKET` for clone packs), run against MinIO in the compose file. |
| **Not used** | Hyperdrive, Workflows, Analytics Engine, Browser Rendering, Images, Turnstile, Secrets Store, `connect()`, HTMLRewriter, `request.cf` | — | — |

### By service

The deployable units, their stage and what each is built from are listed in
`deploy/stack.jsonc` (see `docs/DEPLOYING.md`); its `self_host` field is
what `deploy/self-host/configs.mjs` runs, turns off or leaves out. A test
checks this table names every unit.

| Service | Runs on | Cloudflare dependencies beyond Workers and D1 | Phase 1 self-hosted |
| --- | --- | --- | --- |
| `apps/web` | TS Worker plus assets | KV (`BLOBS`, `AVATARS`), Cache API, `cloudflare:workers` `env`, RPC to `RUNNER` | Runs unchanged |
| `apps/api` | Rust Worker | KV `BLOBS`, R2 `ACTIONS_CACHE`; `api.g1t.sh`/`mcp.g1t.sh` addresses (now the `API_URL`, `MCP_URL` and `SITE_URL` settings, hosted defaults when unset: `src/addresses.rs`) | Runs in a second workerd on its own port (`API_PORT`, 8789; `self_host: "separate"`), started by `start.sh` once the first is up. Its service bindings reach the other Workers through Wrangler's dev registry. `API_URL` (default: `PUBLIC_URL`'s host on `API_PORT`) is its OAuth issuer; MCP is the path `/mcp` on it (`MCP_URL`). Its KV is its own, apart from the site's: Actions artifacts need the runner, which is off |
| `apps/sudo` | TS Worker plus assets | Access JWT | Not run |
| `apps/docs` | Static | — | Not run (docs.g1t.sh serves them) |
| `apps/status` | TS Worker | Email Sending, cron; bound only to billing | Runs in a process of its own (`status.sh`), so it stays up when the site does not |
| `services/identity` | Rust | Email Sending, KV `AVATARS` | Runs unchanged; `EMAIL` goes to the mail shim |
| `services/repos` | Rust | **Artifacts**, **R2** (`BACKUPS`), Cache API, optional KV `GIT_CACHE` with `REPOS_KEY`, optional R2 `GIT_PACKS` | Runs unchanged; `ARTIFACTS` goes to the git store, backups to MinIO's `g1t-backups` bucket (`BACKUP_STORE=s3`), and the clone pack cache to `g1t-git-packs` (`PACK_STORE=s3`: the `PackStore` port in `src/pack_cache.rs` over the shared `BlobStore`, multipart, an object only once whole; `minio-setup` gives the bucket a rule that deletes packs after 7 days, and MinIO removes unfinished uploads after 24 hours). Without `GIT_CACHE` and `REPOS_KEY`, credentials and ref listings are kept per isolate only. Its nightly cron queues backups, but bundles are cut by the runner, which is off in phase 1: none are made yet |
| `services/work` | Rust | Queue consumer | Runs unchanged |
| `services/events` | Rust | Queues (producer and fan-out) | Runs unchanged; the off services' queues are not produced to |
| `services/projects` | TS | Queue consumer | Runs unchanged |
| `services/search` | Rust | Queues (events and its own jobs); FTS5 | Runs unchanged |
| `services/billing` | Rust | Cron, Cloudflare REST API (keeper), Stripe | Runs with `FREE_WHILE_BUILDING=true` and no Stripe key: nothing is charged |
| `services/security` | Rust | Queue, cron | Runs unchanged; its cron through `scheduler.mjs` |
| `services/actions` | Rust | Queue, cron, `ACTIONS_KEY` | Runs; jobs need the runner, which is off |
| `services/webhooks` | Rust | Queue, cron, `WEBHOOKS_KEY` | Runs; retries through `scheduler.mjs` |
| `services/integrations` | Rust | Queue, `INTEGRATIONS_KEY` | Runs unchanged |
| `services/packages` | Rust | **R2** (`BLOBS`), cron, queue, `PACKAGES_TOKEN_SECRET` | Runs with `BLOB_STORE=s3` against the compose file's MinIO (`deploy/self-host/configs.mjs`); no request size limit (`MAX_REQUEST_BYTES` 0 means none) |
| `services/deployments` | TS | Workers for Platforms, REST API, KV `DOMAINS`, cron | Runs with no API token: nothing deploys |
| `services/runner` | TS | **Containers**, Durable Objects, outbound interception, AI Gateway, cron | Off: bound to the off Worker |
| `services/context` | TS | **Vectorize**, **Workers AI**, Queues | Off: bound to the off Worker |
| `services/models` | TS | AI Gateway; public at `models.g1t.sh` | Not run (only sandboxes call it) |
| `services/pages` | TS | Dispatch namespace, wildcard routes, KV | Not run |
| `services/og` | TS | Cache API | Not run (social cards are optional) |
| `crates/runner` | native, in the sandbox | Talks to `https://api.g1t.sh` and `https://g1t.sh` (hard-coded in the runner Worker); `wrangler deploy --dry-run` for builds | Phase 2 |
| `crates/sshd` | native | Not deployed; calls `/_internal/ssh/*` endpoints that do not exist yet | Phase 3 |

### Hard-coded hosted addresses

Self-hosting needs one setting, `PUBLIC_URL`, in place of these, and
`configs.mjs` derives the rest from it. These are settings now, each with
the hosted address as its default, so hosted g1t sets nothing:

- The site (`apps/web/app/lib/addresses.ts`): `SITE_URL`, `API_URL`,
  `MCP_URL` and `OG_URL` (empty: no social card tags). The root loader
  hands them to the page; `meta.ts`, the clone box, agent setup, the
  pull request and merge box remotes, the tokens page and the OAuth
  consent's `iss` read them.
- The API (`apps/api/src/addresses.rs`): `SITE_URL`, `API_URL` (the OAuth
  issuer) and `MCP_URL` (the protected resource; a path on the API's host
  self-hosted).
- Identity's mail (`services/identity/src/email.rs`): `SITE_URL` for
  links and the logo, `MAIL_FROM` for the sender. The mail shim still
  rewrites any `https://g1t.sh` link left in a message.

Still hard-coded, for phase 2:

- `apps/web/workers/app.ts` (`DOCS`); defaults in
  `components/invites-section.tsx`, `components/runners.tsx`,
  `lib/invites.ts` and `lib/legal.ts`.
- `services/runner/src/index.ts` (`G1T_API`, `GIT_REMOTE` and the other
  remotes handed to sandboxes, in 12 places).
- `services/billing` (`stripe.rs`, `accounts.rs`, `limits.rs`).
- `crates/sshd` (`G1T_API` default).

There are about 150 occurrences of `g1t.sh` in non-test code. Most are
docs links and copy, and need no change.

## 2. Design

### Principles

1. **Hosted is the reference.** Hosted code does not change behaviour to
   make room for self-hosting. A self-hosted adapter is added beside the
   hosted one, and the hosted one stays the default.
2. **Swap at the narrowest seam that exists.** A binding-shaped seam (a
   Worker that offers the same methods as the Cloudflare binding) needs no
   code change, and is how phase 1 works. A code-level port (a trait or
   interface with two adapters) is cleaner and testable, and is the long-term
   shape. Each primitive moves from the first to the second when it is next
   touched.
3. **One runtime, two hosts.** The Workers stay Workers. workerd runs them
   self-hosted, so one build serves both and there is no second code path
   to keep correct.
4. **Off is a real mode.** Every optional subsystem (agents, context,
   deployments, billing) has an "off" answer that pages already handle.

### The ports

| Port | Hosted adapter | Self-hosted adapter | Lives in | Status |
| --- | --- | --- | --- | --- |
| `GitStore` / `GitRepo` | `ArtifactsStore` | Git store (bare repos, `git http-backend`) through an Artifacts-compatible shim; later a `LocalGitStore` that calls the git store's HTTP API from Rust directly | `services/repos/src/store.rs` (exists) | **Built** (binding level) |
| `Mailer` | Email Sending binding | SMTP (through Mailpit relay now; a direct SMTP adapter later) | `g1t_kit::mail` | **Built** (binding level) |
| `Sandbox` | `AttemptSandbox` (Containers, DO) | `DockerSandbox`: a supervisor that starts the runner image through the Docker API | `services/runner` (TS) | Phase 2 |
| `Egress` | Containers outbound handler | Allow-list HTTP(S) proxy on an internal network | `services/runner` | Phase 2 |
| `ModelRoute` | AI Gateway, or direct | Any Anthropic/OpenAI-compatible base URL | `services/models`, `runner/model-env.ts` | Exists (env-switchable) |
| `Embedder` | Workers AI | OpenAI-compatible `/v1/embeddings` | `services/context` | Phase 3 |
| `VectorIndex` | Vectorize | sqlite-vec / pgvector / Qdrant | `services/context` | Phase 3 |
| `AppHost` | Workers for Platforms plus REST API | workerd app host (Worker Loader) | `services/deployments` | Phase 3 |
| `Domains` | Cloudflare for SaaS | Caddy on-demand TLS | `services/deployments` | Phase 3 |
| `AdminAuth` | Cloudflare Access | `G1T_ADMINS` plus the normal session | `apps/sudo` | Phase 4 |
| `Bus` | Queues | Miniflare Queues now; SQLite outbox later | `services/events`, `g1t_kit` | Works (runtime) |
| `Database` | D1 | SQLite files through workerd | — | Works (runtime) |
| `Blobs` | KV | Miniflare KV now; filesystem/S3 later | — | Works (runtime) |
| `Scheduler` | Cron Triggers | `scheduler.mjs`: a ticker that calls `scheduled()` through Wrangler's local API | `deploy/self-host` | **Built** for the services in `SELF_HOST_CRONS`; each handler checked by `smoke.sh` |
| `PackStore` | R2 `GIT_PACKS` | S3 (`PACK_STORE=s3`) through `crates/blobstore` | `services/repos/src/pack_cache.rs` | **Built** |
| `UsageKeeper` | Cloudflare bill plus AI Gateway logs | None (billing off) | `services/billing` | Off |

For Rust, the code-level ports go in `crates/kit` as traits (`g1t_kit::ports`),
with the Cloudflare adapters next to them. For TypeScript, they go in a new
`packages/platform` package, with each adapter in its own module so a
hosted bundle never pulls in a self-hosted adapter. The adapter is chosen at
startup from one setting, `G1T_MODE=hosted|self`, never per request.

### The runtime: workerd, or native binaries

| | **workerd (phase 1: `wrangler dev`; later a plain workerd config)** | **Native: Rust on axum/hyper, TS on Node** |
| --- | --- | --- |
| Effort to first boot | **Done.** About a day, almost all of it shims and config. | Weeks. The Rust services use `worker::*` throughout: `Env`, `Fetcher`, `D1Database`, the `#[event]` macros and `js_sys` interop. Each needs an abstraction layer before it compiles natively. TS needs an `env` provider in place of `cloudflare:workers`, plus Queues, D1 and KV clients. |
| Fidelity to hosted | **The same runtime and the same bundles.** A bug self-hosted is a bug hosted. | A second implementation of every platform API, with its own bugs. |
| Performance | Good for one node: WebAssembly in V8, SQLite on local disk. Single-threaded per isolate; plenty for a team. | Better per core, and multi-threaded. That matters only at a scale where people use g1t.sh. |
| Maintenance | Low. New hosted features run self-hosted for free, unless they add a new Cloudflare-only binding. The config generator then drops it or binds a stand-in. | High. Every feature is built twice, or behind a port that both sides keep honest. |
| Scale-out | One process, one disk. D1-on-SQLite is single-writer. | Could use Postgres and many processes. |
| Operational risk | `wrangler dev` is a development tool (see risks). Moving to `workerd serve` with a generated config, or a small Miniflare-API launcher, removes the dev-tool surface. | Conventional. |

**Recommendation.**

- **Phase 1:** workerd under `wrangler dev`, as built in `deploy/self-host/`.
  It needs no change to any service and is proven end to end.
- **Phase 2:** replace `wrangler dev` with a launcher that drives Miniflare's
  API directly, or a generated `workerd` config. It should expose only the
  site and the API, with no dev endpoints, run cron, and run as a proper
  service.
- **Long term:** keep workerd as the runtime and push the remaining
  Cloudflare-only bindings behind code-level ports. Compile to native only
  what already is native (the runner binary, sshd), or a service where
  workerd is a real limit, case by case.

A full native port is not worth it. It would double the maintenance of
every feature, which is the opposite of what makes self-hosting
sustainable for a small team.

### Sandboxes (phase 2)

- **Engine.** Docker or Podman through the socket, mounted into a small
  supervisor (`g1t-sandboxd`), not into the workerd container. The
  supervisor exposes the runner's `Sandbox` port over HTTP: start with
  env, stop, status, and the exit report that becomes `onStop`. It uses
  the **same image** (`services/runner/Dockerfile`).
- **Runner.** The runner Worker runs in workerd with `AttemptSandbox`
  replaced by a `DockerSandbox` adapter. Run state that lives in
  `ctx.storage` moves to the supervisor's SQLite; `schedule()`/`timeUp`
  becomes a supervisor timer.
- **Egress guardrails.** Each restricted sandbox joins an internal Docker
  network with no default route. Its `HTTP_PROXY`/`HTTPS_PROXY` point at an
  allow-list proxy (for example a small Go or Node `CONNECT` proxy) that
  admits the hosts `sandboxHosts()` computes and reports refusals.
  Nothing is intercepted, so no CA is injected. `EGRESS=off` puts the
  sandbox on a normal network.
- **Addresses.** `G1T_API`, `GIT_REMOTE` and the rest become
  `PUBLIC_URL`-derived settings. Sandboxes reach the site and API on the
  compose network.
- **Shortcut to evaluate first.** Wrangler can already run Containers
  classes locally through Docker. If its local Containers support
  `setOutboundHandler`, the runner could run nearly unchanged. Test this
  before building the supervisor.

### Git storage

Artifacts gives g1t: named repositories, scoped short-lived tokens, a smart
HTTP remote, typed reads (commit, tree, blob, file, log), copy-on-write
forks, and jurisdictions. g1t uses everything except jurisdictions.

The self-hosted git store (`deploy/self-host/gitstore/server.mjs`, about 450
lines of Node with no dependencies) provides the same:

| Artifacts | Git store |
| --- | --- |
| `create(name, { setDefaultBranch, description })` | `git init --bare --initial-branch`, plus `g1t.json` beside it for metadata |
| `get(name)` then `info()` | Metadata, `HEAD`, and the last push time; `remote` is `GITSTORE_URL/git/<name>.git` |
| `createToken(scope, ttl)` | HMAC-SHA256 over `{ key, scope, expiry }` with the shared secret |
| Smart HTTP remote | `git http-backend`; a read token cannot push |
| `log`, `readCommit`, `readTree`, `readBlob`, `readFile` | `git rev-list --first-parent`, `cat-file`, `ls-tree` |
| `fork(name, { defaultBranchOnly })` | `git clone --bare [--single-branch]` with hard-linked objects |

Hosted is untouched: `ArtifactsStore` is still the only adapter compiled
into `services/repos`. Self-hosted, the `ARTIFACTS` binding is a service
binding to `deploy/self-host/workers/artifacts`, which offers Artifacts'
methods and calls the git store. Long term, a `LocalGitStore` adapter in
Rust should call the git store's API directly, which removes the shim. The
git store can later gain `git gc` scheduling and object-store-backed packs
for large installations.

### Search and context

- **Site search** (`services/search`) is D1 FTS5. It works self-hosted as
  is (verified: `/search?q=hello` answers 200).
- **Context hub** (`services/context`) needs an `Embedder` and a
  `VectorIndex`:
  - Default: **sqlite-vec** in the context service's own SQLite, with
    embeddings from an **OpenAI-compatible endpoint**. Ollama's
    `nomic-embed-text` has the same 768 dimensions as today's
    `bge-base-en-v1.5`.
  - Alternatives: pgvector or Qdrant, for installations that already run
    them.
  - Off: the service already degrades to keyword search when `AI` or
    `VECTORS` is missing (`index.ts:919`), so phase 3 can first run context
    with neither bound.

### Models

Already portable. The model proxy (`services/models`) and the runner's
model environment take any Anthropic-compatible base URL, and an empty
`AI_GATEWAY_ID` skips AI Gateway. Self-hosted:

- a workspace connects its own provider under Integrations (Anthropic, or
  any Anthropic-compatible endpoint, including a local gateway in front of
  OpenAI-compatible models);
- "hosted models" are off, because there is no g1t key to spend.

### Deployments

- **Phase 1–2: off.** `services/deployments` runs, but with no
  `CLOUDFLARE_API_TOKEN` nothing deploys. Its pages and settings still
  render.
- **Phase 3: an app host on workerd.** The self-hosted `pages` dispatcher
  uses workerd's **Worker Loader** binding to load each uploaded app's
  modules on demand, keyed by deployment id, from the blob store. Static
  assets are served from the same store. Builds run in Docker sandboxes
  (phase 2), which already bundle with `wrangler deploy --dry-run`.
  Wildcard hosts (`*.apps.example.com`) and custom domains go through
  Caddy with on-demand TLS. The alternative, one workerd process per app,
  is simpler to isolate but heavier.

### Billing and the feature map

Self-hosted billing is **off by default**: no Stripe, no usage limits,
no keeper. Billing still runs, because the shell reads `billing.account`
on every page, but with `FREE_WHILE_BUILDING=true` and no Stripe key.

| Feature | Hosted (g1t.sh) | Self-hosted default | Self-hosted, when turned on |
| --- | --- | --- | --- |
| Accounts, workspaces, repos, git over HTTP | On | On | — |
| Issues, pull requests, review | On | On | — |
| Merge queue | On | Takes pull requests; testing and landing them needs sandboxes | Phase 2 |
| Bringing a pull request up to date before it lands (catch-up) | On | Off: needs a sandbox | Phase 2 |
| Clone pack cache | R2 | MinIO (`g1t-git-packs`) | — |
| Site search (FTS5) | On | On | — |
| Email | Email Sending | Mailpit, logged | SMTP relay |
| Webhooks, integrations | On | On (retries through `scheduler.mjs`) | — |
| g1t's agent | On | Off | Phase 2: Docker sandboxes plus your own model provider |
| Guardrails egress | Containers interception | n/a | Phase 2: allow-list proxy |
| Hosted models (g1t's key) | On (billed) | Off | Never: bring your own |
| Context hub semantic search | Vectorize plus Workers AI | Off | Phase 3: sqlite-vec plus an OpenAI-compatible embedder |
| Deployments | Workers for Platforms | Off | Phase 3: workerd app host |
| Custom domains | Cloudflare for SaaS | Off | Phase 3: Caddy on-demand TLS |
| Billing, limits, Stripe, keeper | On | Off | Not planned |
| sudo (staff console) | Access | Off | Phase 4: `G1T_ADMINS` |
| Git over SSH | Not yet | Off | Phase 3 (`crates/sshd`, which is native already) |
| REST API, OAuth, MCP | On | On, on `API_PORT` | — |
| CLI | On | Off | Phase 2 |

### Auth, Access and email

- `apps/sudo` checks Cloudflare Access. Self-hosted, it should check a
  normal g1t session against `G1T_ADMINS`. That needs an `AdminAuth` port in
  `workers/app.ts` with two adapters. It is phase 4, because sudo is about
  billing.
- Sessions are random tokens stored hashed in D1, with no signing key, so
  nothing to configure. The cookie is `Secure`: fine on `localhost`, but any
  other address needs HTTPS. The compose file should gain an optional Caddy
  service in phase 2.
- **Email verification is required** before creating anything, and there is
  no bypass in code. That is why the proof ships a working mail path
  (Mailpit) rather than "email off". An admin "mark verified" or
  `G1T_SKIP_EMAIL_VERIFICATION` belongs with `G1T_ADMINS`.

### Configuration, upgrades and backups

- **Today:** environment variables in the compose file (`PUBLIC_URL`,
  `G1T_PORT`, `API_PORT`, `API_URL`, `MCP_URL`, `MAIL_URL`, `MAIL_FROM`,
  the S3 store and its buckets). Keys (`ACTIONS_KEY`,
  `INTEGRATIONS_KEY`, `WEBHOOKS_KEY`, the git store secret) are generated on
  first start and kept on volumes.
- **Phase 2:** one `g1t.toml`, read by the launcher and turned into
  bindings and variables:

  ```toml
  public_url = "https://git.example.com"

  [mail]
  smtp = "smtp://user:pass@smtp.example.com:587"
  from = "g1t <git@example.com>"

  [agents]          # off when absent
  docker = "unix:///var/run/docker.sock"
  egress = "enforce"

  [context]         # off when absent
  embeddings = "http://ollama:11434/v1"
  model = "nomic-embed-text"

  [admins]
  usernames = ["alice"]
  ```

- **Upgrades.** The container applies every service's D1 migrations to its
  SQLite file on start (`wrangler d1 migrations apply --local`). Applied
  migrations are recorded in `d1_migrations`, so this is idempotent. Hosted
  and self-hosted run the same migration files, which keeps them
  forward-compatible. Rule to keep: migrations stay additive, or come with
  a backfill a self-hoster's start can run.
- **Backups.** Phase 1: stop, then tar the `g1t-data` and `g1t-git`
  volumes (documented in the guide). Phase 2: online backups with
  `sqlite3 .backup` per database, or Litestream for continuous
  replication. The repositories get hosted g1t's nightly bundles
  (docs/ARTIFACTS.md, R11) once the runner runs: the storage is already
  configured (`BACKUP_STORE=s3`, the `g1t-backups` bucket that
  `minio-setup` makes, `BACKUP_S3_BUCKET` to choose another), and the
  restore drill reads a copy of that bucket
  (`mc mirror local/g1t-backups ./copy`, then
  `node scripts/ops/backup-restore-drill.mjs --bundles ./copy --repo-id <id> --live <bare repository>`).

## 3. Phase 1: what works today

Everything is in `deploy/self-host/`:

| File | What it is |
| --- | --- |
| `docker-compose.yml` | `g1t` (every core Worker in one workerd on 8787, and the API in a second on 8789), `status`, `gitstore` (bare repositories), `minio` and `minio-setup` (packages, backups and clone packs, with the packs' expiry rule), and `mailpit` (mail). Volumes: `g1t-data`, `g1t-git`, `g1t-packages`, `g1t-status`, `g1t-secrets`. MinIO no longer publishes `minio/minio` or `minio/mc` images; `MINIO_IMAGE` (default `pgsty/minio`, a community build with `mc` in it) is the server. |
| `Dockerfile` | Compiles the ten Rust services to WebAssembly with `worker-build`, as hosted does. Builds the site with React Router. The runtime image has Node, Wrangler, workerd and the built Workers. |
| `Dockerfile.dockerignore` | Build-context rules for this image only (the root `.dockerignore` leaves out the site). |
| `start.sh` | Makes the sealing keys once, writes the configs, applies migrations, runs `wrangler dev` with every config on `0.0.0.0:8787`, persisting to `/data/state`, and the API's `wrangler dev` on `0.0.0.0:8789` once the first answers. Starts `scheduler.mjs`. |
| `scheduler.mjs` | The cron ticker (see Cron Triggers above). |
| `configs.mjs` | Derives each self-hosted Wrangler config from the hosted `wrangler.jsonc`. It drops routes, account and placement, rebinds `ARTIFACTS`/`EMAIL` and the off services, and rewrites hosted URLs. Derived, so it cannot drift. |
| `gitstore/server.mjs`, `gitstore/Dockerfile` | The git store. |
| `workers/artifacts/index.js` | The `ARTIFACTS` binding, implemented against the git store. |
| `workers/mail/index.js` | The `EMAIL` binding: logs, then sends to Mailpit. |
| `workers/off/index.js` | The runner and the context hub when they are off. |
| `smoke.sh` | The end-to-end check, including the API, pull requests, the merge queue and (with `SCHEDULER_ONCE`) every cron handler. |

Workers running: the site; identity, repos, work, events, projects, search,
billing, security, actions, webhooks, integrations, packages and
deployments; the artifacts, mail and two off stand-ins; and, in a second
workerd, the API.

### Verified

On this machine (Windows 11, Docker Desktop 29.8, engine on Linux):

1. **Without Docker, with local processes.** The git store ran under Node
   on Windows and every Worker ran under `wrangler dev`, using the configs
   from `configs.mjs` and the existing Rust builds. `smoke.sh` passed every
   step: sign-up, confirmation through the logged link, workspace, repo,
   `git push` and `git clone` over HTTP, issue, and the code, blob and
   commits pages. Seventeen other pages answered 200: home, workspace,
   repo overview, issues, pulls, settings, agents, actions, deployments,
   security, people, usage, explore, search, account settings and tree.
   The workspace context page answered 403 from the off stand-in, as
   intended.
2. **With Docker Compose** (2026-10-07, `docker compose up --build`, with
   `API_PORT=18789` because 8789 was taken on this machine). `smoke.sh`
   passed every step: the ones above; a second clone answered from the pack
   cache (`Server-Timing: pack;desc=hit`), with the packs in MinIO's
   `g1t-git-packs` and its 7-day rule in place; an access token made in the
   site; `GET /user`, the API index (`mcp_url`, `git_url`), the OAuth
   metadata (`issuer` the API's address, `authorization_endpoint` on the
   site), MCP's 401 challenge and `tools/list`; a pull request from a branch
   and one from a fork (`create_pull_request` without a branch: a fork in
   the git store, pushed to with the token, marked ready) merged onto
   `main`; the merge queue turned on, a pull request merged into it and
   shown `waiting`, taken out (`unqueue`), the queue turned off and the
   pull request merged; and `scheduler.mjs --once`, every handler `ok`.
   The repository page's clone box and MCP line named the installation's
   own addresses, with no social card tags.
3. **The clone pack cache against MinIO without the stack.**
   `node services/repos/dev/clone-check.mjs --s3` (MinIO in Docker):
   misses then hits for full and shallow clones over protocol v2 and v0, a
   miss after the refs version moves, five whole packs in the bucket (12 MB
   each, so uploaded in parts), no unfinished upload, and the expiry rule.

### Not verified, or not working yet

- The merge queue past `waiting`, and catch-up (bringing a pull request
  up to date before it lands): both need a sandbox, and the runner is off.
- Actions schedules (`on: schedule`), and billing's and deployments' crons.
- The CLI, and git over SSH.
- An OAuth sign-in from start to finish (the metadata and issuer are
  checked, the consent flow is not).
- Anything on an address other than `localhost` without HTTPS (the
  session cookie is `Secure`).
- Restart durability beyond one restart, upgrades across schema changes,
  and backup and restore.

## 4. Phased plan

Estimates are for one engineer who knows the codebase, working with
agents. They include docs and tests.

| Phase | Scope | Estimate |
| --- | --- | --- |
| **1. Core forge** | **Done:** compose stack, git store, Artifacts/Email shims, off stand-ins, config generator, smoke test, guide; the API (REST, MCP, OAuth) on its own port with a `PUBLIC_URL`-derived issuer; `PUBLIC_URL`-derived settings in identity mail, the site's meta tags, clone box and agent setup, and the API; the cron ticker; the clone pack cache on S3; pull requests from branches and forks and the merge queue's enqueue and removal in `smoke.sh`. **Left:** optional Caddy for HTTPS; a CI job that builds the images and runs `smoke.sh`; the remaining hard-coded addresses listed above. | 2–3 days left |
| **2. Agents with Docker sandboxes** | Test Wrangler's local Containers first. Otherwise: `g1t-sandboxd` supervisor, `DockerSandbox` adapter in the runner, egress allow-list proxy and internal network, runner addresses from `PUBLIC_URL`, models through a workspace's own provider, `g1t.toml` and a launcher that replaces `wrangler dev`. | 2–3 weeks |
| **3. Search, context and deployments** | `Embedder` (OpenAI-compatible) and `VectorIndex` (sqlite-vec first) ports in context; app host on workerd with Worker Loader; Caddy on-demand TLS for app and custom domains; git over SSH through `crates/sshd` plus the missing `/_internal/ssh/*` endpoints. | 3–4 weeks |
| **4. Parity and upgrade path** | Code-level ports in `g1t_kit` / `@g1t/platform` replacing the binding shims (`LocalGitStore` in Rust, `Mailer` with SMTP); `AdminAuth` for sudo; online backups (Litestream or `.backup`); versioned releases with published images; an upgrade test in CI that migrates a snapshot of the previous release; a self-host column in the docs for every feature. | 3–4 weeks |

Total to parity: about 10–13 weeks. Phase 1 alone is already a credible
"run it yourself" for the core forge.

## 5. Risks

- **`wrangler dev` is a development tool.** It exposes Miniflare's dev
  endpoints (`/cdn-cgi/...`, including a local data explorer) on the same
  port as the site. Treat phase 1 as **localhost or a trusted private
  network only** until the launcher in phase 2 replaces it. Its flags and
  behaviour can also change between Wrangler releases. Pin the Wrangler
  version, as the lockfile already does.
- **The API reaches the other Workers through Wrangler's dev registry.**
  Two `wrangler dev` processes in one container find each other through
  a registry directory, a development feature like the rest. If the API
  starts and a binding says `[not connected]`, restart the container. The
  phase 2 launcher serves both from one workerd.
- **The MinIO image.** MinIO stopped publishing `minio/minio` and
  `minio/mc`. The compose file uses a community build (`MINIO_IMAGE`,
  `pgsty/minio`); any S3-compatible store can take its place.
- **Cron goes through Wrangler's local API.** `scheduler.mjs` asks
  `/cdn-cgi/local/explorer/api/local/scheduled`, a development endpoint
  that may change between Wrangler releases (pinned by the lockfile).
  Actions schedules, billing and deployments are not run.
- **New Cloudflare-only bindings break self-hosting silently.**
  `configs.mjs` passes unknown keys through untouched. A new binding type
  could make `wrangler dev` reach for a remote resource (for example
  `remote: true`, AI or Vectorize) and prompt for a login. Mitigation: CI
  that builds the compose stack and runs `smoke.sh` on every change, and an
  allow-list in `configs.mjs` that fails on unknown binding types.
- **Artifacts semantics drift.** The shim copies the Artifacts methods g1t
  uses today. If repos starts using another method (`import`,
  `listTokens`, `revokeToken`), self-hosted fails at runtime. Mitigation: a
  contract test that runs `services/repos` against the git store, and the
  long-term `LocalGitStore` port.
- **Error codes over RPC.** `ArtifactsStore::create` and `fork` tolerate
  `ALREADY_EXISTS` by reading the thrown error's `code`. Workers RPC may not
  carry custom error properties across a service binding. If it does not,
  retrying a half-finished create fails self-hosted where it would succeed
  hosted. This was not seen in testing, because creates were never retried.
- **Single node, single writer.** SQLite (D1 local) and one workerd
  process suit a team, not a large organisation. Scaling out means
  Postgres behind a `Database` port, which is a large change and is not
  planned.
- **The `Secure` cookie.** It needs HTTPS anywhere but `localhost`. A LAN
  install over plain HTTP cannot sign in.
- **Building from a working tree that is mid-change.** The image compiles
  every Rust service, including ones other work is changing. A service that
  does not compile breaks the whole image. Released images (phase 4) fix
  this.
- **Image size and build time.** The first build compiles ten Rust crates
  to WebAssembly and installs the site's dependencies. Expect minutes and
  several GB. Published images remove this for users.
- **Hard-coded hosted URLs.** The few left (listed above) point at the
  hosted service until they read a setting: the docs link, invite and
  runner defaults, and the runner's remotes.
