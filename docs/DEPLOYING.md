# Deploying g1t

How g1t.sh gets to Cloudflare: one manifest that lists every deployable
unit, one tool that deploys only what changed, and a g1t Actions workflow
that runs that tool on every push to `main`. Internal: the public
self-hosting guide is `apps/docs/src/content/docs/guides/self-hosting.md`.

| Piece | Where |
| --- | --- |
| The manifest | `deploy/stack.jsonc` |
| The tool | `scripts/deploy.mjs` (library and tests in `scripts/deploy/`) |
| Rust Worker builds | `scripts/build-rust-worker.mjs`, every Rust unit's build command |
| The workflow | `.g1t/workflows/deploy.yml` |
| The old entry point | `scripts/deploy.sh`, now a wrapper |

## The manifest

`deploy/stack.jsonc` names every unit: each folder with a `wrangler.jsonc`.
It is JSONC rather than TOML so that Node reads it with no dependency,
with the same parser as the Wrangler configs, and comments stay possible.

| Field | |
| --- | --- |
| `path` | The unit's folder. |
| `kind` | `rust-worker` (built by worker-build), `ts-worker` (Wrangler bundles it), `react-router` (`vite build` first), `astro` (`astro build` first). |
| `worker` | The Worker's name. Must match its `wrangler.jsonc`. |
| `d1` | `{ database, migrations }`, when it has a database. Must match its `wrangler.jsonc`. |
| `stage` | `core`, `edge` or `front` (below). |
| `secrets` | The Wrangler secrets it needs, by name. `node scripts/deploy.mjs doctor` checks they are set. |
| `setup` | One-time steps no config can say, for a first deploy. |
| `inputs` | Files outside its folder it is built from that no workspace metadata names. A test finds such imports. |
| `image` | A Containers image (`dockerfile`, and the `crate` it compiles), which needs Docker to build. |
| `self_host` | `run`, `off`, `separate` or `none`: what `deploy/self-host/configs.mjs` does with it. |

What a unit is **built from** is never listed by hand. The tool reads it:
Rust path dependencies from `cargo metadata`, workspace packages from each
`package.json`, closed transitively. `node scripts/deploy.mjs manifest`
prints the result:

```
unit          stage  kind          worker            d1                built from (besides its folder)
events        core   rust-worker   g1t-events        g1t-events        crates/contracts crates/kit
repos         core   rust-worker   g1t-repos         g1t-repos         crates/contracts crates/kit crates/scan crates/secrets
runner        core   ts-worker     g1t-runner                          crates/actions crates/runner packages/contracts
og            core   ts-worker     g1t-og                              packages/contracts
web           front  react-router  g1t                                 packages/contracts packages/theme
...
```

Root files count too: `Cargo.toml`, `Cargo.lock` and
`scripts/build-rust-worker.mjs` for Rust units; `package-lock.json` and
`tsconfig.base.json` for the others; `package.json` for all. A lockfile
change counts for a unit only if a package in that unit's graph changed,
read from the lockfile itself (`scripts/deploy/lockfiles.mjs`), so bumping
`sharp` for the docs does not redeploy the Rust services.

### Stages

| Stage | What | Units |
| --- | --- | --- |
| `migrations` | Every pending D1 migration, in parallel, before any code | each unit's `d1` |
| `core` | Services reached through bindings | the services, `og` |
| `edge` | Public endpoints other than the site | `api`, `models`, `pages`, `status` |
| `front` | The site, sudo, the docs | `web`, `sudo`, `docs` |

A stage starts only when the one before it succeeded. Inside a stage units
deploy in parallel. The rule the tests enforce: **a unit binds only to units
in its own stage or an earlier one**, so new code never calls a service
that has not shipped. (Services in `core` bind to each other in cycles,
which is why they share a stage.)

### What reads the manifest

- `scripts/deploy.mjs`: everything below.
- `deploy/self-host/configs.mjs`: which Workers a self-hosted installation
  runs (`self_host: "run"`, the site first) and which are bound to the off
  Worker (`"off"`). Its output is identical to before, apart from the order
  of `workers.txt` after the site.
- Tests (`npm run test:deploy`) check that: every `wrangler.jsonc` in the
  repository has a unit; `worker`, `d1` and `image` match the configs;
  every KV id is named under `resources.kv`; stages follow bindings; the
  derived dependencies agree with Cargo's own resolved graph; every import
  that leaves a unit's folder is covered; `deploy/self-host/Dockerfile`
  builds exactly the Rust units self-hosting runs; and the service table in
  `docs/SELF_HOSTING.md` names every unit.

## The tool

```sh
node scripts/deploy.mjs plan                 # what would deploy, and why (read-only)
node scripts/deploy.mjs deploy               # migrations, then every changed unit
node scripts/deploy.mjs deploy --only web,api   # just these, if they changed
node scripts/deploy.mjs deploy --only web --force   # just this, changed or not
node scripts/deploy.mjs deploy --all         # everything
node scripts/deploy.mjs build --only events  # build as a deploy would; upload nothing
node scripts/deploy.mjs migrate              # pending migrations only
node scripts/deploy.mjs manifest [--check|--json]
node scripts/deploy.mjs doctor               # secrets each unit lacks
scripts/deploy.sh [units...]                 # the old entry point: all, or those named, always
```

| Flag | |
| --- | --- |
| `--only a,b` / `--skip a,b` | Units by short name, folder or Worker name. |
| `--all` | Every unit, changed or not. |
| `--force` | Deploy the selected units even if unchanged. |
| `--concurrency N` | Units at once inside a stage, and migrations at once (default 4). |
| `--stage core` | One stage only. |
| `--no-migrations` | Skip the migrations step (the workflow runs it as its own job). |
| `--allow-dirty` | Deploy with uncommitted changes in what deploys. The version records no commit, so the next plan deploys it again. |
| `--rebuild-image` | Build the runner's image even if nothing it is built from changed. |
| `--since REV` | Treat Workers with no recorded commit as running `REV`. Used once to adopt Workers deployed before this tool. |
| `--json`, `--out FILE`, `--github-output` | The plan as data, for the workflow. |

### Where the deployed commit is kept

On the Worker itself. Every deploy runs `wrangler deploy --message
"g1t-deploy <40-char sha> <subject>" --tag g1t-<12-char sha>`, which
Cloudflare keeps as the version's `workers/message` and `workers/tag`
annotations. `plan` reads them back with `wrangler deployments status`
(the live version) and `wrangler versions list` (its annotations): two
read-only calls per unit, in parallel; a plan of all 22 units takes about
10 seconds. No KV namespace or other infrastructure is needed.

- A version made by `wrangler secret put` keeps the code of the one before
  it, so the tool looks through those to the deploy before.
- A version deployed any other way (by hand, from the dashboard) has no
  commit, and the unit is deployed again.
- During a gradual rollout the version with the most traffic counts.
- After `wrangler rollback`, the plan sees the older commit and deploys
  what changed since.

### What a deploy does

1. Plans: for each unit, the live commit; `git diff` from it to `HEAD`;
   whether the changed files touch the unit (its folder, the crates and
   packages it is built from, its inputs, lockfile changes that reach it).
2. Refuses if uncommitted changes touch what would deploy (`--allow-dirty`).
3. Applies every pending migration (`wrangler d1 migrations apply --remote`),
   in parallel. Any failure stops the deploy before code.
4. Installs worker-build once if any Rust unit is deploying.
5. Each stage in turn: units in parallel (`--concurrency`), each `npm run
   build` first for React Router and Astro, then `wrangler deploy` in the
   unit's folder with the annotation. If any unit fails, later stages are
   not started.
6. Prints a table: unit, stage, result, version id, time. Each unit's full
   output is kept in `$TMPDIR/g1t-deploy/<unit>.log`.

On a laptop the tool uses your `wrangler login` (or `CLOUDFLARE_DEPLOY_TOKEN`
if set), as `scripts/deploy.sh` always did: a `CLOUDFLARE_API_TOKEN` or
global API key in your shell, or in the repository's `.env`, is ignored.
With `CI=true` it uses `CLOUDFLARE_API_TOKEN`.

### The runner's image

`services/runner` deploys a Containers image built from
`services/runner/Dockerfile`, which needs Docker. The tool rebuilds it only
when something the image is built from changed since the runner's live
commit (the Dockerfile, `crates/runner` and the crates it uses,
`Cargo.toml`, `Cargo.lock`), or with `--rebuild-image`. Otherwise it deploys
the Worker with `--containers-rollout none`, which leaves the running image
alone. g1t Actions sandboxes have no Docker, so a CI deploy that needs a new
image fails that unit with what to do, and later stages wait:

```sh
node scripts/deploy.mjs deploy --only runner   # on a machine with Docker
```

then re-run the workflow; its plan now sees the runner up to date.

## Build speed

Measured on the development machine (Windows, 32 cores, warm Cargo cache),
building `events`, `search` and `repos` after a change to `crates/kit`, as a
deploy does but without uploading (`wrangler deploy --dry-run`):

| | Time |
| --- | --- |
| Before: one after another, `cargo install worker-build` each time, wasm-opt `-O` | 81 s, 84 s |
| Concurrent builds, wasm-opt `-O` | 50 s, 68 s |
| Concurrent builds, wasm-opt `-O1` (now) | 28 s, 33 s |

Where the time went, and what changed:

- **wasm-opt** was most of it: `-O` took 38 s on `repos` and 19 s on `api`;
  `-O1` takes 1 to 3 s. With worker-build's flags (it keeps the names
  section) the `.wasm` is 24 to 28% larger raw but only 1 to 7% larger
  gzipped, and Workers' size limit is on the compressed upload. `-Os` and
  `-Oz` were no faster than `-O`. Set per crate in
  `[package.metadata.wasm-pack.profile.release]`; a test keeps every Rust
  unit on the same level.
- **worker-build** is installed only when missing or another version
  (`scripts/build-rust-worker.mjs`, which pins it). Locally `cargo install`
  on an installed version cost under a second; on a fresh CI sandbox it is
  a full compile, which the workflow caches instead.
- **One Cargo target**: every Rust unit is a member of the workspace, so
  they already share `target/`. Concurrent builds take turns on Cargo's
  lock for the compile, and their wasm-bindgen, wasm-opt and uploads
  overlap.
- **No joint `cargo build -p a -p b`**: tried, and it is slower. Cargo
  unifies features across the packages of one build (`serde_json`'s
  `preserve_order` from `api` and `actions`, `digest` features from
  `secrets`), so each worker-build afterwards compiled its own variant
  again.
- **Only what changed** is the largest saving: a change to one service
  deploys one service.

## The workflow

`.g1t/workflows/deploy.yml` runs on every push to `main`, and by hand
(**Actions → Deploy → Run workflow**) with `units` (deploy these, changed or
not), `all` and `dry_run` (plan only).

| Job | Does | Needs |
| --- | --- | --- |
| `check` | `manifest --check` and `npm run test:deploy` | — |
| `plan` | `plan --github-output`: outputs per stage, the plan in the run's summary | `check` |
| `migrate` | `migrate --only <units with pending migrations>` | `plan`; skipped when none are pending |
| `core`, `edge`, `front` | `deploy --only <units> --force --no-migrations`, one job per build group | the stages before; skipped when empty |

- **One at a time:** `concurrency: deploy-production`, never cancelled in
  progress; a second push waits.
- **Build groups:** a stage's units are split so each job shares a build:
  Rust workers at most four to a job (a sandbox has half a CPU), the
  TypeScript Workers together, each site alone, and a unit whose image must
  be rebuilt alone. `fail-fast: false`, so one failed job does not cut
  another off mid-upload; the next stage then does not start.
- **Tests:** there is no CI workflow on g1t yet; `main` is kept passing by
  the merge queue's checks. `check` runs the deploy tool's own tests. When a
  CI workflow is added, make `plan` wait for it (`workflow_run`, or a job in
  this file).
- **Caching** (`actions/cache`, kept per repository for 7 days, at most
  60 MB an entry): the worker-build binary, worker-build's downloaded tools,
  and `~/.cargo/registry/cache`. Not cached: the Cargo target directory
  (about 500 MB for these crates) and npm's cache (over 150 MB), so every
  Rust job compiles its crates from scratch and every job runs `npm ci` of
  only what its units need (`deploy.mjs install`: Wrangler alone for Rust
  jobs).
- `crates/actions/tests/repository_workflows.rs` reads the workflow with
  g1t's own parser and expressions, and checks the jobs start, wait and
  stop as above (`cargo test -p g1t-actions --test repository_workflows`).

### What the sandbox has

The runner image (`services/runner/Dockerfile`) has Node 24, npm, git, and
Rust stable for the `node` user (rustfmt, clippy) but not the
`wasm32-unknown-unknown` target, worker-build or Docker. The workflow adds
the target (`rustup target add`, from `static.rust-lang.org`) and restores
worker-build from the cache, installing it on a miss. worker-build fetches
wasm-bindgen and wasm-opt from GitHub releases and esbuild from npm. All
of those hosts are on the list every workflow job may reach.

Adding the wasm target and worker-build to the image instead would save
about a minute per Rust job, but every image change needs a Docker deploy of
the runner and replaces every sandbox, so it is left for when the image
next changes anyway.

### Network

A workflow job reaches only its project's allowed domains, g1t, and what
builds need (`services/runner/src/egress.ts`, `BUILD_HOSTS`). Cloudflare's
API is not among them for workflows (only for g1t.page deploy builds), and
guardrails have no per-workflow list. The least that works today: add
`api.cloudflare.com` to **flagon-io/g1t's allowed domains** (repository
**Settings → Guardrails**, Maintain role or higher).

That opens the host to every sandbox of that project, agents included.
Agents never get the token (secrets go only to trusted workflow jobs), but
any code there could talk to Cloudflare's API with credentials of its own.
The better fix is a list of domains only workflow jobs may reach, set by a
maintainer, or hosts a job asks for honored only for trusted jobs; that is
a change to guardrails (`crates/contracts/src/guardrails.rs`, the work
service, the runner's `buildGuardFor`).

### The API token

Create it at **dash.cloudflare.com → My Profile → API Tokens → Create
Token → Custom token**, named `g1t deploys (CI)`:

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Upload, versions, deployments, crons, bindings, `secret list` (doctor) |
| Account | D1: Edit | `d1 migrations list` and `apply` |
| Account | Queues: Edit | Attaching each unit's queue consumers on deploy |
| Account | Workers R2 Storage: Read | Wrangler checks `og`'s bucket binding |
| Account | Account Settings: Read | Wrangler reads the account |
| Account | Containers: Read | The runner's deploy with `--containers-rollout none` reads its application (Edit only if CI ever builds images) |
| Zone (`g1t.sh`, `g1t.page`) | Workers Routes: Edit | `pages`' zone routes, and custom domains |
| Zone (`g1t.sh`, `g1t.page`) | DNS: Edit | Custom domains (`api`, `mcp`, `og`, `models`, `status`, `sudo`, `docs`, `g1t.sh`, `g1t.page`) keep their DNS records |
| Zone (`g1t.sh`, `g1t.page`) | Zone: Read | Finding the zone a route names |

Restrict it to account `syntaqx` (`1e6f2cffa3f445920836e8ebe446bb58`) and
the two zones. Not needed for deploys: KV (bindings are by id; creating a
namespace is a one-time setup), Vectorize, Workers for Platforms beyond
Workers Scripts, Cloudflare for SaaS custom hostnames (the deployments
service does that at runtime with its own token), SSL and Certificates.
Workers KV Storage: Edit and Vectorize: Edit are only for first-time setup,
which stays a person's job.

The list follows what our configs use; Cloudflare does not publish exactly
what `wrangler deploy` checks for each binding. Bindings with no listed
permission (Browser Rendering, Workers AI, Vectorize, Email Sending,
Artifacts, dispatch namespaces) are assumed to need none beyond Workers
Scripts. Verify on the first run with `workflow_dispatch` and `units:
pages` (small, no secrets), then `units: og` (R2) and `units: runner`
(Containers); a missing permission fails with `Authentication error [code:
10000]` and the route it was refused.

Add it to the repository:

1. On g1t.sh, open **flagon-io/g1t → Settings → Secrets and variables**.
2. **Add**: key `CLOUDFLARE_API_TOKEN`, type **Secret**, available to
   **Workflows**, environment **Production**. Only jobs with
   `environment: production` (the deploy jobs) can read it.
3. **Add**: key `CLOUDFLARE_ACCOUNT_ID`, type **Variable**, value
   `1e6f2cffa3f445920836e8ebe446bb58`, available to **Workflows**, all
   environments.

Or through the API:

```sh
curl -X PUT https://api.g1t.sh/repos/flagon-io/g1t/actions/secrets/CLOUDFLARE_API_TOKEN \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"<the token>","environments":["production"],"available_to":["workflows"]}'

curl -X POST https://api.g1t.sh/repos/flagon-io/g1t/actions/variables \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"CLOUDFLARE_ACCOUNT_ID","value":"1e6f2cffa3f445920836e8ebe446bb58","available_to":["workflows"]}'
```

## Turning it on

1. Create the token and add the secret and variable (above).
2. Add `api.cloudflare.com` to flagon-io/g1t's allowed domains.
3. Adopt the live Workers once, from a laptop: deploy everything with the
   tool so each version records its commit (`scripts/deploy.sh`, or
   `node scripts/deploy.mjs deploy --all`). Until then every plan says "no
   known commit" and deploys every unit. To see what has changed since a
   commit you know production runs, without deploying:
   `node scripts/deploy.mjs plan --since <sha>`.
4. Run the workflow by hand with `dry_run`, then with `units: pages`.

## First deploy of a new account

What the configs refer to must exist first. `node scripts/deploy.mjs
manifest --json` lists, per unit, its queues, KV, R2, Vectorize and
dispatch namespaces; each unit's `setup` and `secrets` say the rest.

- D1: `npx wrangler d1 create <database>`, then put its id in the unit's
  `wrangler.jsonc`.
- KV: `npx wrangler kv namespace create <name>` for each name under
  `resources.kv`, then the ids in the configs.
- Queues: `npx wrangler queues create <queue>` for each queue in the
  manifest: `g1t-events`, `g1t-events-<service>` for every subscriber,
  `g1t-search-jobs`, `g1t-context-jobs`.
- R2: `npx wrangler r2 bucket create g1t-screenshots`.
- Vectorize, dispatch namespace, DNS, Access, Email Sending, Artifacts: each
  unit's `setup`.
- Secrets: `npx wrangler secret put <NAME>` in the unit's folder;
  `node scripts/deploy.mjs doctor` lists what is missing.

Then `node scripts/deploy.mjs deploy --all`. A Worker bound to a service
that does not exist yet may be refused; deploy that service first with
`--only`.

## Rolling back

- **One unit, at once:** `npx wrangler rollback` in its folder (or
  `npx wrangler rollback <version-id>`; `npx wrangler versions list` shows
  each version's commit in its message). Code only: D1 migrations are not
  undone. The next plan sees the older commit and deploys what changed since,
  so revert the commit on `main` too, or the next push brings it back.
- **To a commit:** check it out and `node scripts/deploy.mjs deploy --only
  <units> --force`. Migrations never run backwards: a migration that needs
  undoing is a new migration.
- **The runner's image:** a rollback of the Worker does not roll back the
  container image; redeploy the older commit with `--rebuild-image` on a
  machine with Docker.

## Adding a unit

1. Make its folder with a `wrangler.jsonc` (and its D1 migrations, if any).
   A Rust Worker is a workspace member in the root `Cargo.toml` with
   `"build": { "command": "node ../../scripts/build-rust-worker.mjs" }` and
   the `wasm-opt = ["-O1"]` metadata; a TypeScript one is an npm workspace.
2. Add it to `deploy/stack.jsonc`: path, kind, worker, `d1`, stage (the
   earliest stage after everything it binds to), secrets, setup, self_host.
   Name any new KV id under `resources.kv`.
3. If its sources import a file outside its folder that is not a workspace
   crate or package, list it under `inputs`.
4. Add a row to the service table in `docs/SELF_HOSTING.md`.
5. `npm run test:deploy` and `node scripts/deploy.mjs manifest --check`
   say what is missing. Then create its resources and secrets, and
   `node scripts/deploy.mjs deploy --only <unit>`.
