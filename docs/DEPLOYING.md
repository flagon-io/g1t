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
| The runner's images | `services/runner/base/Dockerfile`, `services/runner/Dockerfile`, `services/runner/base.json`, `scripts/build-runner.mjs`, `scripts/deploy/image.mjs` |
| The workflows | `.g1t/workflows/deploy.yml`, `.g1t/workflows/runner-base.yml` |
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
| `image` | A Containers image: `dockerfile` (the image deployed), `crate` (the binary it adds), `base` (`{ context, lock }`: the base image's folder and the file recording the base that was pushed) and `repository` (where both are pushed). See [the runner's images](#the-runners-images). |
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
node scripts/deploy.mjs build-base           # build and push the runner's base image (Docker)
node scripts/deploy.mjs image                # build and push the runner's image for this checkout (Docker)
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
| `--rebuild-image` | Build the runner's image even if one for this source is already in the registry. |
| `--rebuild-base` | Build and push a new base first (needs Docker), then the runner's image on it. Writes `services/runner/base.json`: commit it. |
| `--no-push` | `build-base` and `image`: build locally, push nothing. |
| `--no-cache` | `build-base`: build every layer again. |
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

#### Telling the status page about a deploy

Restarts during a deploy can make a part slow for a minute, which the
status page's checks would otherwise draft as an incident. Before the
first stage and after the last, a deploy can say so with
`scripts/deploy/status-window.mjs` (`announceDeploy("started" | "finished",
{ id })`, or `node scripts/deploy/status-window.mjs started|finished [id]`).
It posts to `POST https://status.g1t.sh/deploys` with
`Authorization: Bearer $STATUS_DEPLOY_TOKEN`, the same value as the status
Worker's `STATUS_DEPLOY_TOKEN` secret. During the deploy and for 3 minutes
after it, detection keeps counting failed and slow checks but makes no new
draft; trouble that outlasts that is drafted with its true start. A
start with no finish stops counting after 30 minutes. Without the token
the helper does nothing, and it never fails a deploy.

On a laptop the tool uses your `wrangler login` (or `CLOUDFLARE_DEPLOY_TOKEN`
if set), as `scripts/deploy.sh` always did: a `CLOUDFLARE_API_TOKEN` or
global API key in your shell, or in the repository's `.env`, is ignored.
With `CI=true` it uses `CLOUDFLARE_API_TOKEN`.

### The runner's images

`services/runner` runs every sandbox (agents, checks, the merge queue,
workflow jobs, g1t.page builds) from one Containers image, made in two
parts:

| Image | Built from | Holds | Rebuilt |
| --- | --- | --- | --- |
| **Base**, `g1t-runner:base-<date>-<inputs>` | `services/runner/base/Dockerfile` | Debian bookworm, Node 24, Python 3.11, Go (from go.dev), Rust stable for the `node` user with rustfmt, clippy and the `wasm32-unknown-unknown` target, build-essential, git, ripgrep, jq, zstd, sudo, and the pinned Claude Code CLI on top | When its folder changes, weekly, or by hand (`build-base`) |
| **Runner**, `g1t-runner:<content hash>` | `services/runner/Dockerfile`: `FROM` the base, plus one file | The g1t runner, a static binary | When the binary or the base changes |

Both are pushed to one repository of Cloudflare's registry,
`registry.cloudflare.com/<account>/g1t-runner`, so pushing the runner's
image uploads only its own layer (about 5 MB): the base's layers are
already there.

Both are built as Wrangler builds images (`--platform linux/amd64
--provenance=false --sbom=false`): one manifest, not an OCI index with a
BuildKit attestation beside it. A push is tried up to three times and counts
only when Docker reports the digest; the first push of the base once failed
with `blob unknown to registry` and went through when run again (see
`docs/CLOUDFLARE_FEEDBACK.md`, C3). `build-base` and `image` exit non-zero
when a push fails, and `base.json` is written only after the push.

**The base** is recorded in `services/runner/base.json`: its reference, its
digest, a hash of its folder (`inputs`), when it was built, its size and
each toolchain's version. `node scripts/deploy.mjs build-base` builds it,
pushes it and rewrites the file; commit the file, and the next deploy
builds the runner's image on it. `npm run test:deploy` fails while the
folder and the file disagree, so a change to the base's Dockerfile cannot
merge without the base it describes. Layers go from what changes least to
most (system packages, Go, Rust, the Claude Code CLI), and the apt and npm
caches stay in BuildKit's cache, out of the image.

The base's build cache is the base itself: it is built with
`BUILDKIT_INLINE_CACHE`, which records in the image how each layer was
made, and `build-base` builds `--cache-from` the base it replaces. A
machine with an empty cache, or one just pruned, pulls the unchanged
layers from the registry instead of building them. (BuildKit's other
registry cache, `--cache-to type=registry`, pushes a separate cache
manifest that not every registry takes, and for a one-stage image adds
nothing the inline cache lacks.)

**The runner binary** (`crates/runner`) is built outside Docker by
`scripts/build-runner.mjs` as one static binary for
`x86_64-unknown-linux-musl`, so it runs on the base whatever its libc, and
on a self-hosted runner's machine too. Where it is built:

- on x86-64 Linux with the musl target and `musl-gcc`
  (`rustup target add x86_64-unknown-linux-musl`, `apt-get install musl-tools`),
  with the machine's own Cargo;
- anywhere else (Windows, macOS) in a small builder container, Rust on
  Alpine (whose own target is musl), with Docker volumes keeping Cargo's
  registry and target directory between builds. Windows has no musl
  cross-linker, and `ring` (under ureq's TLS) needs a C compiler for the
  target, so a container is the dependable route.

**The runner's image tag** is a hash of everything it is built from: its
Dockerfile, `base.json`, the crates the binary is built from, the
workspace's Cargo files and the build script. The same source always names
the same image, so:

1. A deploy computes the tag and asks the registry whether it is there
   (a `HEAD` of its manifest, with credentials from Wrangler; no Docker).
2. If it is, nothing is built: the deploy uses it.
3. If not, and Docker is here, it builds the binary and the image (seconds
   on a warm machine) and pushes it.
4. If not, and Docker is not here (a g1t Actions sandbox), the unit fails
   saying to run `node scripts/deploy.mjs image` on a machine with Docker;
   then re-run the workflow.

Then `wrangler deploy` is given the image by reference, from a generated
config (`services/runner/wrangler.deploy.json`, deleted after, ignored by
git), so Wrangler builds nothing. When nothing the image is built from
changed since the runner's live commit, the deploy also passes
`--containers-rollout none`, which leaves running sandboxes alone.

To get a new base out:

```sh
node scripts/deploy.mjs build-base      # build, push, write base.json (needs Docker)
git commit services/runner/base.json -m "A new base image for g1t's sandboxes"
node scripts/deploy.mjs image           # optional: push the runner's image now, so CI finds it
```

`.g1t/workflows/runner-base.yml` does the same weekly (and when the
base's folder changes on `main`), and opens a pull request with
`base.json`. It needs Docker, so it runs on a self-hosted runner with the
`docker` label (`runs-on: [self-hosted, docker]`). Until one is
registered, its runs wait for one; run `build-base` by hand instead.

**Sandboxes start from the image.** Cloudflare pulls an image to a
machine the first time a sandbox lands there, and keeps it. A smaller base
pulls sooner, and a change to the runner alone sends machines one 5 MB
layer instead of the whole image.

#### Larger machines

The same image runs on three instance types, each a Durable Object class
of its own in `services/runner/wrangler.jsonc`: `AttemptSandbox`
(`standard-1`), `Sandbox2Core` (`standard-3`) and `Sandbox4Core`
(`standard-4`). Workflow jobs choose with `runs-on: g1t-2core` or
`g1t-4core` (`g1t_contracts::actions::INSTANCE_TYPES`); the actions
service passes the label to the runner, which starts the job in that
class. Billing prices the larger ones from their memory and disk, and
their CPU (see the public billing guide). The account's Containers limits
must allow `standard-4`; Wrangler refuses the deploy otherwise.

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
- **The runner's images**, measured on the same machine on 2026-10-06
  (Docker Desktop, 8 vCPUs; its disk was busy with other containers, so
  the cold figures are slow and noisy):

  | | Before (one image) | Now |
  | --- | --- | --- |
  | Size, unpacked / compressed (what a machine pulls) | 3.08 GB / 819 MB | 2.68 GB / 686 MB |
  | A change to the runner | Docker rebuilds the image's Rust stage and pushes the image (1198 s in the first deploy after a prune) | binary 46–53 s (6 s unchanged), image 7 s, push one 5 MB layer (1.4 s to a local registry) |
  | The base from nothing | 431 s (whole image, cold) | 758 s cold, rarely: weekly or when its folder changes |
  | The base after `docker builder prune` | as from nothing | 68 s, its layers pulled from the registry it was pushed to |
  | The runner binary, cold (builder container) | | 99 s |
  | A Rust CI job's build (events, search, repos; 4 vCPUs) | | 51 s cold, 13 s with the Cargo target restored (107 MB zstd entry) |

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
  Rust workers at most four to a job (each a 4-vCPU `g1t-4core` machine), the
  TypeScript Workers together, each site alone, and a unit whose image must
  be rebuilt alone. `fail-fast: false`, so one failed job does not cut
  another off mid-upload; the next stage then does not start.
- **Tests:** there is no CI workflow on g1t yet; `main` is kept passing by
  the merge queue's checks. `check` runs the deploy tool's own tests. When a
  CI workflow is added, make `plan` wait for it (`workflow_run`, or a job in
  this file).
- **Machines:** Rust jobs run on `g1t-4core` (4 vCPUs, 12 GiB), the
  others on the standard machine (`runs-on: ${{ matrix.rust && 'g1t-4core' || 'ubuntu-latest' }}`).
- **Caching** (`actions/cache`: up to 2 GB an entry, 10 GB a repository,
  kept until unused for 7 days): the worker-build binary, worker-build's
  downloaded tools, `~/.cargo/registry/cache`, and the Cargo target's
  release dependencies (`target/release` and
  `target/wasm32-unknown-unknown/release`, without `incremental` or
  `.wasm`), keyed by the build group, `Cargo.lock` and `base.json`. The
  workspace's own crates are compiled again on every run (a checkout's
  sources are newer than any cache); the crates.io dependencies are not.
  npm's cache is not kept: every job runs `npm ci` of only what its units
  need (`deploy.mjs install`: Wrangler alone for Rust jobs).
- **Conditions:** each stage runs with `!failure() && !cancelled()`, which
  on g1t (as on GitHub) is true when no job before it failed, however far
  back: a `migrate` job skipped for having nothing to apply does not stop
  the stages after it, and a failed `check` stops all of them.
- `crates/actions/tests/repository_workflows.rs` reads the workflow with
  g1t's own parser and expressions, and checks the jobs start, wait and
  stop as above (`cargo test -p g1t-actions --test repository_workflows`).

### What the sandbox has

The base image (`services/runner/base/Dockerfile`) has Node 24, npm, git,
Go, zstd, and Rust stable for the `node` user with rustfmt, clippy and the
`wasm32-unknown-unknown` target, but not worker-build or Docker. The
workflow's `rustup target add wasm32-unknown-unknown` is then a no-op, and
worker-build is restored from the cache, installed on a miss. worker-build
fetches wasm-bindgen and wasm-opt from GitHub releases and esbuild from
npm. All of those hosts are on the list every workflow job may reach.

### Network

A workflow job reaches its project's allowed domains, g1t, what builds
need (`services/runner/src/egress.ts`, `BUILD_HOSTS`), and the project's
**workflow-only domains** that name its workflow and environment. Those are
never reached by agents, checks, the merge queue, deploy builds or runs of
pull requests from forks (`Guardrails::workflow_hosts`, the runner's
`jobHosts`). Under flagon-io/g1t's **Settings → Guardrails**
(Maintain role or higher), **Workflow-only domains**:

```text
api.cloudflare.com | deploy.yml | production
registry.cloudflare.com | deploy.yml, runner-base.yml | production
```

`api.cloudflare.com` is Wrangler's API; `registry.cloudflare.com` is where
the deploy asks whether the runner's image is already built (and where
`runner-base.yml` pushes). Only `deploy.yml`'s and `runner-base.yml`'s
jobs with `environment: production` reach them, which are also the only
jobs that can read `CLOUDFLARE_API_TOKEN`. Each change to the list is in
the workspace's audit log as `update_guardrails`.

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
| Account | Containers: Edit | The runner's deploy updates its applications (the image reference, the three classes), and gets registry credentials to look for its image. `runner-base.yml` pushes images with it. |
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
2. Add `api.cloudflare.com` and `registry.cloudflare.com` to flagon-io/g1t's
   workflow-only domains, for `deploy.yml` in `production` (above).
3. Build and push the base once, and commit `services/runner/base.json`:
   `node scripts/deploy.mjs build-base`. Create the cache bucket:
   `npx wrangler r2 bucket create g1t-actions-cache`, with a lifecycle rule
   deleting objects 30 days after upload
   (`npx wrangler r2 bucket lifecycle add g1t-actions-cache expire --expire-days 30 --abort-multipart-days 1`).
4. Adopt the live Workers once, from a laptop: deploy everything with the
   tool so each version records its commit (`scripts/deploy.sh`, or
   `node scripts/deploy.mjs deploy --all`). Until then every plan says "no
   known commit" and deploys every unit. To see what has changed since a
   commit you know production runs, without deploying:
   `node scripts/deploy.mjs plan --since <sha>`.
5. Run the workflow by hand with `dry_run`, then with `units: pages`.

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
- R2: `npx wrangler r2 bucket create g1t-screenshots` and
  `npx wrangler r2 bucket create g1t-actions-cache` (with its 30-day
  lifecycle rule, above).
- The runner's base image: `node scripts/deploy.mjs build-base`.
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
  container image. Redeploy the older commit (`--only runner --force`): its
  image's tag is the hash of that commit's source, which is still in the
  registry, so nothing is built. A bad base is undone by reverting the
  commit that changed `services/runner/base.json`.

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

## The self-hosted runner

`g1t-runner` (crates/runner) is also what customers run on their own
machines (guide: `apps/docs/src/content/docs/guides/self-hosted-runners.md`).
It is not deployed with the stack: it is released, and runners already out
there update themselves to each release.

| Piece | Where |
| --- | --- |
| The tool | `scripts/runner-release.mjs` (`keygen`, `build`, `sign`, `verify`, `publish`) |
| The workflow | `.g1t/workflows/runner-release.yml`, on a tag `runner-v<version>` or by hand |
| Where it is published | The R2 bucket `g1t-downloads`, served by the site at `g1t.sh/downloads/runner/<version>/<file>` and `/latest/<file>` (`apps/web/app/routes/downloads-runner.ts`) |
| Its image | `deploy/runner/Dockerfile`, pushed as `RUNNER_IMAGE` (`flagonio/g1t-runner`) for amd64 and arm64 |

A release is five binaries (Linux x64 and arm64, both static musl; macOS
x64 and arm64; Windows x64), `SHA256SUMS`, and `manifest.json`;
`latest.json` and its Ed25519 signature `latest.json.sig` name the newest.
A runner updates only to a release whose signature checks out against the
public key built into it and whose download matches the manifest's SHA-256.

The first time:

1. `node scripts/runner-release.mjs keygen`. Put `RUNNER_RELEASE_KEY` in the
   repository's secrets (production environment) and keep a copy offline;
   put `G1T_RUNNER_RELEASE_KEY` in its variables. A build made without the
   public key never updates itself.
2. `npx wrangler r2 bucket create g1t-downloads`, and deploy the site so it
   has the `DOWNLOADS` binding.
3. Set the variables `RUNNER_IMAGE` (the image's name in a public registry),
   `RUNNER_IMAGE_REGISTRY_USER` and the secret `RUNNER_IMAGE_REGISTRY_TOKEN`,
   and `RUNNER_AGENT_IMAGE` (a public copy of `g1t-runner-base`, the image
   agent work runs in on customers' runners).
4. Register a self-hosted runner with the `docker` label for the image job.

Each release:

1. Bump `version` in `crates/runner/Cargo.toml` and merge it.
2. Tag the commit `runner-v<version>` and push the tag. The workflow builds
   every platform with cargo-zigbuild, signs, verifies, publishes the files
   (the version's first, `latest.json` last), and pushes the image.
3. By hand, the same is `node scripts/runner-release.mjs build`, then `sign`,
   `verify` and `publish`, with the keys in the environment.

Rolling back a release: copy the older version's `manifest.json` over
`runner/latest.json` and sign it again (`sign` after checking the older
version out). Runners never move to an older version on their own; a
runner on a bad release is fixed by the next good one, or by downloading
the older binary over it.
