---
title: GitHub Actions
description: Your GitHub Actions workflows run on g1t as they are. Rename .github to .g1t and push.
---

g1t runs GitHub Actions workflows. They are written exactly as on GitHub,
and kept in `.g1t/workflows/` instead of `.github/workflows/`.

## Moving from GitHub

```sh
git mv .github .g1t
git commit -m "Run our workflows on g1t"
git push g1t main
```

That is the whole move. Everything in the folder comes along: workflows,
local actions under `.g1t/actions/` and anything else you keep there.
Workflows that still say `uses: ./.github/actions/setup` find it under
`.g1t/` once `.github` is gone.

g1t never reads `.github`. A repository mirrored to both places can keep
`.github` for GitHub and `.g1t` for g1t, side by side.

Then add your [secrets and variables](#secrets-and-variables): GitHub never
gives their values out, so they cannot be copied across.

## What runs

| On GitHub | On g1t |
| --- | --- |
| `on:` `push` (branches, tags, paths), `pull_request`, `pull_request_target`, `issues`, `issue_comment`, `pull_request_review`, `schedule`, `workflow_dispatch`, `workflow_run`, `merge_group`, `create`, `repository_dispatch` | The same, from g1t's own pushes, pull requests, issues, comments and [merge queue](/guides/merge-queue/). `create` starts on each new branch or tag; `repository_dispatch` on [a dispatch event](#repository-dispatch). |
| `jobs`, `needs`, `if`, `outputs`, `env`, `defaults`, `timeout-minutes`, `continue-on-error` | The same. |
| `strategy.matrix` with `include` and `exclude`, `fail-fast`, `max-parallel`, a matrix from `fromJSON(needs.…)` | The same. |
| `concurrency` with `cancel-in-progress`, for the workflow or for one job | The same: one run, or one job, of a group at a time. |
| `permissions:` for the workflow or for one job, `read-all`, `write-all` | The same: they decide what [the job's token](#the-jobs-token) may do. |
| `${{ }}` expressions: every operator, function and context | The same, including `hashFiles`, `success()`, `failure()`, `always()` and `cancelled()`. |
| `run:` with `bash`, `sh`, `python` or a custom shell | The same. |
| JavaScript actions (`uses: owner/repo@v7`) | Fetched from GitHub and run as they are, on Node 24, the runtime current actions declare. |
| Composite actions | The same. |
| Reusable workflows in the repository (`jobs.<id>.uses: ./.g1t/workflows/build.yml`) | The same: `with:` inputs, `on.workflow_call` outputs, and nesting up to four deep. `./.github/workflows/…` finds the workflow under `.g1t/` after the move. Their jobs read the repository's secrets and variables. |
| `actions/checkout` | Checks out from g1t, with `ref`, `fetch-depth`, `path`, `repository`, `token` and `submodules`. |
| `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY` | The same. |
| `::error::`, `::warning::`, `::notice::`, `::group::`, `::add-mask::` | The same: errors and warnings become annotations on the run, and [masked](#masking-secrets) values stay hidden. |
| `secrets.*`, `vars.*`, `secrets.GITHUB_TOKEN` | The same. `secrets.G1T_TOKEN` is [the job's own token](#the-jobs-token); `GITHUB_TOKEN` is its alias. |
| `environment:` on a job | The job waits for the environment's [protection rules](#environments), then reads each key's row for that environment, as environment secrets work, and the run records a [deployment](/guides/deployments-api/#deployments-from-g1t-actions) to it. `url` gives the deployment its address; `deployment: false` reads the environment's values without making one. The name may be an expression. |
| `actions/upload-artifact`, `actions/download-artifact`, `actions/upload-artifact/merge` | The same inputs and outputs as version 4: `retention-days`, `overwrite`, `compression-level`, `include-hidden-files`, `!` exclusions, download by `pattern` with `merge-multiple`, and from another run with `run-id` and `github-token`. Up to 5 GiB each; see [artifacts](#artifacts). |
| `actions/cache`, `actions/cache/restore`, `actions/cache/save` | Kept per repository and branch, found by `key` or the newest under a `restore-keys` prefix. `path` takes globs and `!` exclusions. Up to 2 GiB each; see [the cache](#the-cache). |
| Actions that cache through the toolkit, such as `actions/setup-node` with `cache: npm` or `Swatinem/rust-cache` | The same: they save to and restore from the repository's cache. See [actions built on the toolkit](#actions-built-on-the-toolkit). |
| `permissions: id-token: write` | The job can ask for an OIDC token, and trade it for a cloud provider's credentials. See [OIDC tokens](#oidc-tokens). |
| `docker build`, `push`, `run`, `login`, `compose`, Buildx | The same, with a Docker Engine of the job's own. See [Docker](#docker). |
| `services:` | The same: each service starts before the steps, health checks are waited for, and it is reached at `localhost` on its port and by its name. |
| `container:` | The same: every step runs inside the image. |
| `uses: docker://image`, Docker actions (`runs.using: docker`) | The same: built from the action's Dockerfile or pulled, and run with GitHub's `/github/workspace` layout. |
| `docker/setup-buildx-action`, `docker/build-push-action`, `docker/login-action` | The same. `setup-buildx-action` picks the job's own Engine as the builder. |

The **Actions** page of a workflow says, under *How this runs on g1t*,
anything in it that runs differently.

### Not yet

- **Windows and macOS on g1t's machines.** g1t's own runners are Linux; a
  job with `runs-on: windows-latest` or `macos-latest` fails, and says so.
  [Self-hosted runners](/guides/self-hosted-runners/) of any OS run them:
  `runs-on: [self-hosted, windows]`.
- **Docker's `type=gha` build cache.** Buildx skips it on g1t, and the
  build runs without a cache. Use a registry cache instead; see
  [caching image builds](#caching-image-builds).
- **Reusable workflows from other repositories** (`uses: owner/repo/.github/workflows/x.yml@v1`); ones in the same repository work.
- **Actions that upload artifacts with the toolkit's artifact library
  themselves.** The library refuses to run against any server but
  github.com. `actions/upload-artifact`, `actions/download-artifact` and
  `actions/upload-artifact/merge` work, because g1t runs them itself. See
  [actions built on the toolkit](#actions-built-on-the-toolkit).
- **`on: delete`.** Deleting a branch or tag starts no workflows yet; the
  workflow's page says so.

Why each of these is missing, and what to use instead, is on
[What g1t can't do yet](/about/limitations/#actions-and-runners).

## The runner

Jobs run in a fresh sandbox each: Debian with Node 24, Python 3, Go, Rust,
Java 21, .NET 8, Ruby 3.3, `build-essential`, `git`, `curl`, `jq`, Docker
(with Buildx and Compose) and passwordless `sudo`, in GitHub's layout
(`/home/runner/work`, `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`).
`runner.os` is `Linux`. `ubuntu-latest`, `ubuntu-24.04` and other Linux
labels all run here. A job whose `runs-on` names `self-hosted` waits for one
of your [self-hosted runners](/guides/self-hosted-runners/) instead. Setup actions such as
`actions/setup-node` and `actions/setup-python` install other versions as
they do on GitHub.

### Languages and their setup actions

Each language below is on `PATH` from the job's first step, so a workflow
that only runs `java`, `dotnet` or `ruby` needs no setup step. When it has
one, the setup action finds the version that is already there and
downloads nothing.

| Language | Version | Where | Setup action |
| --- | --- | --- | --- |
| Java | Eclipse Temurin 21 (LTS), JDK | `JAVA_HOME` (also `JAVA_HOME_21_X64`), in `RUNNER_TOOL_CACHE` | `actions/setup-java` with `distribution: temurin` and `java-version: 21` uses it. Other versions and distributions are downloaded. |
| .NET | SDK 8 (LTS) | `DOTNET_ROOT`, `/usr/share/dotnet` | `actions/setup-dotnet` with `dotnet-version: 8.0.x` keeps it when it is the newest 8.0 SDK, and installs other SDKs beside it. |
| Ruby | 3.3, with Bundler | in `RUNNER_TOOL_CACHE` | `ruby/setup-ruby` with `ruby-version: '3.3'` (or a `.ruby-version` naming 3.3) uses it. |
| Node | 24 | `/usr/local/bin` | `actions/setup-node` installs other versions. |
| Python | 3.11 | `/usr/bin/python3` | `actions/setup-python` installs other versions. |
| Go | 1.27 | `/usr/local/go` | `actions/setup-go` installs other versions. |
| Rust | stable, with `rustfmt`, `clippy` and the `wasm32-unknown-unknown` target | `~/.cargo/bin` | `rustup` is there to add toolchains and targets. |

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: actions/setup-java@v5
    with:
      distribution: temurin
      java-version: 21
  - run: ./gradlew build
```

Because the sandbox runs Debian, `ruby/setup-ruby` treats it as a
self-hosted runner and uses only the Rubies in `RUNNER_TOOL_CACHE`. A version other than 3.3 fails at that step; install
it in a `run` step instead (for example with `ruby-build`) or run the job
in a `container:` with the Ruby you need, such as `ruby:3.4`.

The headers that gems and .NET need to build native code (`libyaml`,
`libffi`, `zlib`, OpenSSL, ICU) are installed too.

### Calling g1t's API from a job

The `gh` command is not installed: it needs a GraphQL API, and g1t's API
is REST. Call it with `curl`, using the job's token and the API's address,
which every job has as `GITHUB_API_URL`:

```yaml
- name: Comment on the pull request
  env:
    TOKEN: ${{ github.token }}
  run: |
    curl -fsS -X POST "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/issues/${{ github.event.number }}/comments" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"body": "Built."}'
```

The token reaches this repository and does what the job's `permissions:`
say; see [the job's token](#the-jobs-token). The
[API reference](/reference/api/) lists every endpoint.

### Machine sizes

A job runs on the standard machine unless its `runs-on` names a larger
one:

| `runs-on` | vCPUs | Memory | Disk |
| --- | --- | --- | --- |
| `ubuntu-latest`, or any other Linux label | 0.5 | 4 GiB | 8 GB |
| `g1t-2core` | 2 | 8 GiB | 16 GB |
| `g1t-4core` | 4 | 12 GiB | 20 GB |

```yaml
jobs:
  build:
    runs-on: g1t-4core
```

The label can come from the matrix or the run's inputs
(`runs-on: ${{ matrix.big && 'g1t-4core' || 'ubuntu-latest' }}`). A
larger machine costs what it costs g1t, plus the same margin as all
sandbox time: see [usage and billing](/guides/usage-and-billing/#workflow-jobs-on-larger-machines).
Builds that compile, such as Rust or a large TypeScript project, finish
several times faster on one.

A job on g1t's machines runs for at most 60 minutes, whatever its
`timeout-minutes`; one on a self-hosted runner can run for up to 24 hours.
A job stopped at its time cap fails saying so.

### What a job can reach

A job's network is restricted, as an agent's is (see
[guardrails](/guides/guardrails/)): it reaches the hosts its project's
guardrails allow, g1t itself, and what builds need, and nothing else.
What builds need is the package registries (npm, PyPI, crates.io, the Go
proxy, RubyGems, Packagist, NuGet, Maven and Gradle, Debian's mirrors),
GitHub, where `uses:` actions and the setup actions' downloads come from,
the toolchains' download sites (`nodejs.org`, `go.dev`,
`static.rust-lang.org`), and the public container registries (Docker Hub,
GitHub's, Quay, and `mirror.gcr.io`, the mirror of Docker Hub that a job's
Engine asks first). A request anywhere else gets `403` with
the reason. To reach another host, someone with the Maintain [role](/guides/access-and-roles/) or
higher adds it to the project's
allowed domains under **Settings → Guardrails**; a project whose guardrails
turn the network restriction off runs its jobs with an open network.

A host only workflows should reach, such as the API a deploy uploads to,
goes in **Workflow-only domains** instead, limited to the workflows and
environments that need it: `api.cloudflare.com | deploy.yml | production`
lets only `deploy.yml`'s jobs with `environment: production` reach it.
Agents never reach those hosts, and neither do runs of pull requests from
forks. See [workflow-only domains](/guides/guardrails/#workflow-only-domains).

g1t does not run cryptocurrency miners: a step that names one (`xmrig`,
a `stratum+tcp://` pool, `--donate-level`) is not run, and a job that
looks like it is mining is stopped. See
[abuse and mining](/guides/guardrails/#abuse-and-mining).

## Docker

Each job on g1t's machines has a Docker Engine of its own, inside the
job's sandbox. Nothing runs until the job uses it: the first `docker`
command, or a job's `services:` or `container:`, starts it, in a second
or two, and the log says so. It ends with the job, with every image,
container and build cache in it. No other job, repository or workspace
ever shares it.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: ${{ secrets.DB_PASSWORD }}
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready --health-interval 5s --health-retries 10
    steps:
      - uses: actions/checkout@v5
      - run: docker compose up -d --wait
      - run: npm test
        env:
          DATABASE_URL: postgres://postgres:${{ secrets.DB_PASSWORD }}@localhost:5432/postgres
```

### What works

| | On g1t's machines |
| --- | --- |
| `docker build`, `buildx build`, `run`, `exec`, `pull`, `push`, `login`, `compose` | Work as they do on GitHub's runners. The Engine, Buildx and Compose are current releases. |
| `services:` | Pulled and started before the first step, with `env`, `ports`, `volumes`, `options` and `credentials`. Services with a health check are waited for; one that turns unhealthy fails the job with its log. Each service's log is printed when the job ends. `job.services.<id>.id`, `.network` and `.ports` are set. |
| `container:` | Every `run` step and JavaScript action runs inside the image, with its `env`, `options`, `volumes` and `credentials`. The workspace, `RUNNER_TEMP` and the tool cache are mounted at the same paths as on g1t's runner. |
| `uses: docker://image` | Pulled and run, with `with.args` and `with.entrypoint`. |
| Docker actions | Built from the action's Dockerfile (or pulled, for `image: docker://…`), and run with its `args`, `env` and `entrypoint`, its inputs as `INPUT_*` variables, and `pre-entrypoint` and `post-entrypoint`. |
| `docker/setup-buildx-action` | Selects the job's own Engine as the builder (BuildKit). Its `name`, `driver`, `platforms` and `nodes` outputs are set. `driver`, `driver-opts` and `buildkitd-*` are not used, and the log says so. |
| `docker/build-push-action` | Works, with `push`, `load`, `tags`, `labels`, `build-args`, `secrets`, `target`, `provenance` and `sbom`. |
| `docker/login-action` | Works, for g1t's registry, Docker Hub, GitHub's registry, Cloudflare's (`registry.cloudflare.com`) and any registry the job can reach. |

### Services and the network

Every container a job starts shares the job's own network, the one its
[guardrails](/guides/guardrails/) apply to. So:

- **A service is at `localhost`** on its port, from steps and from other
  containers. `ports: ["5432:5432"]` and `ports: ["5432"]` both mean
  `localhost:5432`.
- **A port mapped to another number** (`ports: ["6543:5432"]`, or
  `docker run -p 8080:80`) is forwarded: `localhost:6543` reaches the
  service's 5432. `job.services.<id>.ports` says which port to use, and
  `docker inspect` and `docker port` report it.
- **A service is also reached by its name**, as it is from a job
  container on GitHub: `postgres:5432` works from steps, from the job's
  container and from any container started later. So do the names of
  containers and Compose services, and their network aliases.
- **Two containers cannot listen on the same port.** A job with a
  `redis` service and a Compose file that starts another Redis on 6379
  gets an error from the second; give one of them another port.

A container that asks for `--network none` gets none, and
`--network container:<name>` shares that container's.

### Job containers

With `container:`, the steps run inside the image as its default user,
usually `root`. A few things differ from GitHub's runner:

- The workspace is at the same path as on g1t's runner
  (`/home/runner/work/…`), not `/__w`. `github.workspace` is correct
  either way.
- JavaScript actions run inside the container with g1t's Node 24, which
  needs an image with glibc and `libstdc++` (Debian, Ubuntu and most
  language images have both). In an image without them, such as Alpine,
  they run beside the container, on g1t's runner, with the same files,
  and the log says so.
- `actions/checkout`, `actions/cache` and the artifact actions run on
  g1t's runner, with the same files.

### Building and pushing images

On g1t's machines, a job is signed in to g1t's container registry from
the start, with its own `G1T_TOKEN`, so it can push to and pull from its
repository's images without a login step; images of other repositories
need this one added under their
[Manage Actions access](/guides/packages/#manage-actions-access). A run that gets no secrets is
not signed in. See [container registry](/guides/containers/#in-workflows).

```yaml
jobs:
  image:
    runs-on: g1t-4core
    steps:
      - uses: actions/checkout@v5
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: g1t.sh/${{ github.repository }}:${{ github.sha }}
          cache-from: type=registry,ref=g1t.sh/${{ github.repository }}:buildcache
          cache-to: type=registry,ref=g1t.sh/${{ github.repository }}:buildcache,mode=max
```

For other registries, sign in with `docker/login-action` or
`docker login`, as on GitHub. Docker Hub's images are pulled through its
public mirror first, so jobs are rarely held up by Docker Hub's limits on
anonymous pulls.

#### Caching image builds

The Engine starts empty in every job, so a build's layers are rebuilt
unless the job brings a cache:

- **A registry cache** (`cache-to: type=registry,ref=…,mode=max`), in g1t's
  registry or any other, is the simplest and is shared by every branch.
- **A local cache** (`cache-to: type=local,dest=/tmp/buildx-cache`) saved
  and restored with `actions/cache`, within [the cache's limits](#the-cache).
- **`type=gha`** is not used on g1t yet: Buildx skips it, and the build
  runs without a cache.

### Limits

- **Machine.** Containers share the job's machine: its vCPUs, memory and
  disk ([machine sizes](#machine-sizes)). Image builds and databases want
  `g1t-2core` or `g1t-4core`. `--cpus` and `--memory` limit a container
  within that.
- **Disk.** Images take room on the job's disk. On a machine whose disk
  cannot hold layered images, the Engine stores plain copies, which take
  more room; the log says when it does.
- **Linux, amd64.** Images for other platforms need QEMU's emulators,
  which g1t's machines do not have set up; `docker/setup-qemu-action` is
  not supported there yet.
- **Privileged containers** (`--privileged`) run, with no more reach than
  the job itself has: the job's sandbox is the boundary.

### How Docker is kept safe

- **One Engine per job.** It runs inside the job's own sandbox, a virtual
  machine of its own, and is gone with it. No Docker socket of g1t's, or of
  any machine, is shared with a job.
- **The job's guardrails hold.** Containers use the job's network, so a
  container, a build step or an image pull reaches only what the job may
  reach. A host off the list gets `403` with the reason, as any step does.
- **HTTPS keeps working.** In a job whose network is restricted, every
  container and build step is given the certificate the job's HTTPS is
  checked with, in `/dev/g1t-egress`, and `SSL_CERT_FILE`,
  `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `PIP_CERT`,
  `GIT_SSL_CAINFO` and `CARGO_HTTP_CAINFO` pointing at it, unless the
  container sets them itself. None of it is written into an image's layers.
  Tools that keep their own list of certificates, such as Java's, need it
  added in the build that uses them.
- **Short-lived credentials.** The registry sign-in uses the run's own
  token, which ends with the run; `credentials:` for a service or a job
  container are used for that pull only.
- **No miners.** A container whose image or command names a miner is not
  created, as a step's script is not run.

## The cache

`actions/cache` keeps what a job saves for the repository's later jobs:

| | |
| --- | --- |
| One entry | Up to 2 GiB, compressed. A larger one is not saved, and the job goes on. |
| A repository's entries | Up to 10 GiB together. Saving past it removes the entries restored longest ago. |
| How long | Until it has not been restored for 7 days, and at most 28 days after it was saved. |
| Which branch | An entry belongs to the branch, tag or pull request whose run saved it. A run restores from its own, then from the branch its pull request merges into, then from the default branch. |
| Keys | Written once on each branch: saving under a key that exists there does nothing. On each branch in turn, a restore finds its `key` exactly, else the newest entry whose key starts with one of its `restore-keys`. |
| `path` | Files and folders; globs, `**` included; `~/` is the home folder; a line starting with `!` leaves matching paths out. The same key saved for other paths is another entry. |
| Compression | zstd. |

So a feature branch can read what `main` saved, but `main` never reads
what a feature branch saved, and a pull request from outside the
repository saves where nothing else ever reads it: nobody can plant an
entry that the default branch's builds restore. Actions that cache through the
toolkit, such as `actions/setup-node` with `cache: npm`, follow the same
rules.

```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.cargo/registry/cache
      target/release
      !target/**/incremental
    key: cargo-${{ runner.os }}-${{ hashFiles('Cargo.lock') }}
    restore-keys: cargo-${{ runner.os }}-
```

Each restore and save says on the job's log how large the entry was and
how long it took. A workspace on the plan pays for what its caches and
[artifacts](#artifacts) hold (`Actions cache storage` on its statement),
at R2's price plus the margin; see
[usage and billing](/guides/usage-and-billing/#actions-cache).

## Artifacts

`actions/upload-artifact` keeps files a job made with its run, for later
jobs, other runs and people:

| | |
| --- | --- |
| One artifact | Up to 5 GiB, zipped. |
| A run's artifacts | Up to 10 GiB together. |
| How long | The repository's setting: 14 days unless someone with the Maintain role changes it under **Settings → Repository → Artifacts**, from 1 to 90 days. `retention-days` asks for fewer days, never more. |
| Names | One artifact per name in a run. Uploading a name again fails, unless the upload says `overwrite: true`, which replaces it. A name is up to 256 characters, none of `" : < > \| * ? \ /`. |
| `path` | Files, folders and globs, `**` included; a line starting with `!` leaves matching paths out. Files and folders whose names start with `.` are left out unless `include-hidden-files: true`. |
| Compression | `compression-level` 0 (stored) to 9; 6 unless you say. |
| Outputs | `artifact-id` (a number), `artifact-url` (its run's page) and `artifact-digest` (the SHA-256 of its zip). |

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: web-dist
    path: |
      dist/
      !dist/**/*.map
    retention-days: 5
    compression-level: 9
```

`actions/download-artifact` downloads one by `name` into `path`, or every
artifact of the run, each into a folder of its name; `pattern` picks them
by name, and `merge-multiple: true` puts them all in one folder.
`artifact-ids` picks them by number. With `github-token` and `run-id`, it
downloads from another run of the same repository, such as the one a
`workflow_run` workflow follows:

```yaml
- uses: actions/download-artifact@v4
  with:
    name: web-dist
    github-token: ${{ secrets.GITHUB_TOKEN }}
    run-id: ${{ github.event.workflow_run.id }}
```

`actions/upload-artifact/merge` downloads the run's artifacts that match
`pattern`, uploads them as one artifact (`name`, `merged-artifacts` unless
you say), and deletes them with `delete-merged: true`.

A run's page lists its artifacts with their size and when they expire.
Anyone who can see the run downloads them there; someone with the Write
role can delete one before it expires.

## Actions built on the toolkit

Many actions save to the cache with GitHub's toolkit, `@actions/cache`,
rather than through `actions/cache`: `actions/setup-node`,
`actions/setup-python`, `actions/setup-go` and `actions/setup-java` with
`cache:`, `Swatinem/rust-cache`, and others. They work on g1t as they
are: every job gets `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_CACHE_URL` and
`ACTIONS_RESULTS_URL`, and g1t answers the toolkit's requests from the
repository's cache.

- Their entries are the repository's, under [the cache's](#the-cache)
  limits, and are deleted the same way.
- An entry is restored only by the same kind of save: the toolkit names a
  version for each entry, from its paths and compression. An entry
  `setup-node` saved is not restored by `actions/cache`, and the other way
  round.
- An entry the toolkit sends whole, which it does below 128 MB, is not
  saved when it is over 100 MB, the most g1t takes in one request. The
  step warns and the job goes on.
- The toolkit's artifact library refuses to run against any server but
  github.com, so an action that uploads artifacts with it directly fails
  with its own message. `actions/upload-artifact`,
  `actions/download-artifact` and `actions/upload-artifact/merge` work:
  g1t runs those itself.

## OIDC tokens

A job can prove which repository, branch and environment it runs for with
a short-lived OpenID Connect token signed by g1t, and trade it for a cloud
provider's credentials. Nothing long-lived needs to sit in a secret.

1. Give the job, or the workflow, `permissions: id-token: write`. A job
   without it gets no token, and neither does a run of a pull request from
   outside the repository.
2. Tell your cloud to trust g1t's issuer for your repository (below).
3. Use the provider's own login action, which asks for the token.

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/acme-web-deploy
          aws-region: us-east-1
```

The job gets `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`, which `core.getIDToken()` reads. To ask
for a token yourself, name its audience:

```sh
curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://deploy.example.com" | jq -r .value
```

| | |
| --- | --- |
| Issuer | `https://api.g1t.sh/actions/oidc` |
| Discovery | `https://api.g1t.sh/actions/oidc/.well-known/openid-configuration` |
| Keys | `https://api.g1t.sh/actions/oidc/.well-known/jwks`, RS256, each with its `kid` |
| Lifetime | 5 minutes |
| Audience | What the job asks for; `https://g1t.sh/<owner>` when it asks for none |

### Claims

Each token carries the claims GitHub's do, so trust policies written for
those read g1t's the same way.

| Claim | Example |
| --- | --- |
| `sub` | `repo:acme/web:environment:production` for a job with an `environment:`; `repo:acme/web:pull_request` for a pull request's run; otherwise `repo:acme/web:ref:refs/heads/main` (or `refs/tags/v1.2.0`) |
| `repository`, `repository_owner` | `acme/web`, `acme` |
| `repository_id`, `repository_owner_id` | g1t's ids for them, such as `rep_01kpw0…` |
| `repository_visibility` | `public` or `private` |
| `ref`, `ref_type`, `ref_protected`, `sha` | `refs/heads/main`, `branch`, `"true"`, the commit |
| `head_ref`, `base_ref` | A pull request's branches |
| `environment` | The job's environment, when it has one |
| `event_name` | `push`, `pull_request`, `workflow_dispatch`, … |
| `workflow`, `workflow_ref`, `workflow_sha` | `Deploy`, `acme/web/.g1t/workflows/deploy.yml@refs/heads/main`, the commit |
| `job_workflow_ref`, `job_workflow_sha` | The workflow that defines the job: a called workflow's own file |
| `run_id`, `run_number`, `run_attempt` | `run_01kq9c…`, `"12"`, `"1"` |
| `actor`, `actor_id` | Who started the run |
| `runner_environment` | `github-hosted` on g1t's machines, `self-hosted` on yours |
| `iss`, `aud`, `jti`, `iat`, `nbf`, `exp` | As in any OIDC token |

### AWS

1. Add g1t as an identity provider, under **IAM → Identity providers**:
   provider type **OpenID Connect**, provider URL
   `https://api.g1t.sh/actions/oidc`, audience `sts.amazonaws.com`. Or:

   ```sh
   aws iam create-open-id-connect-provider \
     --url https://api.g1t.sh/actions/oidc \
     --client-id-list sts.amazonaws.com
   ```

2. Give the role a trust policy for your repository:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/api.g1t.sh/actions/oidc" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "api.g1t.sh/actions/oidc:aud": "sts.amazonaws.com",
           "api.g1t.sh/actions/oidc:sub": "repo:acme/web:environment:production"
         }
       }
     }]
   }
   ```

3. Use `aws-actions/configure-aws-credentials@v4` with `role-to-assume`,
   as above.

### Google Cloud

1. Make a workload identity pool and a provider for g1t:

   ```sh
   gcloud iam workload-identity-pools create g1t --location=global
   gcloud iam workload-identity-pools providers create-oidc g1t \
     --location=global --workload-identity-pool=g1t \
     --issuer-uri=https://api.g1t.sh/actions/oidc \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
     --attribute-condition="assertion.repository_owner == 'acme'"
   ```

2. Let the repository act as a service account:

   ```sh
   gcloud iam service-accounts add-iam-policy-binding deploy@acme-prod.iam.gserviceaccount.com \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/g1t/attribute.repository/acme/web"
   ```

3. Use `google-github-actions/auth@v2` with
   `workload_identity_provider: projects/123456789/locations/global/workloadIdentityPools/g1t/providers/g1t`
   and `service_account`. It asks for the provider's own name as the
   audience, which the provider accepts unless you change its allowed
   audiences.

### Azure

1. On the app registration or user-assigned managed identity, add a
   federated credential with the scenario **Other issuer**: issuer
   `https://api.g1t.sh/actions/oidc`, subject identifier
   `repo:acme/web:environment:production`, audience
   `api://AzureADTokenExchange`. Or:

   ```sh
   az ad app federated-credential create --id <application id> --parameters '{
     "name": "g1t-acme-web-production",
     "issuer": "https://api.g1t.sh/actions/oidc",
     "subject": "repo:acme/web:environment:production",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   ```

2. Give it a role on what it deploys to, as for any identity.
3. Use `azure/login@v2` with `client-id`, `tenant-id` and
   `subscription-id`, and no secret.

A federated credential matches the subject exactly: add one per
environment or branch that deploys.

### Cloudflare

Cloudflare's API takes API tokens, not OIDC tokens. Keep a token scoped
to what the workflow deploys in a secret, available to that workflow only
(see [workflow-only domains](/guides/guardrails/#workflow-only-domains)
for limiting where it can be sent).

A Worker of your own can trust g1t's jobs directly, by checking the token
a job sends it against g1t's keys:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const keys = createRemoteJWKSet(new URL("https://api.g1t.sh/actions/oidc/.well-known/jwks"));

export async function fromG1tJob(request: Request): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const { payload } = await jwtVerify(token, keys, {
    issuer: "https://api.g1t.sh/actions/oidc",
    audience: "https://deploy.example.com",
  });
  return payload.sub === "repo:acme/web:environment:production";
}
```

### npm

npm's trusted publishing and provenance accept OIDC tokens only from the
CI services npm lists, and g1t is not one of them yet. Publish with a
granular access token in a secret instead:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
    registry-url: https://registry.npmjs.org
- run: npm publish
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

See [What g1t can't do yet](/about/limitations/#no-npm-trusted-publishing-or-provenance).

## Runs and logs

Open a repository's **Actions** page, in its sidebar. Pick a workflow to
see its runs, run it by hand if it has `workflow_dispatch`, or turn it off
without touching its file.

A run's page shows its jobs, each job's steps, and their logs as they are
written. Groups fold, errors and warnings are marked, and secrets are
replaced with `***`. **Cancel**, **Re-run all jobs** and **Re-run failed
jobs** do what they say.

The start of each job's log lists what its [token](#the-jobs-token) may do.

### Masking secrets

Every secret's value is replaced with `***` wherever a job prints it, and
so is every value a step masks with `::add-mask::`. Each is masked in the
forms it shows up in:

| Form | Example |
| --- | --- |
| As it is | `echo $API_KEY` |
| Each of its lines on its own | `cat key.pem`, which prints a private key a line at a time |
| Base64 | `echo -n $API_KEY \| base64`, or an `Authorization: Basic` header |
| JSON-escaped | A secret holding quotes or newlines printed inside JSON |

Annotations' titles and messages, and step names, are masked the same way.
A job output that holds a secret in any of those forms is left out, with
a warning in the log, since outputs go to other jobs and to the run's page.
A value of one character is not masked: it would hide that character
everywhere.

## Pull requests

A pull request's workflows run on each new head: when it is opened, when
a commit is pushed to it, and, for one g1t makes, when g1t
marks it ready, which on g1t is when it first has code. Each head runs
each workflow once.

They also start on the activity types `labeled`, `unlabeled`,
`milestoned`, `demilestoned`, `assigned`, `review_requested` and
`closed`, and `edited` when the branch a pull request merges into
changes; `issues` workflows on `labeled`, `unlabeled`, `milestoned` and
`demilestoned` too. List them under `types:` to run on them. For
`labeled` and `unlabeled`, `github.event.label` names the label. A pull
request's `branches` filter, `github.base_ref` and
`pull_request.base.ref` are the branch it merges into, which is not
always the default branch: see
[pull requests into other branches](/guides/base-branches/).

A pull request from outside the workspace may wait for approval before
its workflows run: see [pull requests from outside](#pull-requests-from-outside).

`github.event.pull_request` reads as it does on GitHub. For a pull request
g1t made, `pull_request.user` is g1t (`login` `g1t`, `type` `Bot`), and
`pull_request.requested_by` names the person who asked for it; it is `null`
on anyone else's. `github.event.issue.requested_by` does the same for an
issue g1t's agent filed. `sender` is whoever caused the event.

## Checks

A pull request's checks are its workflows. Each workflow that runs on
`pull_request` runs on every pull request's head, whoever opened it, a
person or an agent, and its runs report a check named after the workflow:
a workflow with `name: CI` reports `CI`, with the status context
`CI / pull_request` (the workflow's name and the event). Each of its jobs
is a [check run](/guides/checks/) on the commit, shown as
`CI / test (pull_request)` beside it wherever it appears.

- **Which checks a merge needs** is up to the [rules](/guides/rules/) of the branch it merges into,
  their [required status checks](/guides/pull-requests/#required-status-checks),
  under **Settings → Rules**. A required check that failed,
  is still running or has not reported holds the merge. Checks that are not
  required are shown on the pull request and never hold it.
- **In a repository that merges through the [merge queue](/guides/merge-queue/)**,
  workflows with `on: merge_group` run on each combined state the queue
  builds, on the branch `g1t-queue/<entry>`, and the state lands only if
  they and every required check pass on it. A workflow behind a required
  check needs `merge_group` in its `on:`.
- **A pull request g1t is working on** goes back to g1t when
  a check fails, with the end of each failed job's log. The agent reads the
  run and its logs with the same tools you have, fixes the cause, and
  pushes; the workflows run again. See
  [seeing it through](/guides/working-with-g1t/#seeing-it-through).

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  merge_group:
```

### Add CI

A repository with no workflows has nothing that proves a change works, for
people or for agents. Its pull requests, its **Branches and merging**
settings and its **Actions** page say **This repository has no checks**,
with an **Add CI** button. Anyone who can push to the repository can use it:

1. Choose **Add CI**. g1t looks at the files at the repository's root and
   writes a starter workflow with a job for each stack it finds, up to
   three: Node (npm, pnpm, Yarn or Bun), Rust, Go, Python (pip or uv), Ruby,
   Java (Maven or Gradle), .NET, or Make. Each job installs, lints where
   the project says how, builds and tests. When it finds none, the job is a
   placeholder that fails until you replace its last step with your own
   commands.
2. The workflow is committed as `.g1t/workflows/ci.yml` on a new branch,
   `add-ci`, and opened as a pull request, by you. It is named `CI` and runs
   on `pull_request`, on `push` to the default branch, and on `merge_group`.
3. Change it on the pull request if the steps are not how your project
   builds, and merge it.
4. Once it has run, `CI` is offered under **Require status checks to pass
   before merging**.
   Require it, so that nothing merges into the default branch unless it
   passes.

## Secrets and variables

Secrets are read as `${{ secrets.KEY }}` and config as `${{ vars.KEY }}`,
from the rows under **Settings → Secrets and variables** that are
available to Workflows. A job with `environment: production` reads each
key's Production row; other jobs read the rows for all environments. A
job with an `environment:` also makes a deployment to it; see
[deployments from g1t Actions](/guides/deployments-api/#deployments-from-g1t-actions). See
[Secrets and variables](/guides/secrets-and-variables/) for how rows,
environments and the workspace's rows work.

Every job also gets `${{ secrets.G1T_TOKEN }}`, [its own token](#the-jobs-token),
with `GITHUB_TOKEN` as its alias. A pull request's runs get secrets only
when its author has the Write [role](/guides/access-and-roles/) or higher
on the repository, a member or an outside collaborator, or is g1t working
on its own. For a pull request g1t made, its author is g1t and the person
who asked for it is the one whose role counts. Anyone else's, such as one
from a fork or by someone with Read or Triage, runs without secrets and
with a token that can only read. See
[who gets secrets](/guides/secrets-and-variables/#who-gets-secrets).

## The job's token

Each job gets a token of its own, `${{ secrets.G1T_TOKEN }}`
(`${{ secrets.GITHUB_TOKEN }}` and `${{ github.token }}` are the same).
`actions/checkout` uses it, and so can any step that calls the
[API](/reference/api/) or pushes with git:

- It reaches **this repository only**. Every other repository, even one
  in the same workspace, is refused. So are packages: it reaches this
  repository's own, and another package only once the package's admins
  add this repository under its
  [Manage Actions access](/guides/packages/#manage-actions-access).
- It can do **what its `permissions:` say**, and nothing more.
- It **stops working when the job ends**, however it ends.
- Everything it changes is in the [audit log](/guides/audit-log/) as that
  job's, under its run.
- What it changes **starts no workflows**: a push, a pull request, an issue
  or a comment made with it runs nothing, so a workflow cannot set itself
  off. `workflow_dispatch` and [`repository_dispatch`](#repository-dispatch)
  are the exceptions, for a workflow that means to start another.

`permissions:` goes at the top of the workflow, for every job, or on a job,
which then ignores the workflow's. Once either is written, every permission
it leaves out is `none`:

```yaml
permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
      - run: ./scripts/release.sh
```

| Permission | `read` lets it | `write` also lets it |
| --- | --- | --- |
| `contents` | Clone and fetch with git, read the repository | Push, publish releases |
| `pull-requests` | Read pull requests | Open, review, close and merge them |
| `issues` | Read issues | Open, edit, comment on and close them |
| `actions` | Read workflows, runs and logs | Run, cancel and re-run them |
| `checks`, `statuses` | Read statuses and check runs | Report them |
| `deployments`, `pages` | Read deployments | Report them |
| `packages` | Pull packages | Push and publish them |
| `security-events` | Read security alerts | Upload code scanning results, change alerts |
| `metadata` | Always `read` | |
| `id-token` | Nothing | Ask for an [OIDC token](#oidc-tokens) |
| `discussions`, `attestations`, `models`, `repository-projects` | Nothing on g1t | Nothing on g1t |

`read-all` and `write-all` set every permission; `permissions: {}` sets
none, so the token cannot even clone a private repository. A reusable
workflow's jobs get no more than the job that calls it.

There is no `workflows` permission for a job's token: it can never add,
change or delete a file under `.g1t/workflows/` or `.github/workflows/`,
even with `contents: write`. A push that does is declined, naming the file,
so a workflow cannot rewrite the workflows that run with its repository's
secrets. To change workflows from a job, push with a
[fine-grained token](/guides/authentication/#workflow-files) that has the
Workflows permission, kept as a secret.

The job's token is the repository's workspace acting with the Write role
at most, never Admin: it cannot manage webhooks, secrets, deploy keys or who
has access, whatever it asks for.

**Without `permissions:`** a job gets the repository's default, which
someone with the Admin role sets under **Settings → Actions**:

| Repository | Default until someone chooses |
| --- | --- |
| Made before restricted tokens came in, in October 2026 | **Read and write**: every permission at `write`, as before |
| Made since | The workspace's default for new repositories: **Read repository contents and packages** (`contents: read`, `packages: read`) unless an owner chose otherwise |

The workspace's owners set that default, and a **maximum**, under the
workspace's **Settings → Actions**: with a maximum of **Read only**, no
repository's default goes past `contents: read` and `packages: read`,
whatever it chose. Workflows that write `permissions:` get what they
write either way, and whatever a workflow asks for, a pull request from
outside the repository's writers (a fork, or someone with Read or Triage)
gets a token that can only read.

**Allow g1t Actions to create and approve pull requests** is off unless a
repository's admin turns it on under **Settings → Actions**, and they can
only where the workspace's owners allow it. Until then a job's token
cannot open a pull request or approve one, whatever its `pull-requests`
permission says; it can still read, comment on, review with changes
requested, and merge them.

The token can never change secrets, variables, environments' rules or
the Actions settings, approve runs or deployments, or reach another
repository.

## Environments

A job that names an environment with `environment:` reads that
environment's [secrets and variables](/guides/secrets-and-variables/#a-value-per-environment)
and records a [deployment](/guides/deployments-api/#deployments-from-g1t-actions)
to it. Give the environment protection rules, and such a job waits until
they let it through, and only then gets the environment's secrets:

| Rule | What it does |
| --- | --- |
| **Required reviewers** | Up to 6 people or teams. The job waits until one of them approves it. |
| **Prevent self-review** | Whoever started the run cannot approve it, even as a reviewer. |
| **Wait timer** | Minutes the job waits once it reaches the environment, up to 43,200 (30 days). |
| **Deployment branches and tags** | **All branches**; **Protected branches only**, those the repository's [rules](/guides/rules/) protect, the default branch included; or **Selected branches and tags**, by pattern, such as `main`, `release/*` or `v*`. A job on any other ref fails, saying so. A pull request's run is on no branch, so it can deploy only where all branches may. |
| **Allow admins to bypass** | On unless you turn it off: someone with the Admin role may approve without being a reviewer, which also skips the wait timer. |

To set them:

1. Open the repository's **Settings → Environments**. It lists every
   environment your workflows, secrets and deployments name.
2. Choose one, or name a new one, and set its rules.
3. Save. Runs that reach the environment from then on wait by them.

A run whose jobs wait shows **Waiting for review** at the top of its page,
with the environments, the jobs each holds, its reviewers and when its
wait timer runs out. Reviewers are told in their [inbox](/guides/inbox/);
on the run's page they choose **Approve and deploy** or **Reject**, with
room for a comment. One review covers every job of the run that names the
environment. A rejected job fails, and so does anything that needs it. The
rest of the run goes on meanwhile: jobs that do not need the waiting ones
run.

The environment's name may be an expression, such as
`environment: ${{ inputs.target }}`: it is read once the job's needs are
done, and its rules and secrets are that environment's. Names are matched
without regard to case.

From the API, `PUT /repos/{owner}/{repo}/environments/{environment}` sets
the rules, with `reviewers`, `prevent_self_review`, `wait_timer`,
`deployment_branch_policy`, `branch_policies` and `can_admins_bypass`;
`GET` on the same route returns them as `protection_rules`; `DELETE`
removes them. `POST /repos/{owner}/{repo}/actions/runs/{id}/pending_deployments`
approves or rejects a run's waiting jobs:

```sh
curl -X PUT https://api.g1t.sh/repos/acme/web/environments/production \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"reviewers": [{"type": "Team", "name": "deployers"}], "wait_timer": 10,
       "deployment_branch_policy": {"protected_branches": true, "custom_branch_policies": false}}'
```

A job's own token cannot approve, reject or change any of it.

## Pull requests from outside

A pull request from someone outside the workspace runs code anyone could
have written. By the repository's **approval policy**, its runs wait as
**Approval required** until someone with the Write
[role](/guides/access-and-roles/) chooses **Approve and run** on the run's
page. Nothing runs before then: no job starts, and no token or secret is
handed out.

| Policy, under **Settings → Actions** | Whose pull requests' runs wait |
| --- | --- |
| **First-time contributors** | Someone outside the workspace who has not had a pull request merged here yet. |
| **Outside contributors** (the default) | Those, and everyone outside the workspace who cannot push here: pull requests from forks, and from people with Read or Triage. |
| **All external contributors** | Everyone outside the workspace, [outside collaborators](/guides/access-and-roles/#outside-collaborators) with Write included. |

Members' pull requests never wait, nor do pull requests g1t opens on its
own. For a pull request g1t made for someone, that person is the one whose
policy counts. Each new push to the pull request waits again.
`pull_request_target` runs, which run the default branch's workflow and
code, never wait.

From the API: `POST /repos/{owner}/{repo}/actions/runs/{id}/approve`
approves a run, and `GET` and `PUT
/repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval`
read and set the policy, as `approval_policy`.

## Repository dispatch

`POST /repos/{owner}/{repo}/dispatches` starts the default branch's
workflows that run `on: repository_dispatch` for its `event_type`, those
listing it under `types:` or listing none. `client_payload` is theirs to
read as `github.event.client_payload`:

```yaml
on:
  repository_dispatch:
    types: [docs-published]

jobs:
  announce:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Docs ${{ github.event.client_payload.version }} are out"
```

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/dispatches \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"event_type": "docs-published", "client_payload": {"version": "2.4.0"}}'
```

It needs the Write role, or a token with `code:write`; a job's own token
needs `contents: write`. `client_payload` is a JSON object of at most 10
properties and 64 KB.

## Who may run workflows

What you can do with a repository's workflows follows your
[role](/guides/access-and-roles/) on it:

| | Needs |
| --- | --- |
| See workflows, runs and their logs | Read: on a public repository, anyone |
| Run a workflow by hand, cancel or re-run a run, approve a pull request's run from outside | Write |
| Approve or reject a job waiting for an environment | One of the environment's reviewers |
| Enable or disable a workflow | Maintain |
| The repository's secrets and variables, seeing them included; environments' rules; **Settings → Actions** | Admin |

Jobs run in g1t's sandboxes, so they need the
[g1t plan](/guides/usage-and-billing/#the-g1t-plan) or
[the trial](/guides/usage-and-billing/#the-trial); jobs on
[self-hosted runners](/guides/self-hosted-runners/#billing) need neither.
On a public repository,
[g1t's open-source pool](/guides/usage-and-billing/#the-open-source-pool)
runs them too, after a card check, until the month's pool is spent.

Before each job starts, g1t reserves what it may cost (its time limit at
the sandbox price) with billing, and settles what it really cost when it
ends; each job's sandbox is charged as
[sandbox time](/guides/usage-and-billing/#sandbox-time), from the first
second. A job billing refuses does not start: it is recorded as failed
with "Not started:" and the reason, such as "Workflows run in g1t's
sandboxes, which cost real money, so they need the g1t plan ($20 a month)
or a card check", and what to do about it. The
Actions page tells people with Write on a repository whose workspace
cannot run jobs before the first run.

## From the API

The routes follow the standard Actions REST shape, so existing scripts
usually work once they point at `https://api.g1t.sh`.

| `workflow` action | Route |
| --- | --- |
| `list` | `GET /repos/{owner}/{repo}/actions/workflows` |
| `list_runs` | `GET /repos/{owner}/{repo}/actions/runs`, with `workflow`, `branch`, `event`, `pull`, `head_sha` |
| `get_run` | `GET /repos/{owner}/{repo}/actions/runs/{id}` |
| `job_logs` | `GET /repos/{owner}/{repo}/actions/jobs/{job}/logs?after=` |
| `dispatch` | `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` with `ref` and `inputs` |
| `cancel` | `POST /repos/{owner}/{repo}/actions/runs/{id}/cancel` |
| `rerun` | `POST …/runs/{id}/rerun`, or `…/rerun-failed-jobs` |
| `update` | `PUT …/workflows/{workflow}/enable` and `…/disable` |
| `approve_run` | `POST /repos/{owner}/{repo}/actions/runs/{id}/approve` |
| `pending_deployments` | `GET /repos/{owner}/{repo}/actions/runs/{id}/pending_deployments` |
| `review_deployments` | `POST /repos/{owner}/{repo}/actions/runs/{id}/pending_deployments` with `environment_names`, `state` and `comment` |
| `get_environment` | `GET /repos/{owner}/{repo}/environments/{environment}` |
| `update_environment` | `PUT /repos/{owner}/{repo}/environments/{environment}` |
| `delete_environment` | `DELETE /repos/{owner}/{repo}/environments/{environment}` |
| `get_permissions`, `set_permissions` | `GET` and `PUT /repos/{owner}/{repo}/actions/permissions/workflow`, with `default_workflow_permissions` (`read`, `write` or `inherit`) and `can_approve_pull_request_reviews` |
| `get_workspace_permissions`, `set_workspace_permissions` | `GET` and `PUT /workspaces/{workspace}/actions/permissions/workflow`, with `default_workflow_permissions`, `max_workflow_permissions` and `can_approve_pull_request_reviews` |
| `get_approval_policy`, `set_approval_policy` | `GET` and `PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval` |
| `repository_dispatch` | `POST /repos/{owner}/{repo}/dispatches` with `event_type` and `client_payload` |
| `list_artifacts` | `GET /repos/{owner}/{repo}/actions/artifacts`, with `name`, `page`, `per_page` |
| `run_artifacts` | `GET …/actions/runs/{id}/artifacts`, with `name` |
| `get_artifact` | `GET …/actions/artifacts/{artifact_id}` |
| `download_artifact` | `GET …/actions/artifacts/{artifact_id}/zip`: a `302` to a link good for 10 minutes |
| `delete_artifact` | `DELETE …/actions/artifacts/{artifact_id}` |
| `artifact_retention`, `set_artifact_retention` | `GET` and `PUT …/actions/permissions/artifact-and-log-retention` with `days` (it sets artifacts' days only; logs are kept with their run) |

Secrets and variables have a tool of their own, `secret`:

| `secret` action | Route |
| --- | --- |
| `list_secrets`, `set_secret`, `delete_secret` | `GET /repos/{owner}/{repo}/actions/secrets`, `PUT` and `DELETE …/secrets/{name}` |
| `list_variables`, `set_variable`, `delete_variable` | `GET` and `POST /repos/{owner}/{repo}/actions/variables`, `PATCH` and `DELETE …/variables/{name}` |

Workspace secrets and variables are under
`/workspaces/{workspace}/actions/secrets` and `…/variables`. The fields
g1t adds (environments, who reads a row, linked repositories) are in
[Secrets and variables](/guides/secrets-and-variables/#from-the-api).

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/actions/workflows/ci.yml/dispatches \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref": "main", "inputs": {"environment": "staging"}}'
```

To save an artifact from a script, follow the redirect:

```sh
curl -L -o web-dist.zip -H "Authorization: Bearer $G1T_TOKEN" \
  https://api.g1t.sh/repos/acme/web/actions/artifacts/4182/zip
```
