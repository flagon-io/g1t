---
title: How a self-hosted g1t runs
description: What runs inside the Docker Compose installation, what stands in for each Cloudflare service, and what each part of g1t does when you run it yourself.
---

[Run g1t yourself](/guides/self-hosting/) starts g1t with Docker Compose.
This page is for the person who keeps that installation running: what is
inside it, what stands in for each Cloudflare service g1t.sh uses, and
where the limits are.

## The shape

g1t is a set of Workers, one per service, each with its own SQLite
database. They call each other over HTTP (`POST /rpc/<method>` with a JSON
body). A self-hosted installation runs the same Workers, built from the
same source, in workerd, the open-source Workers runtime, under
`wrangler dev`:

- **The site and every core service** run in one workerd process on
  `G1T_PORT` (8787). Their databases, key-value stores and queues are
  SQLite files on the `g1t-data` volume.
- **The API and the MCP server** run in a second workerd on `API_PORT`
  (8789), started once the first answers. It reaches the other services
  through Wrangler's local registry.
- **The status page** runs in a process of its own (`status.sh`), so it
  keeps answering when the site does not.

Three Cloudflare services are replaced by small Workers bound in their
place, so no service's code changes:

| Binding | Stands in for | Self-hosted |
| --- | --- | --- |
| `GITSTORE` | Cloudflare Artifacts, where g1t.sh keeps repositories (the repos service's git store) | `deploy/self-host/workers/gitstore`, in front of the git store: bare repositories on the `g1t-git` volume, served with `git http-backend`. Access tokens are HMAC-signed, scoped and expire. Forks are clones with hard-linked objects. |
| `EMAIL` | Cloudflare Email Sending | `deploy/self-host/workers/mail`: logs each message and hands it to Mailpit, which can relay through your SMTP server |
| The runner, the context hub and the model proxy | Containers, Vectorize, Workers AI and AI Gateway | `deploy/self-host/workers/off`: answers that the feature is off, which every page that uses them shows |

## What is in `deploy/self-host`

| File | What it is |
| --- | --- |
| `docker-compose.yml` | The services: `g1t`, `status`, `gitstore`, `rustfs` (S3-compatible storage), `storage-setup` (makes the buckets once, then exits) and `mailpit`. Volumes: `g1t-data`, `g1t-git`, `g1t-objects`, `g1t-status`, `g1t-secrets`. |
| `Dockerfile` | Compiles the Rust services to WebAssembly and builds the site, as g1t.sh's deploys do. The image has Node, Wrangler, workerd and the built Workers. |
| `start.sh` | Makes the sealing keys on first start, writes the configs, applies database migrations, then starts both workerd processes and the scheduler. |
| `configs.mjs` | Writes each Worker's self-hosted config from its `wrangler.jsonc`: drops routes, the account and placement, binds the stand-ins above, points packages, backups, clone packs and files in pages at the S3 store, and replaces g1t.sh's addresses with yours. What runs, and what is bound to the off stand-in, comes from each part's `self_host` field in `deploy/stack.jsonc`. |
| `scheduler.mjs` | Runs scheduled jobs (below). |
| `gitstore/` | The git store. |
| `workers/` | The three stand-ins. |
| `smoke.sh` | The end-to-end check in [Check an installation](/guides/self-hosting/#check-an-installation). |

## Each part

| Part | Self-hosted |
| --- | --- |
| `apps/web` | Runs: the site, on `G1T_PORT` |
| `apps/api` | Runs in the second workerd, on `API_PORT`. `API_URL` is its OAuth issuer and MCP is at `/mcp` on it. Actions artifacts need the runner, which is off. |
| `apps/status` | Runs in a process of its own; see [the status page](/guides/self-hosting/#the-status-page) |
| `apps/sudo` | Not run. It is g1t.sh's staff console, behind Cloudflare Access. |
| `apps/docs` | Not run: docs.g1t.sh serves these pages |
| `services/identity` | Runs; its email goes to Mailpit |
| `services/repos` | Runs, against the git store. Nightly backups are queued but cut by the runner, which is off, so none are made yet. Clone packs are kept in the `g1t-git-packs` bucket. |
| `services/work` | Runs |
| `services/events` | Runs: the event bus, on local queues |
| `services/projects` | Runs |
| `services/search` | Runs: site search is SQLite full-text search |
| `services/chat` | Runs, with its Durable Objects; custom emoji are kept with avatars |
| `services/artifacts` | Runs: [artifacts](/guides/artifacts/) and their spaces, with their live rooms. Files people add are kept in the `g1t-docs-files` bucket. Search matches words, not meaning, because there is no embedding model. |
| `services/notify` | Runs. Notifications are live in open tabs; browser push needs a VAPID key pair, which an installation does not make. |
| `services/agents` | Runs, but replies need the model proxy, which is off, so an agent answers with a short apology |
| `services/billing` | Runs with nothing charged and no usage limit |
| `services/integrations` | Runs |
| `services/webhooks` | Runs, retries included |
| `services/actions` | Runs. Jobs need the runner, which is off. |
| `services/packages` | Runs, with files in the `g1t-packages` bucket and no request size limit |
| `services/security` | Runs, with its sweeps on schedule |
| `services/deployments` | Runs with no Cloudflare token, so nothing deploys; its pages and settings still show |
| `services/runner` | Off: agents, checks run by g1t, merge queue testing and workflow jobs |
| `services/context` | Off: the context hub |
| `services/models` | Off: g1t's hosted models |
| `services/pages` | Not run: there is no `g1t.page` |
| `services/og` | Not run: pages have no social cards |

## Scheduled jobs

workerd runs a Worker's scheduled handler only when asked. `scheduler.mjs`
asks once a minute, inside the `g1t` container, through Wrangler's local
API, for each due schedule in the Workers' own configs: repos, events,
identity, security, webhooks, packages and docs. A job still running from
the minute before is not started again, and one is given up on after ten
minutes.

Not run: Actions schedules (`on: schedule`, which would need the runner),
billing and deployments.

`node deploy/self-host/scheduler.mjs --once /data/generated/schedules.json`
runs every job once and exits non-zero if one failed.

## Storage

Every bucket is on the bundled RustFS, or on any S3-compatible store you
point `S3_ENDPOINT` at (MinIO, Ceph, Garage or AWS S3). `storage-setup`
makes them on the bundled store; on another store, make them yourself.

| Bucket | Holds | Setting |
| --- | --- | --- |
| `g1t-packages` | Container image layers and other package files | `S3_BUCKET` |
| `g1t-git-packs` | Packs for fresh clones, a cache. Give it a rule that deletes objects after 7 days and aborts multipart uploads after a day. | `PACK_S3_BUCKET` |
| `g1t-backups` | Nightly repository backups, once the runner cuts them | `BACKUP_S3_BUCKET` |
| `g1t-docs-files` | Images and files added to pages and artifacts | `DOCS_S3_BUCKET` |

Requests to the store are signed with AWS Signature Version 4, path style.

## Limits

- **Use it on `localhost` or a private network you trust.** `wrangler dev`
  is a development server: it answers its own development endpoints
  (`/cdn-cgi/...`) on the same port as the site.
- **One machine.** Every database is a SQLite file with one writer. It
  suits a team, not a large organisation.
- **HTTPS anywhere but `localhost`.** Sign-in cookies are `Secure`; put a
  proxy with a certificate in front and set `PUBLIC_URL` to its
  `https://` address.
- **If the API says a binding is `[not connected]`**, restart the
  container: the API finds the other services through Wrangler's local
  registry.
- **Building takes minutes and several GB**, because every Rust service is
  compiled from source. A change that does not compile breaks the image,
  so build from a released commit.
- **Some links still leave your installation**: the docs links go to
  docs.g1t.sh, and the Status links to status.g1t.sh.
