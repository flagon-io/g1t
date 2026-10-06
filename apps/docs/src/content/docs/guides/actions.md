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
| `environment:` on a job | The job reads each key's row for that environment, as GitHub's environment secrets work. |
| `actions/upload-artifact`, `actions/download-artifact` | Kept with the run for 14 days, passed between its jobs, and downloadable from the run's page. Up to 60 MB each. |
| `actions/cache`, `actions/cache/restore`, `actions/cache/save` | Kept per repository for 7 days, found by `key` or the newest under a `restore-keys` prefix. Up to 60 MB each. |

The **Actions** page of a workflow says, under *How this runs on g1t*,
anything in it that runs differently.

### Not yet

- **Windows and macOS runners.** Jobs run on Linux; a job with
  `runs-on: windows-latest` or `macos-latest` fails, and says so.
- **Docker** container actions, `services:` containers and `container:`.
- **Reusable workflows from other repositories** (`uses: owner/repo/.github/workflows/x.yml@v1`); ones in the same repository work.
- **The toolkit's own cache.** Actions that cache through GitHub's service
  themselves, such as `actions/setup-node` with `cache: npm`, run without
  it. Use `actions/cache` for the same effect.
- **Environments' protection rules** (required reviewers, wait timers,
  branch limits). A job with `environment:` gets that environment's
  [values](/guides/secrets-and-variables/#a-value-per-environment), and runs
  without waiting.

## The runner

Jobs run in a fresh sandbox each: Debian with Node 24, Python 3, Go, Rust,
`build-essential`, `git`, `curl`, `jq` and passwordless `sudo`, in GitHub's
layout (`/home/runner/work`, `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`).
`runner.os` is `Linux`. `ubuntu-latest`, `ubuntu-24.04`, `self-hosted` and
other Linux labels all run here. Setup actions such as
`actions/setup-node` and `actions/setup-python` install other versions as
they do on GitHub.

A job runs for at most 60 minutes, whatever its `timeout-minutes`, and
for less if the workspace's plan caps runs lower (a new workspace's first
month, or the trial). A job stopped at its time cap fails saying so.

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

g1t does not run cryptocurrency miners: a step that names one (`xmrig`,
a `stratum+tcp://` pool, `--donate-level`) is not run, and a job that
looks like it is mining is stopped. See
[abuse and mining](/guides/guardrails/#abuse-and-mining).

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
a commit is pushed to it, and, for one a g1t agent makes, when the agent
marks it ready, which on g1t is when it first has code. Each head runs
each workflow once.

A run on a pull request's latest commit is a check on it:

- While a workflow runs, the pull request waits for it before merging.
- When one fails, merging is refused, as for failed acceptance checks.
  Where the repository allows ignoring checks, anyone who can merge can
  merge anyway.
- In a repository that merges through the [merge queue](/guides/merge-queue/),
  workflows with `on: merge_group` run on each combined state the queue
  builds, as on GitHub, and the state lands only if they pass.
- A pull request a **g1t agent** is working on goes back to the agent
  when a workflow fails. The agent reads the run and its logs with the
  same tools you have, fixes the cause, and pushes; the workflows run
  again.

## Secrets and variables

Secrets are read as `${{ secrets.KEY }}` and config as `${{ vars.KEY }}`,
from the rows under **Settings → Secrets and variables** that are
available to Workflows. A job with `environment: production` reads each
key's Production row; other jobs read the rows for all environments. See
[Secrets and variables](/guides/secrets-and-variables/) for how rows,
environments and the workspace's rows work.

Every trusted job also gets `${{ secrets.G1T_TOKEN }}`, the workspace's own
token for the run, with `GITHUB_TOKEN` as its alias. A pull request's runs
get secrets and the token only when its author has the Write
[role](/guides/access-and-roles/) or higher on the repository, a member or
an outside collaborator, or is g1t's agent. Anyone else's, such as one
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
[the trial](/guides/usage-and-billing/#the-trial). On a public repository,
[g1t's open-source pool](/guides/usage-and-billing/#the-open-source-pool)
runs them too, after a card check, until the month's pool is spent.

Before each job starts, g1t reserves what it may cost (its time limit at
the sandbox price) with billing, and settles what it really cost when it
ends; each job's sandbox is charged as
[sandbox time](/guides/usage-and-billing/#sandbox-time), from the first
second. A job billing refuses does not start: it is recorded as failed
with "Not started:" and the reason, such as "Workflows run in g1t's
sandboxes, which need a paid workspace", and what to do about it. The
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
| `list_actions_secrets`, `set_actions_secret`, `delete_actions_secret` | `GET`, `PUT` and `DELETE /repos/{owner}/{repo}/actions/secrets/{name}` |
| `list_actions_variables`, `set_actions_variable`, `delete_actions_variable` | `GET` and `POST /repos/{owner}/{repo}/actions/variables`, `PATCH` and `DELETE …/variables/{name}` |

Workspace secrets and variables are under
`/workspaces/{workspace}/actions/secrets` and `…/variables`. The fields
g1t adds (environments, who reads a row, linked repositories) are in
[Secrets and variables](/guides/secrets-and-variables/#from-the-api).

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/actions/workflows/ci.yml/dispatches \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref": "main", "inputs": {"environment": "staging"}}'
```

