# Contributing to g1t

g1t is built the way it asks others to build: work items and pull requests on
[g1t.sh/flagon-io/g1t](https://g1t.sh/flagon-io/g1t), required checks that prove
a change works, and a merge queue that keeps `main` passing.

## A change ships with its docs

Documentation is part of the product, held to the same bar as the code.
A pull request that changes what someone can do, see or call changes the
docs in the same pull request:

| If you change                                                                                 | Update                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Something a person does on g1t.sh                                                             | The guide for it in `apps/docs/src/content/docs/guides/`                                                                                                                                                                                                                                                                                                               |
| An API route, a field, or an MCP tool                                                         | `apps/api/src/operations.rs` descriptions (they feed the OpenAPI document and the API reference), the example and notes for it in `apps/api/src/reference.json`, `reference/mcp.md`, and any guide that shows the call. Then refresh the docs' copy of the OpenAPI document with `G1T_WRITE_OPENAPI=1 cargo test -p g1t-api openapi`; `cargo test` fails until you do. |
| What coding agents are told about g1t                                                         | `guides/bring-your-own-agent.mdx`, `guides/claude-code-plugin.md`, the plugin's skills in `plugins/claude-code/`, and `apps/web/public/llms.txt`                                                                                                                                                                                                                       |
| The Claude Code plugin's files (`plugins/claude-code/`, except `test/`)                       | Its version, the same in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`: Claude Code updates an installed plugin only when it changes. On main, `plugins-release.yml` publishes it to `flagon-io/g1t-plugins`, and refuses a changed plugin with a version already published. Never commit to g1t-plugins itself.                                  |
| Settings, limits or prices                                                                    | The page that names them, and the table it is in                                                                                                                                                                                                                                                                                                                       |
| A new feature                                                                                 | A section in the guide that owns it, linked from the docs home if it is a new task                                                                                                                                                                                                                                                                                     |
| How g1t is put together: a service, a binding, a store, an event route, the path of a request | Its page in the docs' Architecture section (`apps/docs/src/content/docs/architecture/`), and its diagram in `apps/docs/src/diagrams/architecture.ts`. [How g1t ships](https://docs.g1t.sh/architecture/shipping/#keeping-this-section-true) says which page covers what.                                                                                               |

The style, in short: plain sentences, second person, no marketing words,
sentence-case headings, a numbered list for steps, a table for options, and
every API mention with its exact route or tool name. Examples are copyable
and real. Nothing is documented that the code does not do.

Check the docs build before you push:

```sh
cd apps/docs && npm run build
```

## Icons

- **Interface icons come from [Lucide](https://lucide.dev/icons).** In the
  apps, import them from `lucide-react`. In the docs, use `@lucide/astro`:
  import an icon component, or give `apps/docs/src/components/Card.astro`
  and `Aside.astro` a Lucide name such as `icon="git-branch"`. Starlight's
  own `<Card>`, `<LinkCard>` and `<Aside>` draw Starlight's icon set, so the
  docs import the wrappers in `apps/docs/src/components/` instead.
- **Brand marks come from [Simple Icons](https://simpleicons.org)**
  (`simple-icons`), and follow each brand's own usage guidelines. Add the
  dependency with the first one you show.
- **The g1t logo and illustrations are our own artwork**, in
  `apps/web/app/components/logo.tsx` and `art.tsx`.
- Never hand-copy an icon's SVG paths into a file. If Lucide lacks the
  icon you need, pick the closest one that it has.

## Interface components

- **Build the site from the components in `apps/web/app/components/ui`**,
  which are [shadcn/ui](https://ui.shadcn.com) components themed with
  g1t's tokens: buttons, cards, badges, tables, tabs, separators,
  breadcrumbs, menus, dialogs, sheets, tooltips, form controls.
- **If shadcn has a component you need and `ui` doesn't, add it there**
  first, themed with the tokens, then use it. Don't rebuild it inline.
- **Change how something looks through the component's variants**, not
  with a one-off class string at the call site. A long `className` on a
  `div` that draws a card, a pill or a button is a component that should
  exist.
- Hover hints use the `Tooltip` component, never `title=`. Native
  `<select>`, file inputs, checkboxes and radios use their `ui`
  components.
- **Every avatar is `Avatar`** (`ui/avatar.tsx`), and @g1t's is `Avatar`
  with `agent` set, or `AgentAvatar` (`components/agent-avatar.tsx`), which
  wraps it: g1t's pixel 1 with the agent marker in its corner, named
  "…, agent" to a screen reader. Never hand-draw a sparkle, a letter on a
  tile or the marker at a call site: a place that shows @g1t differently is
  a bug.
- Look at every page you change, in light and dark, on a desktop and a
  phone, before calling it done.

## Before you push

- `cargo test` in the crate or service you changed.
- `npx tsc -b --force` in `apps/web` (the incremental build misses changes
  in `packages/contracts`).
- `npm run format -- <files>` on the TypeScript files you added
  (`.prettierrc.json`). Older files are not formatted yet, so format a file
  you only edited in a change of its own, not in the middle of a feature.
- Look at what you changed in a browser. Screenshots catch what type
  checks do not.

## Previewing a change to the site

A pull request that changes the site (`apps/web`, a package it uses, or the
npm lockfile) gets a preview: the site as the pull request makes it, at an
address of its own, before anything merges. The Preview workflow
(`.g1t/workflows/preview.yml`, running `scripts/deploy/preview.mjs`) builds
it as a deploy would, and uploads it to Cloudflare as a version of the
`g1t` Worker under the alias `pr-<number>`. Nothing is deployed, no
migration runs, and g1t.sh's traffic never reaches it.

1. Push a branch to `flagon-io/g1t` and open a pull request from it.
2. When the Preview run finishes, the pull request's checks have
   `preview / web`; its link is the preview,
   `https://pr-<number>-g1t.<subdomain>.workers.dev`. The run's summary
   has the same link, and the address of that commit's version alone.
3. Each push replaces what the address shows. It keeps showing the last
   version after the pull request closes.

What to know:

- **It is production's data.** The preview has the `g1t` Worker's
  bindings, variables and secrets, so it reads and writes g1t.sh's real
  data through the same services. What you do there is done.
- **Sign in on the preview itself**, with your username and password (and
  your second factor). g1t.sh's session cookie is g1t.sh's alone and never
  reaches a preview, and the preview's never reaches g1t.sh. Signing in
  with GitHub or SSO works only on g1t.sh (their callback addresses are
  g1t.sh's), and sign-up needs the Turnstile widget, which knows only
  g1t.sh. Links the site makes (git remotes, invites, emails) still name
  g1t.sh.
- **Only a branch of this repository is previewed.** A pull request from a
  fork, or from a g1t working copy, is not: its code would run with the
  Cloudflare token. Its author can push the branch here to get one.
- **Anyone with the address can open it**, unless Cloudflare Access guards
  the Worker's preview URLs (below).

Setting it up, once:

1. The `production` environment's `CLOUDFLARE_API_TOKEN`, the secret Deploy uses (read with `deployment: false`): anyone
   who can push a branch here can already read the repository's secrets
   from a workflow on their pull request, so a token of its own would
   protect nothing. Fork pull requests get no secrets and no preview.
2. The variable `CLOUDFLARE_ACCOUNT_ID`, which Deploy already uses.
3. `"preview_urls": true` in `apps/web/wrangler.jsonc` deployed (the next
   deploy of the site turns them on), and a workers.dev subdomain on the
   account (Workers & Pages › your subdomain).
4. Recommended: **Workers & Pages › g1t › Settings › Domains & Routes ›
   Preview URLs › Enable Cloudflare Access**, so only the team can open
   previews.

## Checking g1t against GitHub

g1t runs GitHub Actions workflows as GitHub does. The Conformance
workflow is how that is checked: `.g1t/workflows/conformance.yml` and
`.github/workflows/conformance.yml` are the same file (a test in
`crates/actions` fails when they differ), and each run's
`conformance-report` artifact records what its jobs saw: which `GITHUB_*`
and `RUNNER_*` variables were set and of what kind, every key of the
contexts and the event and its type, how the workspace is laid out, and
the values of outputs, files, caches, artifacts and expressions that
should be the same everywhere. It reads no secrets and runs only by hand.

1. Run it on both, at the same commit: **Actions → Conformance → Run
   workflow** on GitHub and on g1t.sh.
2. Download each run's `conformance-report` artifact, and name the two
   files `github.json` and `g1t.json`.
3. Compare them:

   ```sh
   node scripts/conformance-diff.mjs github.json g1t.json
   ```

It lists what GitHub has that g1t lacks or has otherwise, then what only
g1t has, and exits 1 while there are differences. A difference is a bug in
g1t, or belongs in [What g1t can't do yet](https://docs.g1t.sh/about/limitations/).
Add a step and a `CHECK_` value to the workflow for anything new g1t
should match.

## Deploying

Pushes to `main` deploy themselves: `.g1t/workflows/deploy.yml` runs
`scripts/deploy.mjs`, which deploys only the parts that changed since the
commit each one runs, migrations first: a change to docs, tests or another
workflow deploys nothing, and one to the deploy tool or `deploy.yml`
deploys everything
([what each part deploys for](https://docs.g1t.sh/guides/deploy-to-cloudflare/#the-tool)).
Every deployable part is listed in `deploy/stack.jsonc`; a new service
or app goes there, in the table on
[How a self-hosted g1t runs](https://docs.g1t.sh/guides/self-hosting-architecture/#each-part),
and in the one on [Services and contracts](https://docs.g1t.sh/architecture/services/#every-unit)
(`npm run test:deploy` says what is missing).
[Deploy g1t to Cloudflare](https://docs.g1t.sh/guides/deploy-to-cloudflare/)
covers the tool, the workflow, rollbacks, adding a unit and first-time
setup.

**Self-hosting keeps working.** Anyone can run g1t from `main` on their
own machine (`deploy/self-host/`), so a change must not need g1t.sh's own
Cloudflare resources: a new binding is optional in code, or the self-host
stack provides it. `.g1t/workflows/self-host.yml` builds the stack from
the commit and runs `deploy/self-host/smoke.sh` against it, on every change
to what it builds and nightly on `main`; a failure names the step, and the
stack's logs are the run's artifact. CI builds the Rust services first, in
parallel jobs with the deploy's caches (`scripts/deploy/self-host-builds.mjs`),
and the image takes them as built (`docker-compose.prebuilt.yml`); on your
own machine the image compiles them. Run it yourself with:

```sh
docker compose -p g1t-selfhost -f deploy/self-host/docker-compose.yml up --build -d
SCHEDULER_ONCE="docker compose -p g1t-selfhost -f deploy/self-host/docker-compose.yml exec -T g1t \
  node deploy/self-host/scheduler.mjs --once /data/generated/schedules.json" bash deploy/self-host/smoke.sh
docker compose -p g1t-selfhost -f deploy/self-host/docker-compose.yml down -v
```

- **An urgent deploy** replaces the runner's sandboxes and git edges now,
  stopping running jobs, instead of letting them finish for up to two hours:
  Deploy run by hand with **urgent**. For incidents only; the checklist is
  `docs/operations/urgent-deploys.md`.
- **Migrations run before the code**, so the old code reads the new schema
  for a minute or more. Add tables and columns; change what rows mean in
  two deploys (code that reads both forms first); never drop what live code
  still reads.
- **The self-hosted runner** is released, not deployed: bump `version` in
  `crates/runner/Cargo.toml`, merge, and push a `runner-v<version>` tag.
  `.g1t/workflows/runner-release.yml` builds, signs and publishes it, and
  runners update themselves to it. `scripts/runner-release.mjs` does the
  same by hand.
- **The g1t CLI** is released the same way: bump `version` in
  `crates/g1t/Cargo.toml`, merge, and push a `cli-v<version>` tag.
  `.g1t/workflows/cli-release.yml` builds it for every platform, signs
  the release with the runner's release key and publishes it to
  g1t.sh/downloads/cli/, where g1t.sh/install and g1t.sh/install.ps1
  find it. `scripts/cli-release.mjs` does the same by hand. The command
  reference in the docs is generated from the CLI
  (`G1T_WRITE_DOCS=1 cargo test -p g1t cli_reference`), and its table of
  API operations from the OpenAPI document
  (`G1T_WRITE_OPS=1 cargo test -p g1t ops_table`); tests fail when either
  falls behind. The guide is [The g1t CLI](https://docs.g1t.sh/guides/cli/).
- **The desktop app** is released the same way: bump `version` in
  `apps/desktop/src-tauri/Cargo.toml`, merge, and push a
  `desktop-v<version>` tag. `.g1t/workflows/desktop-release.yml` builds
  the installers (Linux on g1t's machines; Windows and macOS on machines
  registered for them, or Windows cross-built on Linux, each switched on
  by a repository variable the
  workflow's header names; a platform with no machine is left out of that
  release), signs the updater's files and publishes them, and installed
  apps update themselves. `scripts/desktop-release.mjs` does the
  same by hand. The app loads the live site, so a change to the site needs
  no release; only a change under `apps/desktop` does. The guide is
  [The desktop app](https://docs.g1t.sh/guides/desktop/).
- **The phone app** for Android is released on g1t.sh/download while it
  is not in Google Play (that waits on Flagon's D-U-N-S number): bump
  `version` in `apps/mobile/app.config.ts` when its native side changes,
  merge, and push a `mobile-v<version>` tag.
  `.g1t/workflows/mobile-release.yml` has EAS build the APK and publishes
  it; `scripts/mobile-release.mjs` does the same by hand. A change to the
  app's code alone needs no release: `eas update --channel preview` in
  `apps/mobile` reaches installed copies. Its server half (chat scopes,
  `/-/notify`, notify's phone push) deploys with the site and services.
  The guide is [The phone app](https://docs.g1t.sh/guides/mobile/).

## How g1t's own CI caches

g1t's workflows cache with `actions/cache` against g1t's own cache
([the Actions guide](https://docs.g1t.sh/guides/actions/#the-cache) has its
rules). Three of them shape everything here: a run restores from its own
ref, its pull request's base, then `main`, so a release tag never reads
another tag's entries; a key is written once; and a repository holds
100 GiB (10 GiB in a workspace on the Free plan), past which the entries
restored longest ago go. So:

- **`main` saves; pull requests, queue states and tags restore.** CI's
  Rust and TypeScript jobs keep their caches on each push to `main`, and
  the Caches workflow (`.g1t/workflows/caches.yml`) builds and saves what
  only releases use, when its key is missing. Release workflows only
  restore.
- **A push the merge queue landed only warms the caches.** It is the very
  commit CI's `merge_group` run passed on, so it is not tested again: the
  Rust parts compile their tests (`cargo test --no-run`) and save the test
  build, TypeScript type checks and saves tsc's build info, and the
  desktop job passes without building. `scripts/deploy/ci-affected.mjs`
  tells it from a push made directly, which asks the API for a passing
  `merge_group` run of `ci.yml` on that commit; a direct push, or one the
  API cannot answer for, runs everything, desktop included.
- **Rust caches are keyed by the toolchain and the dependencies**, from
  `node scripts/deploy/ci-cache.mjs keys`: `rustc -V`, and a hash of the
  packages `Cargo.lock` takes from crates.io and git. A release bumping a
  workspace crate's version changes neither. A restore key never crosses
  toolchains.
- **A Cargo target restored from an older entry is pruned before it is
  saved** (`ci-cache.mjs prune`), to what this build used.
- **A partial install never saves a whole-install key.** npm's downloads
  and the crates are saved only by jobs that fetch all of them.
- **A partial test build is never saved.** On a pull request or a merge
  queue state, CI's Rust parts test only the crates it changes and those
  that depend on them (`scripts/deploy/ci-affected.mjs`); a part that
  tested some of its crates saves no entry, and one with none to test does
  nothing. A queue state saves no test build at all: its branch is gone
  once it lands. On `main` every part builds, and saves, all of its
  crates.
- **One set of paths per entry.** An entry's version is the hash of its
  paths, so every step that names it, in every workflow, names the same
  ones. `crates/actions/tests/repository_workflows.rs` holds all of this.
- **sccache only reads on a tag** (`scripts/sccache.sh` sets
  `SCCACHE_GHA_RW_MODE=READ_ONLY` when `GITHUB_REF_TYPE` is `tag`): a
  release's run finds what `main`'s runs compiled, and saves nothing only
  its own tag could read.
- **Only tsc's build info is kept between type checks, never generated
  types.** tsc (`"incremental"` in `tsconfig.base.json`) hashes every file
  a check reads against its `.tsbuildinfo` and checks again what changed
  and what imports it, so an entry from any commit gives the errors a check
  from nothing would. `worker-configuration.d.ts` and `.react-router` are
  written again by each workspace's `typecheck` script, every run. The site
  and sudo check with `tsc -p` on each config, not `tsc -b`, which skips a
  project when none of its own files is newer than its build info.
- **Images a build runs in are pinned by digest.** The CLI's release
  builds in `cargo-zigbuild` (`BUILDER` in `scripts/cli-release.mjs`), and
  its cache is keyed by that digest (`zigbuild` from `ci-cache.mjs keys`)
  rather than by this machine's `rustc`.
- **A replaced entry goes within the hour.** Each new lockfile saves a new
  entry of every kind; the Cache tidy workflow (`.g1t/workflows/cache-tidy.yml`,
  `ci-cache.mjs tidy`) deletes, hourly, the entries a newer one of the same
  key less its last part has replaced, once nothing has used them for an
  hour. Before it, two or three generations of every build filled the
  10 GiB the quota was then, and it took Deploy's entries first.

| Entry                      | Key                                                                                     | Saved by                                      | Restored by                 |
| -------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------- |
| npm's downloads            | `npm-full-<os>-<package-lock.json>`                                                     | Caches (`npm`)                                | every npm install           |
| Crates and their index     | `cargo-crates-<os>-<deps>`                                                              | CI Rust (`cargo fetch` of the whole lockfile) | Deploy, the runner release  |
| The test builds            | `cargo-test-<os>-<rust>-<part>-<deps>`, one for each of CI Rust's three parts           | CI Rust, when it builds a whole part          | CI Rust on pull requests    |
| tsc's build info           | `tsc-<os>-<package-lock.json>-<commit>` (every `*.tsbuildinfo`)                         | CI TypeScript on `main`                       | CI TypeScript               |
| Workers' builds            | `cargo-workers-<os>-<rust>-<group>-<deps>`                                              | Deploy                                        | Deploy                      |
| The runner's image build   | `runner-musl-<os>-<rust>-<deps>`                                                        | Deploy                                        | Deploy                      |
| worker-build and its tools | `worker-build-…`, `worker-build-tools-…`                                                | Deploy                                        | Deploy                      |
| Compiled crates            | sccache's, one per crate                                                                | every Rust job                                | every Rust job              |
| The desktop app's check    | `desktop-check-nodebug-<os>-<rust>-<desktop deps>`                                      | CI desktop, on a push not from the queue      | CI desktop on pull requests |
| apt for Tauri              | `apt-tauri-<os>-<scripts/apt-install.sh>`, only where the image lacks Tauri's packages  | CI desktop, on a push not from the queue      | the desktop release         |
| The runner release         | `runner-release-<os>-<target>-<rust>-<deps>`, zig                                       | Caches (`runner`)                             | the runner release          |
| The desktop release        | `desktop-release-linux-…`, `desktop-release-windows-…`, `xwin-…`, `apt-tauri-windows-…` | Caches (`desktop-linux`, `desktop-windows`)   | the desktop release         |
| The CLI release            | `cli-release-<os>-<zigbuild>-<deps>` (`target/zig`, every platform)                     | Caches (`cli`), built whole                   | the CLI release             |

To see whether a change helped, read a run's cache steps: `Cache restored
from key` names the entry (the key itself is a hit; another is a start),
`Cache Size` and the step's time say what it cost, and the post step says
whether it saved. `sccache's hits and misses` is on each Rust job's summary.
`g1t cache usage` says what the repository's entries hold against its
quota, and `g1t cache list --sort size-in-bytes` which take the most.

## Adding a machine size

g1t's hosted machines are one catalogue: `INSTANCE_TYPES` in
`crates/contracts/src/actions.rs`, mirrored row for row in
`packages/contracts/src/instances.ts`. Each row is the machine's name in
a job's start and billing record (`label`: `standard`, `ubuntu-slim`,
`g1t-4core`), the machine it bills as (`machine`, such as `2-core`), the runner's Durable
Object class that runs it (`class` / `sandboxClass`), the Cloudflare
Containers instance type behind that class (`container`), its vCPUs,
memory and disk, and its price a minute (`micros_per_minute`). The runner
starts a job in its label's class, billing charges its minutes at its
rate and reports them by machine, and the docs' tables follow it.

`runs-on` labels are GitHub's hosted-runner labels: `GITHUB_HOSTED_LABELS`
(in the same file, also mirrored) lists each with GitHub's size in a
public repository and in a private one, and the g1t machine (by its
catalogue `label`) that answers it in each, or none for Windows and
macOS, which the planner refuses unless the job asks for `self-hosted`.
`instance_for` takes the column for the run's repository. A label not in
it gets the standard machine. g1t adds no labels of its own; larger
machines would come as GitHub-style larger runners, not a label.

- **A new GitHub label, or a new size of one**: a row in
  `GITHUB_HOSTED_LABELS` (both files) with GitHub's sizes and the machine
  for each visibility; a machine of the catalogue, or a new one below.
- **A new label for an existing machine** (another name for the standard
  one, say): a row with the new label and class and the machine's
  `machine`, size and rate; the class and its binding below.
- **A new size**: a row with a new `machine` key and its rate. The rate is
  what a minute costs at Cloudflare's list prices with half the vCPUs
  busy, plus 20%, rounded up to a tenth of a cent, and never under its
  cost with every vCPU busy; `rates_cover_the_machine_at_full_cpu_and_its_usual_cost_plus_the_margin`
  checks it.
- **Pointing a label at another instance type**: change its `container`
  and size (and `machine`, if it is a different machine now), and the
  class's `instance_type` in `services/runner/wrangler.jsonc`. A custom
  instance type works the same way, once the account may use them: add its
  size to the runner test's table of instance types.
- **Renaming a label**: change `label`; keep `machine`, so its minutes stay
  on the same line of everyone's usage.
- **Retiring a machine**: move its row to `RETIRED_MACHINES` (in both
  files), so its past minutes still read and price under its `machine`;
  remove its class from `wrangler.jsonc` (`containers` and binding), add a
  migration tag with `deleted_classes`, and drop its export and its
  `SANDBOX_BINDINGS` entry. Deleting a class deletes its objects' storage,
  which is safe for sandboxes (each holds one job's state), but deploy it
  when none of its jobs is running. The container application Cloudflare
  made for the class (`g1t-runner-<class, lowercased>`) is left behind;
  delete it with `wrangler containers delete` after the deploy.

Never reuse a `machine` key for a different machine: past usage is
reported under it. For a new class, add it to `services/runner/wrangler.jsonc`
(`containers`, a `durable_objects` binding and a migration tag with
`new_sqlite_classes`; a class a migration deleted keeps its name retired,
so a machine that comes back gets a new class, as the 4-core one did as
`SandboxLarge`), export it from `services/runner/src/index.ts`
(`export class SandboxSlim extends AttemptSandbox {}`, with its own
`outboundHandlers`), and give it a
binding in `SANDBOX_BINDINGS` (`services/runner/src/egress.ts`). The tests
that hold all of this together are `cargo test -p g1t-contracts instance`
(the table, its rates and its TypeScript mirror) and the runner's
`npm test` (every class in wrangler.jsonc, its instance type, size and
binding against the catalogue). Then update the machine tables in
`guides/actions.md`, `guides/usage-and-billing.md` and
`architecture/compute.mdx`.

## Speed

Pages are a few rounds of service calls, and each round costs a trip to
the databases, so start calls together and add no rounds.

- Every page answers with `Server-Timing`: each loader, each service's
  calls and their database time. Look at it in DevTools when a page feels
  slow. status.g1t.sh's Page speed holds its `total` to 800 ms, so keep
  that entry's name (`apps/status/src/probe.ts` `serverTotal`).
- `scripts/perf/measure.ps1` times pages from your machine (`-BrowserUA`
  for signed-out pages as a browser sees them). A page that only reads
  must not set the `g1t_d1` cookie: a new read-only service method goes in
  `READS` in `apps/web/app/lib/perf.ts`.
- Targets from the US: signed-out pages under 200 ms to first byte,
  signed-in pages under 400 ms, streamed panels within a second.
- Workers run without Smart Placement; `scripts/perf/placement-probe.mjs`
  measures a placement before you pin one, warm (`measure`) and cold
  (`cold`, with `--wasm` loading a real service's module).
- A page is slowest in a data centre g1t has not run in lately: when
  Page speed's first try is slow, the status worker logs both tries'
  `Server-Timing` (`status.slow_first`), which says what the cold cost was.
  `worker` is everything the site's Worker did and `isolate` whether it
  was that isolate's first request: a first try's time beyond `worker` went
  before the Worker ran. A signed-out page one data centre drew is kept for
  the others too (`cache;desc=hit-shared`, the `PAGES` KV namespace), and
  so is a repository's ref listing, for ten minutes (`refs;desc=hit-shared`).
- A TypeScript service reports its database time too (`db;dur`, from
  `openD1` in `@g1t/contracts`): the round trips a method makes are what
  it costs, so start them together (`Promise.all`), keep what never
  changes across requests in the isolate (the artifacts service keeps a
  workspace's slug for 30 s and whether its General space exists), and
  don't wake a Durable Object for a read D1 can answer.
- Nothing live gates a page. A page carries what it shows (a doc's text
  and its saved document), opens its sockets as it hydrates rather than
  from inside the code they feed, keeps what is typed until they answer,
  and says so with a dot, never a spinner. A page opened with an access
  token gets its socket tickets with the page (the root loader mints the
  feed's, an artifact's loader its room's) rather than asking for each.
- Code that only the browser runs (the doc editor) is still fetched with
  the page: `vite.config.ts` notes the chunk and what it imports for the
  route's `links`, and a link to such a page warms the chunk on hover.
  Modules several routes share are grouped by who shares them
  (`codeSplitting.groups`), so a page fetches tens of files, not a
  hundred and more. Before this, opening a doc fetched 124 files
  (1,049 KB) in three waves and the editor appeared at 2.8–3.3 s; a doc
  now fetches 71 files (1,026 KB) in one wave, and against the deployed
  services the editor appears at 2.1 s, of which the room's answer is
  0.65 s and the editor's own start 0.4 s. With the saved document in the
  page, measured on g1t.sh signed in (2026-10-10, warm, 1440×900), the
  editor appears at 1.5 s: first byte 0.53 s, scripts by 0.75 s, the
  editor's own start the rest. A doc without a saved document (one last
  saved before documents were kept) waited for its room's first message
  instead, 0.9 s after the socket opened, and appeared at 2.0–2.5 s; the
  page now asks the room once and keeps the answer, so only its first
  open pays. Still to cut: the live socket's four service calls before
  the room answers, the page and sidebar's 27 database round trips in two
  calls, billing's own rounds behind `entitlements` (about 8 in a row,
  0.7–0.9 s, now paid once per workspace every two minutes), and the
  3.4 MB of script a doc page decodes.
- The frame is read once, not with every page. The root and the
  workspace layout reload after a submission only when it changes what
  the frame shows (`lib/shell-changes.ts`: add a page there when its
  form changes the sidebar); a comment or a review reloads only its page.
  What every page asks and rarely changes is kept in the data centre
  (`shortCache`): who a session is for 30 s (by a hash of its token;
  signing out forgets it), a workspace's entitlements for two minutes,
  whether a project files work items for five. A request that writes,
  and the person's pages for 30 s after, read afresh, and an isolate
  keeps nothing longer than 30 s itself.

## Rate limits

`RATE_LIMITS` in `packages/contracts/src/rate-limits.ts` is the table of
record, and the [rate limits page](https://docs.g1t.sh/reference/rate-limits/)
is the public one: change both, and the binding in the Worker's
`wrangler.jsonc`, together (`front-door-limits.test.ts` fails when they
disagree). Limits fail open, keys hash anything secret, and each Worker
takes its namespace ids from its own block of a hundred (41xx packages,
42xx web, 43xx repos, 44xx api, 45xx og, 46xx status).

Crawlers made most of g1t.sh's requests on 2026-10-20 (ClaudeBot 147k
and GPTBot 34k of 286k in six hours), and every shared service slowed
for people signed in. So a crawler is never signed in and is served from
the cache: `app/lib/crawlers.ts` knows them by user agent (add a new one
to `FAMILIES`, with a case in its test) or by Cloudflare's verified bot
fields, and `serveCrawler` in `workers/app.ts` keeps its public pages for
6 hours under the address alone. Only a page not in the cache is drawn,
and the costly ones (tree, file, commit, raw, blame, compare, search)
count against `CRAWLER_LIMIT`, per crawler. `/robots.txt` asks for 5
seconds between requests and keeps crawlers from raw files, archives,
blame and comparisons (`app/lib/robots.ts`). A scraper that looks like a
browser is a signed-out visitor: the signed-out page cache and the
limits per address are what it meets.

## Operating g1t.sh

For Flagon staff.

- **Incidents** are declared, updated and resolved in sudo, under
  **Platform → Incidents**, and appear on status.g1t.sh within 30 seconds.
  Declare as soon as people are affected, and pick the higher severity
  when unsure. SEV1 (down for most people, or data at risk) gets an update
  at least every 30 minutes and SEV2 (a core part broken for many) at least
  hourly; both email subscribers and need a blameless postmortem within
  five working days.
- **An Artifacts outage:** `scripts/ops/gitstore-namespaces.mjs` shows a
  failing namespace. After 15 minutes, serve it read-only from the fallback
  git store (`scripts/ops/restore-to-gitstore.mjs restore`, then the repos
  Worker's secret `GIT_FALLBACK_NAMESPACES`) and open an incident. To
  switch back, `reconcile` anything the fallback took, then delete the
  secret. The script's header has every step.
- **Costs and margin**, credits and the platform pause are
  in sudo, under **Costs & margin**. The code is in `services/billing/src`
  (`costs.rs`, `margin.rs`, `pricing.rs`, `budget.rs`, `platform.rs`).
