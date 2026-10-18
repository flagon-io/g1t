---
title: Services and contracts
description: Every unit g1t deploys, what each one does, what it owns and what it calls, and how a call between two services works, down to the wire.
---

g1t deploys twenty-five units, listed once in `deploy/stack.jsonc`. Each is
a Worker with its own `wrangler.jsonc`, which names its database, its
queues and the services it calls. This page puts all of them in one
place.

## Every unit

**Calls** lists the services each unit binds to, which are the only ones
it can reach. A test, `npm run test:deploy`, reads every `wrangler.jsonc`
and fails if this table and the bindings disagree.

| Unit                    | Language   | Stage | What it does                                                                                                              | Owns                                                                                  | Calls                                                                                                                                                                                                  |
| ----------------------- | ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`              | TypeScript | front | The site on `g1t.sh`: pages, git over HTTPS and the package registries passed to their services, and `g1tusercontent.com` | The downloads bucket                                                                  | `actions`, `artifacts`, `billing`, `chat`, `deployments`, `events`, `identity`, `integrations`, `notify`, `og`, `packages`, `projects`, `repos`, `search`, `security`, `telemetry`, `webhooks`, `work` |
| `apps/api`              | Rust       | edge  | REST, MCP, OAuth, the runner protocol, OTLP ingest, Actions toolkit and OIDC                                              | Nothing; writes Actions cache and artifact files                                      | `actions`, `artifacts`, `billing`, `deployments`, `events`, `identity`, `integrations`, `packages`, `projects`, `repos`, `runner`, `search`, `security`, `telemetry`, `webhooks`, `work`               |
| `apps/status`           | TypeScript | edge  | `status.g1t.sh`: probes every minute and keeps incidents                                                                  | D1 `g1t-status`                                                                       | `billing`, `repos`                                                                                                                                                                                     |
| `apps/sudo`             | TypeScript | front | g1t.sh's staff console, behind Cloudflare Access                                                                          | Nothing                                                                               | `actions`, `billing`, `events`, `identity`, `projects`, `status`, `telemetry`                                                                                                                          |
| `apps/docs`             | Astro      | front | `docs.g1t.sh`, these pages                                                                                                | Nothing                                                                               | none                                                                                                                                                                                                   |
| `services/identity`     | Rust       | core  | Accounts, sessions, workspaces, members, teams, repository roles, tokens, OAuth, device sign-in, 2FA                      | D1 `g1t`, the avatars KV                                                              | `artifacts`, `billing`, `chat`, `events`, `notify`, `projects`, `repos`                                                                                                                                |
| `services/repos`        | Rust       | core  | Repositories and git: smart HTTP, pre-receive checks, caches, forks, landing merges, releases, backups                    | D1 `g1t-repos`, the git store, the git cache KV, the packs and backups buckets        | `billing`, `events`, `identity`, `security`, `work`                                                                                                                                                    |
| `services/work`         | Rust       | core  | Work items, pull requests, comments, reviews, labels, milestones, rulesets, checks, statuses, CODEOWNERS, the merge queue | D1 `g1t-work`                                                                         | `actions`, `events`, `identity`, `integrations`, `repos`                                                                                                                                               |
| `services/events`       | Rust       | core  | The event bus and log, the audit log, the inbox                                                                           | D1 `g1t-events`, the `g1t-events` queue and its subscriber queues                     | `billing`, `identity`, `notify`, `repos`, `work`                                                                                                                                                       |
| `services/actions`      | Rust       | core  | Workflows: reading them, triggering runs, planning jobs, secrets, self-hosted runners, logs                               | D1 `g1t-actions`; lists and expires the Actions cache bucket                          | `billing`, `deployments`, `events`, `identity`, `notify`, `projects`, `repos`, `runner`, `work`                                                                                                        |
| `services/runner`       | TypeScript | core  | Sandboxes on Cloudflare Containers, one per job, with their egress                                                        | The Container classes                                                                 | `actions`, `billing`, `deployments`, `events`, `identity`, `repos`, `work`                                                                                                                             |
| `services/deployments`  | TypeScript | core  | Builds and serves apps on `g1t.page`, previews, custom domains                                                            | D1 `g1t-deployments`, the domains KV, the dispatch namespace                          | `actions`, `billing`, `events`, `identity`, `og`, `projects`, `repos`, `runner`, `telemetry`, `work`                                                                                                   |
| `services/pages`        | TypeScript | edge  | The dispatcher for `*.g1t.page` and custom domains                                                                        | Nothing; reads the domains KV                                                         | none                                                                                                                                                                                                   |
| `services/packages`     | Rust       | core  | npm, Cargo, Composer, Maven, NuGet, RubyGems, Go and container images                                                     | D1 `g1t-packages`, the packages bucket                                                | `billing`, `events`, `identity`, `repos`                                                                                                                                                               |
| `services/security`     | Rust       | core  | Secret scanning, dependency alerts and updates, code scanning, the supply chain                                           | D1 `g1t-security`                                                                     | `actions`, `billing`, `events`, `identity`, `repos`, `runner`, `work`                                                                                                                                  |
| `services/search`       | Rust       | core  | Site search over repositories, work items, pull requests, people and code                                                 | D1 `g1t-search`, its jobs queue                                                       | `billing`, `identity`, `repos`, `work`                                                                                                                                                                 |
| `services/projects`     | TypeScript | core  | Projects and what they depend on                                                                                          | D1 `g1t-projects`                                                                     | `deployments`, `events`, `identity`, `og`, `packages`, `repos`                                                                                                                                         |
| `services/chat`         | TypeScript | core  | Channels, direct messages and threads, live                                                                               | D1 `g1t-chat`, a Durable Object per channel                                           | `identity`, `integrations`, `notify`                                                                                                                                                                   |
| `services/artifacts`    | TypeScript | core  | Docs written together, live, with their spaces, sharing and search                                                        | D1 `g1t-docs`, its files bucket, two Vectorize indexes, a Durable Object per open doc | `billing`, `events`, `identity`, `notify`, `repos`, `work`                                                                                                                                             |
| `services/notify`       | TypeScript | core  | Notifications, live pages, presence, browser and phone push                                                               | A Durable Object per person, per workspace and per repository                         | `identity`                                                                                                                                                                                             |
| `services/telemetry`    | TypeScript | core  | Logs, traces, metrics and errors for projects, at `otel.g1t.sh`                                                           | A Durable Object per project                                                          | `billing`                                                                                                                                                                                              |
| `services/billing`      | Rust       | core  | Usage, holds and settlements, limits, Stripe                                                                              | D1 `g1t-billing`                                                                      | `identity`, `packages`, `repos`                                                                                                                                                                        |
| `services/integrations` | Rust       | core  | The workspace's AI providers and Ask g1t, alert sources, issue trackers, the GitHub App                                   | D1 `g1t-integrations`                                                                 | `identity`, `projects`, `repos`, `work`                                                                                                                                                                |
| `services/webhooks`     | Rust       | core  | Webhook subscriptions and signed deliveries with retries                                                                  | D1 `g1t-webhooks`                                                                     | `identity`, `repos`                                                                                                                                                                                    |
| `services/og`           | TypeScript | core  | Social cards and page screenshots, at `og.g1t.sh`                                                                         | The screenshots bucket                                                                | `billing`, `identity`, `projects`, `repos`, `work`                                                                                                                                                     |

Calls go both ways in places, `repos` and `work` for one. That is allowed:
bindings only have to respect the deploy stages, and every service is in
the same one ([How g1t ships](/architecture/shipping/)).

## A call, on the wire

A service binding is a direct connection from one Worker to another in the
same data centre, with no trip over the public internet. g1t uses it as
plain HTTP:

```http
POST https://work/rpc/get_pull
content-type: application/json

{"repo": {"namespace": "acme", "name": "app"}, "number": 12, "viewer": {"id": "usr_…", "workspaces": […], …}}
```

The hostname is ignored; the method is the path. The arguments are that
method's struct in the contracts, here `ViewArgs` in
`crates/contracts/src/work.rs`. `viewer` is the person or token asking, or
`null` for someone signed out. The answer is always JSON:

```json
{ "ok": true, "value": { … } }
```

or, for anything the caller should handle, still with status 200:

```json
{ "ok": false, "error": { "code": "not_found", "message": "No pull request #12." } }
```

| Status               | Means                                               | The caller gets                                                        |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| 200 with `ok: true`  | It worked                                           | The value                                                              |
| 200 with `ok: false` | An expected failure, with a code from `FailureCode` | A value to handle, such as `Result` in TypeScript or `Outcome` in Rust |
| 404                  | No such method                                      | An error                                                               |
| 503                  | A store is busy, with `Retry-After`                 | An error                                                               |
| 500                  | Something threw                                     | An error                                                               |

On the Rust side, `g1t_kit::call(&binding, "method", &args)` sends a call
and `rpc_method`, `args` and `reply` serve one (`crates/kit/src/lib.rs`).
On the TypeScript side, the clients in `packages/contracts/src/clients.ts`
do both. Two Workers expose Worker RPC entrypoints instead: `og`'s
`Screenshots` and `status`'s `StatusAdmin`.

There is no secret between services. A service can be called only
through a binding, because none of them is published on `workers.dev`
and only `og` and `telemetry` have routes, for their own public endpoints.
That makes the binding list in each `wrangler.jsonc` the complete list of
who can call it.

## Contracts

Services share types, never code. Each one depends on the contracts, and
none on another service's crate or package.

| Package                                 | Holds                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/contracts` (`g1t-contracts`)    | A module per service with its data and its methods' arguments; `Outcome` and `Failure`; the event envelope and every event's data; `ROUTES`, which says which events each subscriber queue gets; `access`, the access rules every service compiles in; `scopes`; ids |
| `packages/contracts` (`@g1t/contracts`) | The same for TypeScript: each service's API type (`IdentityApi`, `ReposApi`, …), typed clients, `Result` and `FailureCode`, events, scopes, rate limits, the D1 session helper. TypeScript source, with no build step.                                               |
| `crates/kit` (`g1t-kit`)                | Plumbing for Rust Workers: the call protocol, D1 sessions and `Server-Timing` (`d1.rs`), rate limits that fail open, billing's platform pause, the snake_case converter, and handlers every service shares for renames, transfers and deletions                      |

Where the two languages must agree exactly, a Rust test reads the
TypeScript file and compares: the access table (`access.rs`), scopes, and
the shapes that have shared fixtures in JSON. Keep both in the same pull
request.

### Ids

Ids are TypeIDs: a prefix that says what the thing is, then a UUIDv7 in
Crockford base32, such as `evt_01jb…` for an event or `usr_…` for a person.
They sort by the time they were made, and are monotonic within one process
and millisecond (`crates/contracts/src/ids.rs`).

## Shared crates

| Crate              | What it is                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `crates/rules`     | The rulesets engine, with no I/O: which rules apply to a ref, and whether a push or a merge passes them                   |
| `crates/scan`      | Detectors for secrets, a git pack reader, lockfiles, OSV, the dependency graph, SPDX and SARIF                            |
| `crates/secrets`   | `Sealer`, AES-256-GCM with the row's id as associated data, and HMAC signatures                                           |
| `crates/blobstore` | The `BlobStore` port, with R2 and S3 adapters                                                                             |
| `crates/actions`   | Workflow syntax, expressions, filters, matrices and cron, with no I/O, used by both the `actions` service and the sandbox |
| `crates/runner`    | `g1t-runner`, the binary every sandbox and self-hosted runner runs                                                        |
| `crates/g1t`       | [The g1t CLI](/guides/cli/)                                                                                               |
| `crates/sshd`      | An SSH front end for git, not deployed yet                                                                                |

## Adding a service

1. Make it under `services/<name>`, with its `wrangler.jsonc`: its D1
   database if it keeps data, and `"workers_dev": false`.
2. Put its types in `crates/contracts` or `packages/contracts`, and its
   client in `packages/contracts/src/clients.ts` if the site calls it.
3. Add it to `deploy/stack.jsonc` with its kind, stage, secrets and
   `self_host`, then to the table above and to [How a self-hosted g1t
   runs](/guides/self-hosting-architecture/#each-part).
4. If it reacts to events, give it a `g1t-events-<name>` queue and a
   `SUBSCRIBER_*` binding on `events`, and add its event types to `ROUTES`
   ([Events](/architecture/events/#subscriber-queues)).
5. Run `npm run test:deploy`. It says what is missing.

[Deploy g1t to Cloudflare](/guides/deploy-to-cloudflare/) covers the
manifest's fields and a unit's first deploy.
