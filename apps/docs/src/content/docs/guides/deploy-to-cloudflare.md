---
title: Deploy g1t to Cloudflare
description: How g1t.sh is deployed to Cloudflare, and how to deploy the same code to an account of your own.
---

g1t.sh runs on Cloudflare, and the tool that deploys it is in the
repository. You can deploy the same code to a Cloudflare account of your
own. To run g1t on one machine without Cloudflare, see
[Run g1t yourself](/guides/self-hosting/) instead.

You need a Cloudflare account on the Workers Paid plan (Cloudflare
Artifacts, where repositories are kept, requires it), Node 22.22 or newer,
Rust with the `wasm32-unknown-unknown` target, and Docker to build the
runner's image.

Every `wrangler.jsonc` names g1t.sh's account, domains and resource ids.
Before a first deploy to another account, change those to your own (see
[A first deploy to a new account](#a-first-deploy-to-a-new-account)).

## The pieces

| Piece | Where |
| --- | --- |
| The manifest: every deployable part | `deploy/stack.jsonc` |
| The tool | `scripts/deploy.mjs`, with its library and tests in `scripts/deploy/` |
| Rust Worker builds | `scripts/build-rust-worker.mjs` |
| The runner's images | `services/runner/base/Dockerfile`, `services/runner/Dockerfile`, `services/runner/base.json` |
| The workflows | `.g1t/workflows/deploy.yml`, `.g1t/workflows/runner-base.yml` |

## The manifest

`deploy/stack.jsonc` lists every unit: each folder with a `wrangler.jsonc`.

| Field | What it is |
| --- | --- |
| `path` | The unit's folder |
| `kind` | `rust-worker`, `ts-worker`, `react-router` or `astro` |
| `worker` | The Worker's name. It must match its `wrangler.jsonc`. |
| `d1` | `{ database, migrations }`, when it has a database |
| `stage` | `core`, `edge` or `front` (below) |
| `secrets` | The Wrangler secrets it needs, by name |
| `setup` | One-time steps a first deploy needs that no config can say |
| `inputs` | Files outside its folder it is built from that no package names |
| `image` | A Containers image, for the runner |
| `self_host` | `run`, `off`, `separate` or `none`: what a [self-hosted installation](/guides/self-hosting-architecture/) does with it |

What a unit is built from is read, never listed by hand: Rust path
dependencies from `cargo metadata`, workspace packages from each
`package.json`. A lockfile change counts for a unit only when a package
it uses changed. `node scripts/deploy.mjs manifest` prints the result.

Units deploy in stages. A stage starts only when the one before it
succeeded, and units inside a stage deploy in parallel:

| Stage | What |
| --- | --- |
| `migrations` | Every pending D1 migration, before any code |
| `core` | The services, reached through bindings |
| `edge` | Public endpoints other than the site: `api`, `models`, `pages`, `status` |
| `front` | The site, sudo and the docs |

A unit binds only to units in its own stage or an earlier one, so new code
never calls a service that has not shipped. `npm run test:deploy` checks
this, and that every `wrangler.jsonc` has a unit whose names match it.
Cloudflare refuses a Worker bound to a Worker that does not exist, so
inside a stage a unit whose Worker has never been deployed (a new or
renamed one) goes first, and the units of its stage that bind to it go
after it succeeds.

## The tool

```sh
node scripts/deploy.mjs plan                    # what would deploy, and why (read-only)
node scripts/deploy.mjs deploy                  # migrations, then every changed unit
node scripts/deploy.mjs deploy --only web,api   # just these, if they changed
node scripts/deploy.mjs deploy --only web --force   # just this, changed or not
node scripts/deploy.mjs deploy --all            # everything
node scripts/deploy.mjs build --only events     # build as a deploy would; upload nothing
node scripts/deploy.mjs migrate                 # pending migrations only
node scripts/deploy.mjs manifest --check        # the manifest's problems
node scripts/deploy.mjs doctor                  # secrets each unit lacks
node scripts/deploy.mjs build-base              # build and push the runner's base image (Docker)
node scripts/deploy.mjs image                   # build and push the runner's image (Docker)
```

| Flag | What it does |
| --- | --- |
| `--only a,b`, `--skip a,b` | Units by short name, folder or Worker name |
| `--all` | Every unit, changed or not |
| `--force` | The selected units even if unchanged |
| `--concurrency N` | Units at once inside a stage, and migrations at once (default 4) |
| `--stage core` | One stage only |
| `--no-migrations` | Skip the migrations step |
| `--allow-dirty` | Deploy with uncommitted changes. The version records no commit, so the next plan deploys it again. |
| `--rebuild-image`, `--rebuild-base` | Build the runner's image, or its base, even if one exists |
| `--rollback` | Allow deploying a commit older than the one live |
| `--since REV` | Treat Workers with no recorded commit as running `REV` |

**Only what changed deploys.** Each deploy records its commit on the
Worker's version (`wrangler deploy --message "g1t-deploy <sha> ..." --tag
g1t-<sha>`). `plan` reads the live version of each Worker, diffs from its
commit to `HEAD`, and deploys the units the change touches. A change only
to a crate's tests deploys nothing. A version deployed any other way has
no commit, so the unit is deployed again.

With `CLOUDFLARE_API_TOKEN` (in CI) or `CLOUDFLARE_DEPLOY_TOKEN` (on your
machine) and `CLOUDFLARE_ACCOUNT_ID`, `plan` reads Cloudflare's API itself
and takes a few seconds. With only `wrangler login`, it asks Wrangler and
takes minutes. Each unit's output is kept in `$TMPDIR/g1t-deploy/<unit>.log`.

### Migrations run while the old code is live

Migrations apply before any code, so for a minute or more the old code
reads the new schema. Keep it working:

- **Add, never change meaning.** New tables and columns with defaults are
  safe.
- **Change meaning in two deploys.** First ship code that reads both forms;
  then the migration that rewrites the rows.
- **Never drop or rename** a column or table in the same deploy that stops
  reading it.

Migrations never run backwards: undoing one is a new migration.

## The workflow

`.g1t/workflows/deploy.yml` runs the tool on every push to `main`, and by
hand (**Actions → Deploy → Run workflow**) with `units`, `all` and
`dry_run`.

| Job | Does |
| --- | --- |
| `check` | `manifest --check` and `npm run test:deploy` |
| `plan` | The plan, shown in the run's summary |
| `migrate` | Pending migrations; skipped when there are none |
| `core`, `edge`, `front` | Each stage's units, one job per build group |
| `smoke` | Loads the landing page, sign-in, sign-up and pricing |

Deploys run one at a time; a second push waits. Rust units build on
`g1t-4core` machines, at most four to a job, with Cargo's target and
sccache kept in the Actions cache.

The deploy jobs use `environment: production`, so only they can read the
Cloudflare token. They reach Cloudflare through the project's
[workflow-only domains](/guides/guardrails/), under **Settings →
Guardrails**:

```text
api.cloudflare.com | deploy.yml | production
registry.cloudflare.com | deploy.yml, runner-base.yml | production
```

Every deploy shows on the repository's Deployments page. A deploy run by
hand reports one too when `G1T_DEPLOY_TOKEN` holds a g1t token with
`deployments:write`.

### The Cloudflare API token

Make a custom token at **dash.cloudflare.com → My Profile → API Tokens**,
restricted to your account and zones:

| Scope | Permission |
| --- | --- |
| Account | Workers Scripts: Edit |
| Account | D1: Edit |
| Account | Queues: Edit |
| Account | Workers R2 Storage: Read |
| Account | Account Settings: Read |
| Account | Containers: Edit |
| Zone | Workers Routes: Edit |
| Zone | DNS: Edit |
| Zone | Zone: Read |

Store it on the repository under **Settings → Secrets and variables** as
the secret `CLOUDFLARE_API_TOKEN`, for workflows in the `production`
environment, and your account id as the variable `CLOUDFLARE_ACCOUNT_ID`.
A missing permission fails with `Authentication error [code: 10000]` and
the route it was refused on.

## A first deploy to a new account

What the configs refer to must exist first.
`node scripts/deploy.mjs manifest --json` lists, for each unit, its
queues, KV namespaces, R2 buckets, Vectorize indexes and dispatch
namespaces; its `setup` and `secrets` say the rest.

1. Set `account_id`, routes and custom domains in each `wrangler.jsonc` to
   your own.
2. D1: `npx wrangler d1 create <database>` for each, and put its id in the
   unit's `wrangler.jsonc`.
3. KV: `npx wrangler kv namespace create <name>` for each name under
   `resources.kv` in the manifest, and put the ids in the configs.
4. Queues: `npx wrangler queues create <queue>` for each queue in the
   manifest, including the dead-letter queue `g1t-events-dlq`.
5. R2: create `g1t-screenshots`, `g1t-actions-cache` and `g1t-git-packs`,
   with lifecycle rules:

   ```sh
   npx wrangler r2 bucket lifecycle add g1t-actions-cache expire-cache c/ --expire-days 30 --abort-multipart-days 1
   npx wrangler r2 bucket lifecycle add g1t-actions-cache expire-artifacts a/ --expire-days 91 --abort-multipart-days 1
   npx wrangler r2 bucket lifecycle add g1t-git-packs expire-packs packs/ --expire-days 7 --abort-multipart-days 1
   ```

6. The runner's base image: `node scripts/deploy.mjs build-base`, then
   commit `services/runner/base.json`.
7. Everything else each unit's `setup` names: Vectorize, the dispatch
   namespace, DNS, Access, Email Sending and Artifacts.
8. Secrets: `npx wrangler secret put <NAME>` in the unit's folder.
   `node scripts/deploy.mjs doctor` lists what is missing.
9. For [Deployments](/guides/deployments/), which need the Workers for
   Platforms add-on and a zone for apps: `scripts/setup-deployments.sh`.
10. Durable Objects: the artifacts service's v3 migration
    (`services/artifacts/wrangler.jsonc`) moves g1t.sh's live rooms from
    the Worker it was renamed from, which a new account does not have.
    Replace it with
    `{ "tag": "v3", "new_sqlite_classes": ["PageRoom", "FolioRoom"] }`.
11. `node scripts/deploy.mjs deploy --all`. Inside a stage, Workers that do
    not exist yet go before those bound to them; a Worker bound to one in a
    later stage, or to one that failed, is refused until it exists.
12. Register on your site to make the first account, or run
    `node services/identity/scripts/create-user.mjs <username>`.

### Adding a unit

1. Make its folder with a `wrangler.jsonc`. A Rust Worker is a member of
   the root `Cargo.toml`, with `node ../../scripts/build-rust-worker.mjs`
   as its build command and `wasm-opt = ["-O1"]`; a TypeScript one is an
   npm workspace.
2. Add it to `deploy/stack.jsonc` in the earliest stage after everything
   it binds to, with its secrets, setup and `self_host`.
3. Add a row for it to the table in
   [How a self-hosted g1t runs](/guides/self-hosting-architecture/#each-part).
4. `npm run test:deploy` and `node scripts/deploy.mjs manifest --check`
   say what is missing.

### Renaming a Worker

A Worker's name is its identity on Cloudflare, so a renamed Worker is a
new one. Keep its resources: D1 databases, R2 buckets, Vectorize indexes
and queues are bound by id or name and keep theirs. Durable Objects
belong to a Worker, so the new one takes them with a
[transfer migration](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#transfer-migration)
(`transferred_classes`, with `from_script` the old name), every object's
storage with them; until the old Worker is deleted, its own bindings to
them reach the new one. A queue has one consumer, so the old Worker lets
go of it first.

The artifacts service was `g1t-docs-service` (`services/docs`) and is
`g1t-artifacts` (`services/artifacts`). An installation that ran the old
one moves once, in this order:

1. Let go of the queue. Its messages wait for the new consumer:

   ```sh
   npx wrangler queues consumer remove g1t-events-docs g1t-docs-service
   ```

2. Deploy: push to `main`, or `node scripts/deploy.mjs deploy`.
   `g1t-artifacts` goes first in `core`, takes `PageRoom` and `FolioRoom`
   and the queue; then `agents`, then `api` (edge) and `web` (front),
   each bound to it. Until each has gone out it still calls
   `g1t-docs-service`, which answers from the same database, bucket and
   (forwarded) rooms.
3. Check: an artifact opens with its content and edits live, a file
   uploads, and `npx wrangler queues info g1t-events-docs` names
   `g1t-artifacts` as the consumer. Cloudflare's
   `GET /accounts/{account_id}/workers/durable_objects/namespaces` lists
   `PageRoom` and `FolioRoom` under `g1t-artifacts`.
4. After a day with no requests to it (`npx wrangler tail g1t-docs-service`
   shows only its 03:17 UTC cron), delete it by hand:
   `npx wrangler delete g1t-docs-service`. Never with `--force`: a refusal
   means something still binds to it.

If step 2 fails before `g1t-artifacts` deploys, nothing moved: put the
consumer back with `npx wrangler deploy` in `services/docs` at the
previous commit. Once it has deployed, the rooms are its own: fix forward.

## The runner's images

`services/runner` runs every sandbox (agents, checks, the merge queue,
workflow jobs and deploy builds) from one Containers image in two parts:

| Image | Built from | Rebuilt |
| --- | --- | --- |
| The base | `services/runner/base/Dockerfile`: Debian, Node, Python, Docker, Go, Rust, Java, .NET, Ruby and the Claude Code CLI | When its folder changes, weekly by `runner-base.yml`, or by hand with `build-base` |
| The runner | `services/runner/Dockerfile`: the base plus the `g1t-runner` binary | When the binary or the base changes |

`services/runner/base.json` records the base that was pushed;
`npm run test:deploy` fails while it and the base's folder disagree. The
runner's image is tagged with a hash of what it is built from, so a deploy
builds it only when the registry does not already have it. When nothing
the image is built from changed, the deploy leaves running sandboxes
alone.

Jobs choose larger machines with `runs-on: g1t-2core` or `g1t-4core`. Your
account's Containers limits must allow `standard-4`.

Set the runner Worker's `DOCKER` variable to `off` to give workflow jobs no
Docker Engine.

`CLOUDFLARE_API_TOKEN=<token> node scripts/ops/runner-errors.mjs` sorts the
sandboxes' errors over the last 7 days into expected ones (a deploy
resetting them, no free capacity, a container that stopped) and ones to
read.

## Rolling back

- **One unit, at once:** `npx wrangler rollback` in its folder. Revert the
  commit on `main` too, or the next push brings it back.
- **To a commit:** check it out and run
  `node scripts/deploy.mjs deploy --only <units> --rollback`. Without
  `--rollback` the tool refuses a unit whose live commit is newer.
- **The runner's image:** redeploy the older commit with
  `--only runner --rollback`; its image is still in the registry.

## Other one-time setup

### The dead-letter queue

Every queue consumer retries a message a fixed number of times, then puts
it on `g1t-events-dlq`. Nothing consumes that queue: read it with
`npx wrangler queues info g1t-events-dlq`, fix the cause, and replay by
hand.

### OIDC tokens for workflow jobs

The API issues workflow jobs' [OIDC tokens](/guides/actions/), signed with
an RSA key in its secret `ACTIONS_OIDC_KEY`. Without it, jobs get no
tokens.

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc.pem
cd apps/api && npx wrangler secret put ACTIONS_OIDC_KEY < ../../oidc.pem
rm ../../oidc.pem
```

To rotate it, store the current key as `ACTIONS_OIDC_KEY_PREVIOUS`, store
a new one as `ACTIONS_OIDC_KEY`, and delete the previous one a day later.
For a key that may have leaked, skip keeping the previous one.

### Telling the status page about deploys

Restarts during a deploy can look like an outage to the status page's
checks. Set the same value as the status Worker's secret
`STATUS_DEPLOY_TOKEN` and as the repository's Actions secret
`STATUS_DEPLOY_TOKEN`, and add the status page's host to the workflow-only
domains. Deploys then announce their start and finish, and the status page
drafts no incident during them or for 3 minutes after.

### Browser push

`node scripts/ops/vapid-keys.mjs` prints a VAPID key pair. Put the public
half in `VAPID_PUBLIC_KEY` in `services/notify/wrangler.jsonc` and the
private half in the secret `VAPID_PRIVATE_KEY`.

## Rate limits

Every public surface that costs money or sends something is behind a
[Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
binding, with the limits on the [rate limits](/reference/rate-limits/)
page. The binding's `namespace_id` must be unique in your account. A
missing binding, or one that fails, lets requests through.

## Spend guardrails

Cloudflare has no hard spending cap. Besides each workspace's own
[limits](/guides/usage-and-billing/), g1t watches the platform as a whole:

- **The hourly watch.** At a quarter past each hour, billing reads the
  hour before from Cloudflare's GraphQL Analytics API: Workers requests
  and CPU, D1 rows, Queue operations, Durable Objects, KV and Artifacts.
  It needs `CLOUDFLARE_BILLING_TOKEN` (or `CLOUDFLARE_USAGE_TOKEN`) with
  Account Analytics Read. An hour over its threshold, or over ten times
  the week's median hour, is emailed to `COSTS_ALERT_EMAIL`.
- **Thresholds** are the `PLATFORM_HOURLY_*` variables in
  `services/billing/wrangler.jsonc`; `0` turns one off. A breach at five
  times its threshold pauses the kinds of work in `AUTO_PAUSE`.
- **The platform pause** stops a kind of work everywhere: `compute`
  (sandboxes), `schedules`, `indexing` or `renders` (social cards). Staff
  pause and resume in sudo, under **Costs & margin**. Work already
  running finishes, and if the pause cannot be read, nothing is paused.
- **Check the watch's queries** after changing them:
  `CLOUDFLARE_API_TOKEN=<token> node scripts/ops/platform-usage.mjs`. It
  exits 1 and names any dataset that errored or answered empty.

In Cloudflare's dashboard, which no code can set, add **Billable Usage**
notifications for each product g1t uses, a monthly **Budget alert**, and a
notification destination that reaches someone.

## Logs

Each Worker keeps a share of its invocations' logs, set by
`head_sampling_rate` in its `wrangler.jsonc`: every one for billing,
identity, runner, actions, deployments, status and sudo, and a tenth for
the rest. Metrics are not sampled. To chase a rare error on a sampled
Worker, raise its rate to 1 while you look.
