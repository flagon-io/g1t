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
| `on:` `push` (branches, tags, paths), `pull_request`, `pull_request_target`, `issues`, `issue_comment`, `pull_request_review`, `schedule`, `workflow_dispatch`, `workflow_run` | The same, from g1t's own pushes, pull requests, issues and comments. |
| `jobs`, `needs`, `if`, `outputs`, `env`, `defaults`, `timeout-minutes`, `continue-on-error` | The same. |
| `strategy.matrix` with `include` and `exclude`, `fail-fast`, `max-parallel`, a matrix from `fromJSON(needs.…)` | The same. |
| `concurrency` with `cancel-in-progress` | The same. |
| `${{ }}` expressions: every operator, function and context | The same, including `hashFiles`, `success()`, `failure()`, `always()` and `cancelled()`. |
| `run:` with `bash`, `sh`, `python` or a custom shell | The same. |
| JavaScript actions (`uses: owner/repo@v7`) | Fetched from GitHub and run as they are, on Node 24, the runtime current actions declare. |
| Composite actions | The same. |
| `actions/checkout` | Checks out from g1t, with `ref`, `fetch-depth`, `path`, `repository`, `token` and `submodules`. |
| `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY` | The same. |
| `::error::`, `::warning::`, `::notice::`, `::group::`, `::add-mask::` | The same: errors and warnings become annotations on the run. |
| `secrets.*`, `vars.*`, `secrets.GITHUB_TOKEN` | The same; `GITHUB_TOKEN` is a token for g1t. |
| `actions/upload-artifact`, `actions/download-artifact` | Kept with the run for 14 days, passed between its jobs, and downloadable from the run's page. Up to 60 MB each. |
| `actions/cache`, `actions/cache/restore`, `actions/cache/save` | Kept per repository for 7 days, found by `key` or the newest under a `restore-keys` prefix. Up to 60 MB each. |

The **Actions** page of a workflow says, under *How this runs on g1t*,
anything in it that runs differently.

### Not yet

- **Windows and macOS runners.** Jobs run on Linux; a job with
  `runs-on: windows-latest` or `macos-latest` fails, and says so.
- **Docker** container actions, `services:` containers and `container:`.
- **Reusable workflows** (`uses:` on a job).
- **The toolkit's own cache.** Actions that cache through GitHub's service
  themselves, such as `actions/setup-node` with `cache: npm`, run without
  it. Use `actions/cache` for the same effect.
- **Environments' protection rules**. A job with `environment:` runs with
  the repository's secrets.

## The runner

Jobs run in a fresh sandbox each: Debian with Node 24, Python 3, Go, Rust,
`build-essential`, `git`, `curl`, `jq` and passwordless `sudo`, in GitHub's
layout (`/home/runner/work`, `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`).
`runner.os` is `Linux`. `ubuntu-latest`, `ubuntu-24.04`, `self-hosted` and
other Linux labels all run here. Setup actions such as
`actions/setup-node` and `actions/setup-python` install other versions as
they do on GitHub.

A job runs for at most 60 minutes, whatever its `timeout-minutes`.

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
  Where the repository allows ignoring checks, a member can merge anyway.
- A pull request a **g1t agent** is working on goes back to the agent
  when a workflow fails. The agent reads the run and its logs with the
  same tools you have, fixes the cause, and pushes; the workflows run
  again.

## Secrets and variables

Secrets are read as `${{ secrets.NAME }}` and variables as
`${{ vars.NAME }}`. Set them under **Settings → Secrets and variables**:

- a repository's, which its members manage;
- a workspace's, which owners manage and every repository reads. A
  repository's own of the same name wins.

Secret values are sealed when saved and never shown again. Pull requests
from people outside the workspace run without secrets, and with a
`GITHUB_TOKEN` that cannot write.

## Who may run workflows

Workflows run in every workspace that uses g1t's agents: one with its own
[model provider](/guides/models/) connected, or one g1t has opened its
hosted models to. They are free while g1t is being built out. Elsewhere a
run is recorded with its jobs failed and the reason.

## From the API

The routes are GitHub's, so scripts written for GitHub's API mostly work
with `https://api.g1t.sh` in place of `https://api.github.com`.

| Tool | Route |
| --- | --- |
| `list_workflows` | `GET /repos/{owner}/{repo}/actions/workflows` |
| `list_workflow_runs` | `GET /repos/{owner}/{repo}/actions/runs`, with `workflow`, `branch`, `event`, `pull`, `head_sha` |
| `get_workflow_run` | `GET /repos/{owner}/{repo}/actions/runs/{id}` |
| `get_job_logs` | `GET /repos/{owner}/{repo}/actions/jobs/{job}/logs?after=` |
| `dispatch_workflow` | `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` with `ref` and `inputs` |
| `cancel_workflow_run` | `POST /repos/{owner}/{repo}/actions/runs/{id}/cancel` |
| `rerun_workflow_run` | `POST …/runs/{id}/rerun`, or `…/rerun-failed-jobs` |
| `update_workflow` | `PUT …/workflows/{workflow}/enable` and `…/disable` |
| `list_actions_secrets`, `set_actions_secret`, `delete_actions_secret` | `GET`, `PUT` and `DELETE /repos/{owner}/{repo}/actions/secrets/{name}` |
| `list_actions_variables`, `set_actions_variable`, `delete_actions_variable` | `GET` and `POST /repos/{owner}/{repo}/actions/variables`, `PATCH` and `DELETE …/variables/{name}` |

Workspace secrets and variables are under
`/workspaces/{workspace}/actions/secrets` and `…/variables`. Unlike
GitHub's, a secret is sent as plain `value` over HTTPS, not encrypted to a
public key.

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/actions/workflows/ci.yml/dispatches \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref": "main", "inputs": {"environment": "staging"}}'
```

## Automations

Workflows run code. For rules that act on g1t itself, such as labelling an
issue, putting an agent on it, or posting to chat, without a runner, see
[Automations](/guides/automations/), which live beside workflows in
`.g1t/automations/`.
