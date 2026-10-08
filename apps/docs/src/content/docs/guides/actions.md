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
| `on:` `push` (branches, tags, paths), `pull_request`, `pull_request_target`, `issues`, `issue_comment`, `pull_request_review`, `schedule`, `workflow_dispatch`, `workflow_run`, `merge_group` | The same, from g1t's own pushes, pull requests, issues, comments and [merge queue](/guides/merge-queue/). |
| `jobs`, `needs`, `if`, `outputs`, `env`, `defaults`, `timeout-minutes`, `continue-on-error` | The same. |
| `strategy.matrix` with `include` and `exclude`, `fail-fast`, `max-parallel`, a matrix from `fromJSON(needs.…)` | The same. |
| `concurrency` with `cancel-in-progress` | The same. |
| `${{ }}` expressions: every operator, function and context | The same, including `hashFiles`, `success()`, `failure()`, `always()` and `cancelled()`. |
| `run:` with `bash`, `sh`, `python` or a custom shell | The same. |
| JavaScript actions (`uses: owner/repo@v7`) | Fetched from GitHub and run as they are, on Node 24, the runtime current actions declare. |
| Composite actions | The same. |
| Reusable workflows in the repository (`jobs.<id>.uses: ./.g1t/workflows/build.yml`) | The same: `with:` inputs, `on.workflow_call` outputs, and nesting up to four deep. `./.github/workflows/…` finds the workflow under `.g1t/` after the move. Their jobs read the repository's secrets and variables. |
| `actions/checkout` | Checks out from g1t, with `ref`, `fetch-depth`, `path`, `repository`, `token` and `submodules`. |
| `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY` | The same. |
| `::error::`, `::warning::`, `::notice::`, `::group::`, `::add-mask::` | The same: errors and warnings become annotations on the run. |
| `secrets.*`, `vars.*`, `secrets.GITHUB_TOKEN` | The same. `secrets.G1T_TOKEN` is the workspace's own token for the run; `GITHUB_TOKEN` is its alias. |
| `environment:` on a job | The job reads each key's row for that environment, as GitHub's environment secrets work, and the run records a [deployment](/guides/deployments-api/#deployments-from-g1t-actions) to it. `url` gives the deployment its address; `deployment: false` reads the environment's values without making one. |
| `actions/upload-artifact`, `actions/download-artifact` | Kept with the run for 14 days, passed between its jobs, and downloadable from the run's page. Up to 60 MB each. |
| `actions/cache`, `actions/cache/restore`, `actions/cache/save` | Kept per repository, found by `key` or the newest under a `restore-keys` prefix. `path` takes globs and `!` exclusions. Up to 2 GiB each; see [the cache](#the-cache). |

The **Actions** page of a workflow says, under *How this runs on g1t*,
anything in it that runs differently.

### Not yet

- **Windows and macOS on g1t's machines.** g1t's own runners are Linux; a
  job with `runs-on: windows-latest` or `macos-latest` fails, and says so.
  [Self-hosted runners](/guides/self-hosted-runners/) of any OS run them:
  `runs-on: [self-hosted, windows]`.
- **Docker** container actions, `services:` containers and `container:` on
  g1t's machines. A job's `container:` is ignored there and its steps run on
  g1t's image; a [self-hosted runner](/guides/self-hosted-runners/#what-a-job-gets)
  that runs jobs in Docker uses it.
- **Reusable workflows from other repositories** (`uses: owner/repo/.github/workflows/x.yml@v1`); ones in the same repository work.
- **The toolkit's own cache.** Actions that cache through GitHub's service
  themselves, such as `actions/setup-node` with `cache: npm`, run without
  it. Use `actions/cache` for the same effect.
- **Environments' protection rules** (required reviewers, wait timers,
  branch limits). A job with `environment:` gets that environment's
  [values](/guides/secrets-and-variables/#a-value-per-environment), and runs
  without waiting. It still records a
  [deployment](/guides/deployments-api/#deployments-from-g1t-actions)
  unless it says `deployment: false`.

Why each of these is missing, and what to use instead, is on
[What g1t can't do yet](/about/limitations/#actions-and-runners).

## The runner

Jobs run in a fresh sandbox each: Debian with Node 24, Python 3, Go, Rust,
`build-essential`, `git`, `curl`, `jq` and passwordless `sudo`, in GitHub's
layout (`/home/runner/work`, `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`).
`runner.os` is `Linux`. `ubuntu-latest`, `ubuntu-24.04` and other Linux
labels all run here. A job whose `runs-on` names `self-hosted` waits for one
of your [self-hosted runners](/guides/self-hosted-runners/) instead. Setup actions such as
`actions/setup-node` and `actions/setup-python` install other versions as
they do on GitHub.

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
and the toolchains' download sites (`nodejs.org`, `go.dev`,
`static.rust-lang.org`). A request anywhere else gets `403` with
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

## The cache

`actions/cache` keeps what a job saves for the repository's later jobs:

| | |
| --- | --- |
| One entry | Up to 2 GiB, compressed. A larger one is not saved, and the job goes on. |
| A repository's entries | Up to 10 GiB together. Saving past it removes the entries restored longest ago. |
| How long | Until it has not been restored for 7 days, and at most 28 days after it was saved. |
| Keys | Written once: saving under a key that exists does nothing. A restore finds its `key` exactly, else the newest entry whose key starts with one of its `restore-keys`. |
| `path` | Files and folders; globs, `**` included; `~/` is the home folder; a line starting with `!` leaves matching paths out. |
| Compression | zstd. |

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
how long it took. A workspace on the plan pays for what its caches hold
(`Actions cache storage` on its statement), at R2's price plus the margin;
see [usage and billing](/guides/usage-and-billing/#actions-cache).

## Runs and logs

Open a repository's **Actions** page, in its sidebar. Pick a workflow to
see its runs, run it by hand if it has `workflow_dispatch`, or turn it off
without touching its file.

A run's page shows its jobs, each job's steps, and their logs as they are
written. Groups fold, errors and warnings are marked, and secrets are
replaced with `***`. **Cancel**, **Re-run all jobs** and **Re-run failed
jobs** do what they say.

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
`CI / pull_request` (the workflow's name and the event).

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

Every trusted job also gets `${{ secrets.G1T_TOKEN }}`, the workspace's own
token for the run, with `GITHUB_TOKEN` as its alias. A pull request's runs
get secrets and the token only when its author has the Write
[role](/guides/access-and-roles/) or higher on the repository, a member or
an outside collaborator, or is g1t working on its own. For a pull request
g1t made, its author is g1t and the person who asked for it is the one
whose role counts. Anyone else's, such as one
from a fork or by someone with Read or Triage, runs without secrets and
with an empty token. See
[who gets secrets](/guides/secrets-and-variables/#who-gets-secrets).

## Who may run workflows

What you can do with a repository's workflows follows your
[role](/guides/access-and-roles/) on it:

| | Needs |
| --- | --- |
| See workflows, runs and their logs | Read: on a public repository, anyone |
| Run a workflow by hand, cancel or re-run a run | Write |
| Enable or disable a workflow | Maintain |
| The repository's secrets and variables, seeing them included | Admin |

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

