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

Otherwise g1t doesn't read `.github`, so a repository that lives in both
places can keep `.github` for GitHub and `.g1t` for g1t, side by side.

### On a mirror

A [mirror](/guides/mirroring/) of a GitHub repository runs nothing while it
stands by: its workflows run on GitHub. Its owners can change that:

- **CI failover** runs its workflows on g1t for each push copied in from
  GitHub, `.github/workflows` as well as `.g1t/workflows`. Use it when
  GitHub's workflows aren't running.
- **Taking over** runs them for everything pushed to g1t, until it's handed
  back.
- **Keep CI warm** runs `.g1t/workflows`, and only those, on each push
  copied in while it stands by.

When both folders have a workflow of the same `name:`, the one in `.g1t`
runs. A workflow that deploys (any job names an `environment:`) waits for
approval during CI failover and takeovers, so it doesn't deploy from two
places, unless the mirror's settings say otherwise. A push copied in from
GitHub that changes workflows or local actions waits for approval before
it can use the repository's secrets.

Whenever g1t runs a mirror's workflows, their results show on the commit on
GitHub too, as commit statuses named `g1t / <workflow> / <event>`, such as
`g1t / CI / push`. This needs the Commit statuses permission on g1t's GitHub
App; turn it off with **Report checks to GitHub** in the mirror's settings.
See [Checks on GitHub](/guides/mirroring/#checks-on-github).

Then add your [secrets and variables](#secrets-and-variables): GitHub never
gives their values out, so they cannot be copied across.

## What runs

| On GitHub | On g1t |
| --- | --- |
| `on:` `push` (branches, tags, paths), `pull_request`, `pull_request_target`, `issues`, `issue_comment`, `pull_request_review`, `schedule`, `workflow_dispatch`, `workflow_run`, `merge_group`, `create`, `delete`, `repository_dispatch`, `release`, `deployment`, `deployment_status` | The same, from g1t's own pushes, pull requests, issues, comments, [releases](#releases), [deployments](#deployments) and [merge queue](/guides/merge-queue/). `create` starts on each new branch or tag, at its commit; `delete` on each branch or tag a push deletes, on the default branch's latest commit, with `github.event.ref` and `github.event.ref_type` naming what went. As on GitHub, neither takes `branches` or `tags` filters: a workflow on them runs for every branch and tag. `repository_dispatch` starts on [a dispatch event](#repository-dispatch). |
| `jobs`, `needs`, `if`, `outputs`, `env`, `defaults`, `timeout-minutes`, `continue-on-error` | The same. |
| `timeout-minutes` and `continue-on-error` on a step | The same, for `run:` and `uses:` steps alike. A `uses:` step's action is stopped at its limit, with every process it started; a step inside a composite action stops at its own limit or the `uses:` step's, whichever comes first. A step stopped this way fails, unless `continue-on-error` lets the job go on. |
| `strategy.matrix` with `include` and `exclude`, `fail-fast`, `max-parallel`, a matrix from `fromJSON(needs.…)` | The same. |
| `concurrency` with `cancel-in-progress`, for the workflow or for one job | The same: one run, or one job, of a group at a time. |
| `permissions:` for the workflow or for one job, `read-all`, `write-all` | The same: they decide what [the job's token](#the-jobs-token) may do. |
| `${{ }}` expressions: every operator, function and context | The same, including `hashFiles`, and `success()`, `failure()`, `always()` and `cancelled()` in `if:` (anywhere else they are an error, as on GitHub). |
| `run:` with `bash`, `sh`, `python`, `pwsh` or a custom shell | The same, with GitHub's file for each: `.sh` for `bash` and `sh`, `.py` for `python`, `.ps1` for PowerShell (stopping at the first error, and exiting with the last program's code), `.cmd` for `cmd`, and no extension for another program. `python` runs `python`, or `python3` on a machine without it. |
| JavaScript actions (`uses: owner/repo@v7`, `owner/repo/path@v7`) | Fetched from that repository on g1t when g1t has it and your repository may use it, otherwise from GitHub, and run as they are, on Node 24, the runtime current actions declare. An action that declares `node20` runs on Node 20 where the machine has one. See [actions and workflows from other repositories](#actions-and-workflows-from-other-repositories) and [an action's pre and post](#an-actions-pre-and-post). |
| Composite actions | The same. |
| Reusable workflows (`jobs.<id>.uses: ./.g1t/workflows/build.yml`, or `owner/repo/.g1t/workflows/build.yml@v1` in another repository) | The same: `with:` inputs checked against their `type`, `secrets:` by name or `secrets: inherit`, `on.workflow_call` outputs, `strategy.matrix` on the calling job (one call for each combination), `concurrency` on the calling job, and up to ten levels of workflows with at most 50 different reusable workflows in a run. `.github/workflows/…` finds the workflow under `.g1t/` after the move. See [actions and workflows from other repositories](#actions-and-workflows-from-other-repositories). |
| `actions/checkout` | The action itself, at the version the step names, fetching from g1t with the job's token: every input and output, its post step that removes the credential, and a pull request's [test merge commit](#what-a-pull-requests-run-builds), which g1t keeps in the repository. In a job container without git it downloads the commit as a tarball from [`GET /repos/{owner}/{repo}/tarball/{ref}`](/reference/api/repositories/download-tarball-archive/), as on GitHub, up to 10,000 files and 24 MB. `lfs` finds no Git LFS files: g1t keeps none. |
| `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY` | The same. Step summaries show on the run's page; see [job summaries](#job-summaries). |
| `::error::`, `::warning::`, `::notice::`, `::group::`, `::add-mask::`, `::echo::on` | The same: errors and warnings become annotations on the run, with their `file`, `line`, `col`, `endLine` and `endColumn`, and [masked](#masking-secrets) values stay hidden. |
| Problem matchers (`::add-matcher::`, `::remove-matcher::`) | The same, so `actions/setup-node`, `setup-go` and `setup-python` turn compiler and linter output into annotations. See [problem matchers](#problem-matchers). |
| `secrets.*`, `vars.*`, `secrets.GITHUB_TOKEN` | The same. `secrets.G1T_TOKEN` is [the job's own token](#the-jobs-token); `GITHUB_TOKEN` is its alias. |
| `environment:` on a job | The job waits for the environment's [protection rules](#environments), then reads each key's row for that environment, as environment secrets work, and the run records a [deployment](/guides/deployments-api/#deployments-from-g1t-actions) to it. `url` gives the deployment its address; `deployment: false` reads the environment's values without making one. The name may be an expression. |
| `actions/upload-artifact`, `actions/download-artifact`, `actions/upload-artifact/merge` | The same inputs and outputs as version 4: `retention-days`, `overwrite`, `compression-level`, `include-hidden-files`, `!` exclusions, download by `pattern` with `merge-multiple`, and from another run with `run-id` and `github-token`. Up to 5 GiB each; see [artifacts](#artifacts). |
| `actions/cache`, `actions/cache/restore`, `actions/cache/save` | The actions themselves, at the version the step names, saving to and restoring from the repository's cache: kept per repository and branch, found by `key` or the newest under a `restore-keys` prefix. Up to 2 GiB each; see [the cache](#the-cache). |
| Actions that cache through the toolkit, such as `actions/setup-node` with `cache: npm` or `Swatinem/rust-cache` | The same: they save to and restore from the repository's cache. See [actions built on the toolkit](#actions-built-on-the-toolkit). |
| sccache with `SCCACHE_GHA_ENABLED` | The same: its entries go to the repository's cache. See [caching Rust builds](#caching-rust-builds). |
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
- **Actions that upload artifacts with the toolkit's artifact library
  themselves.** The library refuses to run against any server but
  github.com. `actions/upload-artifact`, `actions/download-artifact` and
  `actions/upload-artifact/merge` work, because g1t runs them itself. See
  [actions built on the toolkit](#actions-built-on-the-toolkit).
- **`on: label`, and some activity types.** Creating, editing or deleting
  a label starts no workflows yet, and the workflow's page says so. Nor do
  the `pull_request` types `unassigned`, `locked` and `unlocked`, `edited`
  for a new title or description, or the `issues` types `unassigned`,
  `locked`, `unlocked`, `pinned` and `unpinned`.
- **Background steps.** A step with `background: true`, or a `wait`,
  `wait-all`, `cancel` or `parallel` step, is refused: g1t does not run
  them yet.
- **`timezone` on a schedule, `concurrency.queue`, `cancel-timeout-minutes`
  and `snapshot`.** The workflow runs without them, and its page says so:
  a schedule runs in UTC, a group keeps one run waiting, a cancelled job
  stops in its usual time, and no runner image is made.

Why each of these is missing, and what to use instead, is on
[What g1t can't do yet](/about/limitations/#actions-and-runners).

## Skipping a run

A commit can ask not to start the `push` and `pull_request` workflows it
would, as on GitHub: put `[skip ci]`, `[ci skip]`, `[no ci]`,
`[skip actions]` or `[actions skip]` anywhere in its message, or end the
message with a `skip-checks: true` trailer. For a push, the message read
is the pushed head's; for a pull request, its head commit's. Other
events, such as `pull_request_target`, `workflow_dispatch` and
`schedule`, still start their workflows.

```sh
git commit -m "Fix a typo in the README [skip ci]"
```

A required check that a skipped workflow would have reported stays
pending, so a pull request whose merge needs it waits for a push that
runs it.

## How g1t checks a workflow

g1t reads a workflow as GitHub does, from GitHub's own schema for workflow
files, so a workflow GitHub refuses is refused on g1t too, and one GitHub
runs reads on g1t. When a workflow can't be read, its page says what is
wrong, with the job and step, and no run starts from it.

| You write | g1t says |
| --- | --- |
| A key GitHub doesn't have, at any level, such as `runs_on:` or `with:` on a `run:` step | It is unexpected, and lists the keys that place can have. |
| A job without `runs-on` | The job has no `runs-on`. A job that calls a reusable workflow with `uses:` has no `runs-on` or `steps`. |
| A job id that doesn't start with a letter or `_`, has characters other than letters, digits, `-` and `_`, or starts with `__` | It is not a job id GitHub accepts. Step ids follow the same rule. Two jobs, or two steps of a job, whose ids differ only in case are the same id. |
| An event GitHub doesn't have, or a filter the event doesn't take, such as `types` on `push` | GitHub has no such event, or the event doesn't take that key. `branches` and `branches-ignore` (and `tags`, `paths`) can't both be on one event. |
| A YAML merge key (`<<: *defaults`) | GitHub doesn't read merge keys. Anchors and aliases (`&steps` and `*steps`) work, as on GitHub, for a whole value. |
| A `permissions` name GitHub's token doesn't have, such as `metadata` | It is unexpected. A name GitHub has that g1t has nothing behind yet reads, and grants nothing. |

### g1t's own settings

A `g1t:` mapping can go at the top of a workflow, on a job and on a step.
GitHub refuses a workflow with `g1t:` in it, so use it only in
`.g1t/workflows`. It follows two rules:

- It only adds to a workflow. It never changes what a GitHub key means.
- Each setting in it has a GitHub equivalent, written here, so that a
  workflow can be moved back to GitHub without it.

| Setting | Where | What it does | On GitHub |
| --- | --- | --- | --- |
| `deployment: false` | A job | The job reads its `environment:` values without the run recording a deployment. | `environment: { name: ..., deployment: false }` |

g1t keeps any other key under `g1t:` as written, and does nothing with it
yet.

## Managed workflows

Some workflows run in a repository without a file in it: g1t installs
them for a feature you turn on, such as a project's
[build with a workflow](/guides/deployments/#build-with-a-workflow). A
managed workflow runs like any other: on the **Actions** page, with its
runs, logs, re-runs and checks, on g1t's machines or your
[self-hosted runners](/guides/self-hosted-runners/). Its page says it is
managed by g1t.

A workflow of the same `name:` in `.g1t/workflows/` runs in its place, so
to change one, commit your own version of it.

## Workflows a workspace manages

A workspace's owners can run a workflow in the workspace's repositories
without committing it to each one, as GitHub's required workflows do. It
runs in each repository it targets as that repository's own workflow: on
the repository's events, with the repository's job token, secrets and
variables, and reporting the repository's checks. Its path is
`managed/<name>.yml`, and the repository's **Actions** page lists it as
managed by the workspace, with the file it came from.

To add one:

1. Commit the workflow to one of the workspace's repositories, such as
   `acme/policies/.g1t/workflows/scan.yml`.
2. Open **Workspace → Code → Actions**, `g1t.sh/<workspace>/-/actions`, and
   under **Workflows this workspace manages** choose **Add workflow**.
3. Give it a name, its source as `owner/repo/path@ref` (for example
   `acme/policies/.g1t/workflows/scan.yml@main`), a mode, and the
   repositories it runs in, then choose **Add workflow**.

| Setting | Options |
| --- | --- |
| Mode | **Required**: it runs in every repository it targets. A workflow of the same `name:` in the repository does not run while it is required, and nobody in the repository can turn it off. **Default**: it runs where the repository has no workflow of the same `name:`, which runs in its place, and the repository's admins can turn it off on its Actions page. |
| Repositories | **All repositories**, or names and patterns, one per line: `*` matches any characters, and `!name` leaves out what an earlier line took in. The last line that matches decides, without regard to case; only `!` lines means every repository but those. |
| Visibility | Public and private repositories, public only, or private only. |

g1t copies the source file when you save, at the commit its ref names
then, and that copy runs until you copy it again with **Copy again** (or
save it with another source). So someone who can push to the source
repository cannot change what runs with every repository's secrets: only
an owner can, by copying it. The workflows list shows the commit each was
copied at.

- The source must be a workflow file in one of the workspace's own
  repositories.
- A source in a private repository runs in private repositories only, as a
  public repository's workflows cannot use a private repository's: choose
  **Private repositories only**, or g1t refuses it. A repository made
  public later stops running it.
- `uses: ./…` in the copy names the repository it runs in, as it would in a
  file committed there. To call a reusable workflow of the source
  repository, name it in full:
  `uses: acme/policies/.g1t/workflows/build.yml@main`, which follows the
  [rules for other repositories](#actions-and-workflows-from-other-repositories).
- A required workflow runs for pull requests from forks and in the
  [merge queue](/guides/merge-queue/) too, whatever the fork's files say.
- When it changes, up to 20 repositories' workflow lists are brought up to
  date at once. In a larger workspace the rest follow within minutes, or
  as soon as someone opens their Actions page; their runs read the
  workflows as they are meanwhile.

To make a pull request wait for a required workflow, require its check in
a [ruleset](/guides/rules/): its `name:` as the context, with
`integration: actions`. A failure of the workflow fails the check whatever
else reports a check of that name.

Through the API and MCP:

| Route | MCP | |
| --- | --- | --- |
| [`GET /workspaces/{workspace}/actions/managed-workflows`](/reference/api/run-protection/list-workspace-managed-workflows/) | `workflow` `list_managed_workflows` | Each with its source, the commit it was copied at, its mode, repositories, visibility and the copy that runs. |
| [`POST /workspaces/{workspace}/actions/managed-workflows`](/reference/api/run-protection/create-workspace-managed-workflow/) | `workflow` `add_managed_workflow` | `name`, `source`, `mode` (`required` or `default`), `repositories`, `visibility` (`all`, `public` or `private`). |
| [`PATCH /workspaces/{workspace}/actions/managed-workflows/{workflow}`](/reference/api/run-protection/update-workspace-managed-workflow/) | `workflow` `update_managed_workflow` | Any of those; `refresh: true` copies the source again. |
| [`DELETE /workspaces/{workspace}/actions/managed-workflows/{workflow}`](/reference/api/run-protection/delete-workspace-managed-workflow/) | `workflow` `remove_managed_workflow` | Its runs stay. |

Only owners can see and change them; a token needs `workspace:read` to
list them and `workspace:admin` to change them.

## Schedules

A workflow with `on: schedule` runs on the default branch's latest commit,
at each time its cron lines name, in UTC:

```yaml
on:
  schedule:
    - cron: "0 9 * * mon"   # Mondays at 09:00 UTC
    - cron: "*/30 * * * *"  # every 30 minutes
```

Each line has five fields: minute, hour, day of month, month and day of
the week. A field takes `*`, a number, a range `1-5`, a list `1,15` and a
step `*/10`; days take `mon` to `sun`, and months `jan` to `dec`.

| Rule | What happens |
| --- | --- |
| Every 5 minutes at most | A schedule more frequent than every 5 minutes, such as `* * * * *` or `*/2 * * * *`, runs every 5 minutes instead, on the five-minute marks (:00, :05, :10 and so on), at each mark that ends five minutes in which it would have run. A mark outside the hours, days or months the schedule names never runs: `* 9 * * *` runs from 09:00 to 09:55. |
| No push for 60 days | Schedules pause in a repository that has had no push for 60 days. The next push to any branch resumes them. Other events and `workflow_dispatch` still start the workflow. |
| Actions not paid for | When a scheduled run's job could not start because the workspace's plan, spend limit or the open-source pool does not cover it, that run fails and says why, and the workflow's schedule waits an hour before it tries again. |
| Archived repository | Schedules wait until the repository is unarchived. |

## Actions and workflows from other repositories

A step's `uses: owner/repo@ref` (or `owner/repo/path@ref`) and a job's
`uses: owner/repo/.g1t/workflows/build.yml@ref` name another repository.
g1t looks for it on g1t first, but a name means what it means on GitHub
whenever GitHub has it:

| The repository | What happens |
| --- | --- |
| On g1t and public: in your workspace, under `g1t/` (g1t's own), or with a name GitHub has no public repository of | Your workflows use it, from any workspace. |
| On g1t, private, in your workspace, with **Access** set to *Accessible from repositories in* the workspace | Your private repositories' workflows use it. A job reads it with a read-only token for that repository alone, which ends with the job. |
| On g1t, private, and not shared that way | The step or job fails, and says why. A private repository's actions are never used by a public repository's workflows, whose logs anyone can read, nor from another workspace. |
| Under `g1t/`, and not one of g1t's own public repositories | The step or job fails, and says so. A `g1t/` name is never looked for on GitHub. |
| Not on g1t, or private in a workspace you cannot see | An action comes from GitHub, at the commit its ref names there (see [actions from GitHub](#actions-from-github)); a reusable workflow is read from a public repository on GitHub. |
| On g1t, public, in another workspace, with a name GitHub has a public repository of | GitHub's is used, as on GitHub: anyone can make a workspace, so a workspace called `actions` never answers for `actions/setup-node`. When g1t can't reach GitHub to tell, GitHub's is used too. |

An owner that is a [workspace alias](/guides/workspaces/#workspace-aliases)
is looked for under its workspace's slug, by the same rules, as if you had
written that slug: the alias decides where g1t looks, never who may use
what it finds.

`ref` is a branch, a tag or a commit. A reusable workflow may be under
`.g1t/workflows/` or `.github/workflows/`; a `.github/workflows/` path
also finds the file under `.g1t/workflows/` in a repository moved to
g1t. A `./.g1t/workflows/…` call inside a workflow from another
repository reads from that repository, at the same ref.

To share a private repository's actions and workflows with the rest of its
workspace, an admin chooses **Settings → Actions → Access → Accessible from
repositories in** the workspace, or calls
`PUT /repos/{owner}/{repo}/actions/permissions/access` with
`{"access_level": "organization"}` (`none` to stop).

### Actions from GitHub

g1t keeps the actions your workflows use from GitHub, so a job downloads
them from g1t rather than from GitHub:

1. Before the first step, the job downloads every action its steps name,
   as GitHub's runner does in **Set up job**, and fails there if one can't
   be had. Its log names each one's commit:
   `Download action repository 'actions/setup-node@v4' (SHA:…) from g1t`.
2. g1t reads which commit the ref (`v4`, a branch, or a commit) names on
   GitHub, a tag before a branch of the same name, and looks again at
   most every 5 minutes, so a tag that moves is followed within minutes.
3. The first job to use an action at a commit has g1t fetch that commit's
   archive from GitHub and keep it, which can take up to two minutes.
   While it waits, **Set up job** says so every 5 seconds
   (`Waiting for g1t to fetch 'actions/setup-node@v4' (10s)`). Every
   later job, in any workspace, downloads the same bytes from g1t.

While GitHub doesn't answer, a ref reads as the commit it last named, and
the job says so in a warning; an action g1t keeps still downloads. An
action whose archive is larger than 32 MB, or from a private repository
on GitHub, is downloaded from GitHub by the job itself. An archive no job
has used for 30 days is deleted, and fetched again when next used.
Kept archives are g1t's and count toward no workspace's storage.

Actions that a composite action uses are downloaded when it runs.

### g1t's own actions

g1t's own actions live under `g1t/` on g1t.sh, public, with a `v1` tag
that moves with each compatible release. `g1t` is a
[workspace alias](/guides/workspaces/#workspace-aliases) of `flagon-io`,
the workspace of Flagon, Inc., which builds g1t: `g1t/deploy@v1` is the
repository `flagon-io/deploy`, and its page and the job's log name it
that way. Write `g1t/`; it keeps working wherever g1t's actions are kept.

| Action | What it does |
| --- | --- |
| [`g1t/deploy@v1`](https://g1t.sh/g1t/deploy) | Builds the checkout and puts it on [g1t.page](/guides/deployments/): production from the project's production branch, a preview from a pull request or another branch. The job needs `deployments: write`. See [deploying from a workflow](/guides/deployments/#deploying-from-a-workflow). |
| [`g1t/detect@v1`](https://g1t.sh/g1t/detect) | Says what that build would find (`kind`, `install`, `build`, `output-dir`, `framework`) without building anything. |

g1t's reusable workflows are in `g1t/workflows` the same way, such as
`g1t/workflows/.g1t/workflows/deploy.yml@v1`, which a
[project's](/guides/projects/) deployments run.

A `g1t/` name always means g1t's own: it answers even where GitHub has a
repository of the same name, only its public repositories answer for it,
and a `g1t/` name that is not one of them fails rather than being looked
for on GitHub.

Both actions are composite actions around `g1t-runner`, which g1t's machines
have; on a [self-hosted runner](/guides/self-hosted-runners/) they use
the one on `PATH` or download the newest release.

### Secrets for a called workflow

A called workflow gets only the secrets its caller passes, plus
`G1T_TOKEN` (`GITHUB_TOKEN`):

```yaml
jobs:
  build:
    uses: acme/shared/.g1t/workflows/build.yml@v2
    with:
      node-version: 24
    secrets:
      npm-token: ${{ secrets.NPM_TOKEN }}

  deploy:
    uses: ./.g1t/workflows/deploy.yml
    secrets: inherit
```

- `secrets:` with names passes each as the called workflow names it,
  read from the caller's `secrets`, `needs`, `inputs`, `matrix`,
  `github` and `vars`.
- `secrets: inherit` passes every secret the caller has.
- A job in the called workflow with its own `environment:` also reads that
  environment's secrets, over what was passed.
- A secret the called workflow marks `required: true` under
  `on.workflow_call.secrets` that the caller does not pass fails the
  calling job before anything runs.

`vars` are the calling repository's, and a called workflow's jobs run
with the calling run's `github` context: `actions/checkout` checks out the
calling repository.

A secret passed by name that the called workflow does not declare under
`on.workflow_call.secrets` fails the calling job: `Invalid secret: … is
not defined in …`.

### Inputs for a called workflow

The values under `with:` are checked against the `type` each input has
under `on.workflow_call.inputs`, before anything runs:

- A `boolean` input takes `true` or `false`, and a `number` input a
  number. Text such as `'true'` or a job's output (outputs are always
  text) fails the calling job: pass `${{ fromJSON(needs.build.outputs.count) }}`
  to give its value.
- A `string` input takes text; a number or a boolean becomes its text.
- An input you leave out takes its `default`, else `false`, `0` or `''`
  by its type. A `required: true` input you leave out fails the calling
  job.
- A name under `with:` that the called workflow does not declare fails the
  calling job: `Invalid input: … is not defined in …`.

### A matrix of calls

A job that calls a reusable workflow may have a `strategy`. Each
combination of its matrix calls the workflow once, with `matrix` read in
`with:` and `secrets:`:

```yaml
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
      max-parallel: 1
    uses: ./.g1t/workflows/test.yml
    with:
      node-version: ${{ matrix.node }}
```

The called workflow's jobs are named under the combination's call:
`test (20) / unit`, `test (22) / unit`. `max-parallel` limits how many
calls run at a time, and with `fail-fast` (the default) a call that fails
cancels the calls still running or waiting. `concurrency` on the calling
job holds its group while the called workflow runs, as a job's own does.

A run connects at most ten levels of workflows: the workflow it started
from and nine levels of reusable workflows below it. It calls at most 50
different reusable workflows; a workflow called again, as by each
combination of a matrix, counts once. A call past either limit fails the
calling job and says why.

## Releases

Workflows with `on: release` start when a release changes, at the commit
its tag names (`GITHUB_REF` is `refs/tags/<tag>`). Each change is one or
more activity types, which `types:` chooses among:

| Change | Activity types |
| --- | --- |
| A draft made | `created` |
| A release made and published | `created`, `published`, and `released` (or `prereleased` for a prerelease) |
| A draft published | `published`, and `released` or `prereleased` |
| A prerelease made a full release | `edited` and `released` |
| Made a draft again | `unpublished` |
| Title, notes or prerelease changed | `edited`, with `github.event.changes` holding the old title and notes |
| Deleted (the tag stays) | `deleted` |

```yaml
on:
  release:
    types: [published]
```

`github.event.release` has `tag_name`, `name`, `body`, `draft`,
`prerelease`, `target_commitish`, `author` and `html_url`. A release a
job's own token makes or changes starts no workflows.

## Deployments

`on: deployment` starts when a deployment is made, and
`on: deployment_status` when one has a new status: one reported through
the [deployments API](/guides/deployments-api/) or a
[g1t.page](/guides/deployments/) build. The run is at the commit deployed;
`GITHUB_REF` is the branch or tag deployed, and empty for a bare commit.

```yaml
on: deployment_status

jobs:
  smoke:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS "${{ github.event.deployment_status.environment_url }}"
```

`github.event.deployment` has `environment`, `ref`, `sha`, `task` and
`payload`; `github.event.deployment_status` has `state`, `environment_url`
and `log_url`. Deployments a workflow makes, with `environment:` or with
its job's token, start no workflows, so a workflow cannot set itself off.

## The runner

Jobs run in a fresh sandbox each: Debian with Node 24, Python 3, Go, Rust,
Java 21, .NET 8, Ruby 3.3, `build-essential`, `git`, `curl`, `jq`, Docker
(with Buildx and Compose) and passwordless `sudo`, in GitHub's layout
(`/home/runner/work`, `RUNNER_WORKSPACE`, `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`).
`runner.os` is `Linux`. Each step's `GITHUB_ACTION` is its `id`, or
GitHub's name for it: `__run`, `__run_2` and on for `run:` steps,
`__actions_checkout` for `uses: actions/checkout`. `ImageOS` and
`ImageVersion` are set when the machine's image sets them. `ubuntu-latest`, `ubuntu-24.04` and other Linux
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
`timeout-minutes`, and the workflow's page warns about a job that asks
for more. One on a self-hosted runner runs for 360 minutes when it names
no `timeout-minutes`, as on GitHub, and can ask for up to 24 hours. A job
stopped at its time cap fails saying so.

g1t's machines are x64. A job whose `runs-on` names an Arm label, such
as `ubuntu-24.04-arm`, runs on x64, and the workflow's page says so; a
self-hosted Arm runner runs it on Arm.

### What a job can reach

A job's network is restricted by its project's
[guardrails](/guides/guardrails/): it reaches the hosts its project's
guardrails allow, g1t itself, and what builds need, and nothing else.
What builds need is the package registries (npm, PyPI, crates.io, the Go
proxy, RubyGems, Packagist, NuGet, Maven and Gradle, Debian's mirrors),
GitHub, where `uses:` actions and the setup actions' downloads come from,
the toolchains' download sites (`nodejs.org`, `go.dev`,
`static.rust-lang.org`), and the public container registries (Docker Hub,
GitHub's, Quay, and `mirror.gcr.io`, the mirror of Docker Hub that a job's
Engine asks first). A request anywhere else gets `403`, and its status
line names the host (`403 Forbidden by g1t guardrails: example.com is not
an allowed domain`), so even a tool that reports only the status says which
host to allow. To reach another host, someone with the Maintain [role](/guides/access-and-roles/) or
higher adds it to the project's
allowed domains under **Settings → Guardrails**; a project whose guardrails
turn the network restriction off runs its jobs with an open network.

A host only workflows should reach, such as the API a deploy uploads to,
goes in **Workflow-only domains** instead, limited to the workflows and
environments that need it: `api.cloudflare.com | deploy.yml | production`
lets only `deploy.yml`'s jobs with `environment: production` reach it.
Runs of pull requests from forks never reach those hosts. See [workflow-only domains](/guides/guardrails/#workflow-only-domains).

### Brokered secrets

A secret a job uses only to call an API can be brokered: the job gets a
stand-in (`g1tsec_…`) in place of `${{ secrets.KEY }}`, and g1t puts the
real value on the job's requests to the hosts the secret names as they
leave its sandbox, in headers (Basic auth included) and the query string.
The value never enters the job, so neither its steps nor a compromised
dependency can read it. A stand-in sent to any other host goes as it is,
and the log says so once. This works on g1t's machines, whether the
project's network is restricted or open; a job on a self-hosted runner
gets the stand-in too, never the value, and its log warns that it will
not work there yet. A secret the job must read itself (a database
password over raw TCP, a signing key, a key to files it decrypts) cannot
be brokered. See
[brokered secrets](/guides/secrets-and-variables/#brokered-secrets).

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
- The artifact actions run on g1t's runner, with the same files.

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

A run's summary lists its artifacts with their size and when they expire.
Anyone who can see the run downloads them there; someone with the Write
role can delete one before it expires.

## Actions built on the toolkit

`actions/cache` and many other actions save to the cache with GitHub's
toolkit, `@actions/cache`: `actions/setup-node`, `actions/setup-python`,
`actions/setup-go` and `actions/setup-java` with `cache:`,
`Swatinem/rust-cache`, and others. They work on g1t as they are: every job gets `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_CACHE_URL` and
`ACTIONS_RESULTS_URL`, and g1t answers the toolkit's requests from the
repository's cache.

- Their entries are the repository's, under [the cache's](#the-cache)
  limits, and are deleted the same way.
- An entry is found by its key and by the version the toolkit names for
  it, from its paths and compression, as on GitHub: an entry `setup-node`
  saved is restored by `actions/cache` with the same key and paths, and
  the other way round.
- An entry the toolkit sends whole, which it does below 128 MB, is not
  saved when it is over 100 MB, the most g1t takes in one request. The
  step warns and the job goes on.
- The toolkit's artifact library refuses to run against any server but
  github.com, so an action that uploads artifacts with it directly fails
  with its own message. `actions/upload-artifact`,
  `actions/download-artifact` and `actions/upload-artifact/merge` work:
  g1t runs those itself.

## An action's pre and post

A JavaScript action's `pre` runs before the job's first step, as on
GitHub: each one is a step of its own, *Pre* and the step's name, in the
order of the steps, when its `pre-if` holds (`always()` when it has
none). Its `post` runs after the last step, *Post* and the step's name,
last first. What `pre` saves with `GITHUB_STATE` or `::save-state::`
reaches the step's main as `STATE_<name>`, and what either saves reaches
`post`.

An action in your repository (`uses: ./…`) is not checked out when the
job starts, so its `pre` is not run and the step warns, as on GitHub. An
action inside a composite action runs its `pre` right before its main.

A step that gives an input the action does not declare is warned of:
*Unexpected input(s) 'foo', valid inputs are ['token', 'path']*. The
step still runs.

## Problem matchers

`::add-matcher::path/to/matcher.json` adds the matchers in a file of
GitHub's format, and they read every line of output from then on, for
the rest of the job. A line one matches becomes an error, warning or
notice annotation, with the file, line, column and message it found, in
place of the line in the log.

```json
{
  "problemMatcher": [
    {
      "owner": "my-linter",
      "pattern": [
        {
          "regexp": "^(.+):(\\d+):(\\d+): (error|warning) (.*)$",
          "file": 1, "line": 2, "column": 3, "severity": 4, "message": 5
        }
      ]
    }
  ]
}
```

- A pattern of several lines matches them in order. The last one can
  set `loop` to match each issue after a header line, as ESLint's
  stylish output has.
- `severity` is the matcher's own default, `error` when it gives none.
  A severity other than `error`, `warning` or `notice` is no annotation.
- A file is kept when it exists in a repository in the workspace, as a
  path inside it; `fromPath` names the file a relative path is from.
- A matcher added with an owner already there takes its place.
  `::remove-matcher owner=my-linter::` removes it.
- Patterns are regular expressions as Rust's `regex` reads them, which
  has no lookaround or backreferences. A file whose patterns do not
  read is refused, with an error in the log.

`::echo::on` shows each workflow command in the log as it is read,
until `::echo::off`; with [debug logging](#debug-logging) they are shown
from the start.

## Caching Rust builds

A checkout gives every file a new modification time, so Cargo compiles
your workspace's own crates again even when `target/` was restored from
the cache. [sccache](https://github.com/mozilla/sccache) caches each
compiler call by what it compiles (the source, the flags, the toolchain
and the dependencies), so a crate that did not change comes back from the
cache instead. Its GitHub Actions backend works on g1t as it is: it keeps
its entries in the repository's cache, under [the cache's](#the-cache)
limits and branch rules.

1. Install sccache, pinned to a release and checked against its checksum.
2. Set `RUSTC_WRAPPER: sccache` and `SCCACHE_GHA_ENABLED: "true"`. The
   job's `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_CACHE_URL` are already in
   every step's environment; no step needs to export them.
3. Set `CARGO_INCREMENTAL: "0"`: sccache does not cache incremental
   builds, and a fresh checkout gains nothing from them.

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      RUSTC_WRAPPER: sccache
      SCCACHE_GHA_ENABLED: "true"
      CARGO_INCREMENTAL: "0"
    steps:
      - uses: actions/checkout@v5
      - name: Install sccache
        env:
          VERSION: v0.18.0
          SHA256: 45f1447fbe231e3037bde351ef70677dd212216c8d62ae7ca409fecc4d6acc89
        run: |
          name="sccache-$VERSION-x86_64-unknown-linux-musl"
          curl -fsSL -o "$RUNNER_TEMP/sccache.tar.gz" \
            "https://github.com/mozilla/sccache/releases/download/$VERSION/$name.tar.gz"
          echo "$SHA256  $RUNNER_TEMP/sccache.tar.gz" | sha256sum -c -
          tar -xzf "$RUNNER_TEMP/sccache.tar.gz" -C "$RUNNER_TEMP"
          install -m 0755 "$RUNNER_TEMP/$name/sccache" "$HOME/.cargo/bin/sccache"
      - run: cargo test --workspace --locked
      - name: sccache's hits and misses
        if: always()
        run: |
          echo '```' >> "$GITHUB_STEP_SUMMARY"
          sccache --show-stats | tee -a "$GITHUB_STEP_SUMMARY"
          echo '```' >> "$GITHUB_STEP_SUMMARY"
```

What to expect:

| | |
| --- | --- |
| What is cached | Every library crate (`rlib`): your workspace's crates and their dependencies. |
| What is compiled each time | What rustc links: binaries, `cdylib` crates, proc macros, build scripts and test harnesses. |
| Its entries | One per compiled crate, often thousands for a workspace, each a few KB to a few MB. They count toward the repository's 10 GiB like any other entry, and the ones not restored for 7 days are deleted. |
| Branches | A pull request reads what the default branch saved. Run the workflow on pushes to the default branch too, as above, or each pull request's first run starts with an empty cache. |
| Starting over | Set `SCCACHE_GHA_VERSION` to any new value. A new sccache release starts over by itself. |
| If the cache cannot be reached | sccache refuses to start. Set `SCCACHE_IGNORE_SERVER_IO_ERROR: "1"` to have rustc run without it instead. |

sccache adds to `actions/cache` rather than replacing it: keep caching
`~/.cargo/registry/cache` and `target/` keyed by `Cargo.lock`, so Cargo
does not call rustc at all for dependencies that did not change, and
sccache answers the calls it still makes for your own crates.
`Swatinem/rust-cache` works the same way.

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

A job without `id-token: write` has no `ACTIONS_ID_TOKEN_REQUEST_URL`, so
a login action says it cannot find one; a token asked for anyway is
refused with `403` and `This job has no OIDC token`.

### Reaching your cloud

Asking for the token goes to `api.g1t.sh`, which every job reaches. Trading
it for credentials goes to your cloud's token service, which a job reaches
only when its project allows it (see [what a job can reach](#what-a-job-can-reach)).
Add the hosts under **Settings → Guardrails → Workflow-only domains**,
limited to the workflow and environment that deploy, so other workflows
never reach them:

```text
sts.us-east-1.amazonaws.com | deploy.yml | production
s3.us-east-1.amazonaws.com | deploy.yml | production
sts.googleapis.com | deploy.yml | production
iamcredentials.googleapis.com | deploy.yml | production
login.microsoftonline.com | deploy.yml | production
management.azure.com | deploy.yml | production
```

| Cloud | Token exchange | Then |
| --- | --- | --- |
| AWS | `sts.<region>.amazonaws.com`, the region `aws-region` names | Each service the job uses, such as `s3.<region>.amazonaws.com`, or `*.amazonaws.com` for all of them |
| Google Cloud | `sts.googleapis.com`, `iamcredentials.googleapis.com` | Each API the job uses, such as `run.googleapis.com` |
| Azure | `login.microsoftonline.com` | `management.azure.com`, and each service the job uses |

Without them, the login step fails with `403` and a line naming the host
that is not allowed.

### Claims

Each token carries the claims GitHub's do, so trust policies written for
those read g1t's the same way.

| Claim | Example |
| --- | --- |
| `sub` | `repo:acme/web:environment:production` for a job with an `environment:`; `repo:acme/web:pull_request` for a pull request's run; otherwise `repo:acme/web:ref:refs/heads/main` (or `refs/tags/v1.2.0`) |
| `repository`, `repository_owner` | `acme/web`, `acme` |
| `repository_id`, `repository_owner_id` | g1t's ids for them, such as `rep_01kpw0…` (not the numbers `github.repository_id` and `github.repository_owner_id` give, so trust policies already written keep matching) |
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

3. Allow `sts.<region>.amazonaws.com`, and what the job deploys to, as
   [workflow-only domains](#reaching-your-cloud).
4. Use `aws-actions/configure-aws-credentials@v4` with `role-to-assume`,
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

3. Allow `sts.googleapis.com` and `iamcredentials.googleapis.com`, and
   the APIs the job uses, as [workflow-only domains](#reaching-your-cloud).
4. Use `google-github-actions/auth@v2` with
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
3. Allow `login.microsoftonline.com` and `management.azure.com` as
   [workflow-only domains](#reaching-your-cloud).
4. Use `azure/login@v2` with `client-id`, `tenant-id` and
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

A run's page opens on its **Summary**. Its sidebar lists **All jobs**;
pick one to see its steps and their logs as they are written. Groups
fold, errors and warnings are marked, and secrets are replaced with
`***`. The page keeps itself up to date while the run goes on.

### Live logs

While a job runs, its log reaches the page within about two seconds of
being printed: the runner sends what a step prints every second, and the
page asks for more every second while a step is running.

- The running step opens by itself, and its timer counts up. Its log
  follows the newest line while the end of it is on screen, with the last
  line wholly in view (above the tab bar on a phone). Scroll up and it
  stays where you are, with **Jump to latest** to go back to the end and
  follow it again.
- A step that prints nothing for a while says so under its last line:
  **Running · no output for 2m 10s**, or **no output yet** before its
  first line. The job's header names the step it is on.
- Colour that tools print is shown as they print it: bold, dim, italic,
  underline, the 16 terminal colours, 256 colours and 24-bit colour, for
  text and background, in both the light and the dark theme. Tools built
  on chalk or supports-color colour their output because the job has
  `GITHUB_ACTIONS=true`, as on GitHub; others need asking, such as
  `CARGO_TERM_COLOR: always` in the step's `env` for cargo. Other escape codes (moving the cursor, clearing a
  line) are left out, and a link keeps its text. Search reads the text
  without the colour codes.
- Every line is stamped with the time it was printed, as GitHub stamps
  it (`2026-10-12T09:41:07.1234567Z`). The clock button beside **Search
  logs** shows or hides the times; your browser remembers which.
- A download (the job's `log.txt` and the run's zip) has the time at the
  start of every line, as GitHub's downloaded logs do.
- Each line's number links to it, as on GitHub: `#step:3:12` is line 12
  of step 3 (0 is **Set up job**). Opening the link opens the step and
  any group the line is in, scrolls to the line and marks it.
- A long step's log stays fast. Each new piece of a running step's log is
  read once as it arrives, and a step of more than 2,000 lines draws only
  the lines on screen and a few around them. Search, groups, line links,
  following the newest line and **Jump to latest** work as they do on a
  short log. Your browser's own find (Ctrl+F) only sees the lines that are
  drawn, so use **Search logs** in a long log.
- The runner numbers each batch of the log it sends. When it sends a
  batch again because g1t's answer didn't reach it, g1t keeps the batch
  once, so a line never shows twice.
- If the page cannot reach g1t for a moment, it says **Reconnecting to the
  log** and tries again, waiting longer each time up to half a minute.
  A tab you are not looking at stops asking, and catches up when you come
  back to it.

A cache restore, an artifact upload or download, and other transfers say
how far they have got every few seconds
(`Received 46137344 of 523190823 (8.8%), 43.9 MBs/sec`).

A [self-hosted runner](/guides/self-hosted-runners/) stamps its lines and
writes these headers once it has updated itself to a release that does;
until then its logs show without times.

### What a job's log says

Each job's log reads as GitHub's does:

| Step | What it shows |
| --- | --- |
| **Set up job** | The runner's version and name; the operating system; the runner image (`ImageOS` and `ImageVersion` when the machine's image sets them, and the software g1t's machines have); the machine (hosted or self-hosted, its architecture, CPUs and memory); what the job's [token](#the-jobs-token) may do, under **G1T_TOKEN Permissions**; the secret source; each action the job uses as it is downloaded, with the commit it resolved to (`Download action repository 'actions/setup-node@v4' (SHA:…)`); and the job's matrix. |
| A `run:` step | A folded group, `Run` and the script's first line, holding the whole script, the shell it ran in (`shell: /usr/bin/bash -e {0}`) and its variables under `env:`, secrets masked. Then what it printed. |
| A `uses:` step | A folded group, `Run owner/repo@ref`, holding its inputs under `with:` (an action's defaults among them) and its variables under `env:`. |
| **Post** steps and **Stop containers** | An action's `post`, saving the cache, then the job's containers stopped, as on GitHub. |
| **Complete job** | The job's outputs as they are set (`Set output 'version'`), and **Cleaning up orphan processes**: anything the steps started and left running is stopped (`Terminate orphan process: pid (1234) (node)`). The runner finds those processes by `RUNNER_TRACKING_ID`, as GitHub's does, so a process that unsets it is not found. Only on Linux. |

### The run's summary

The summary holds, top to bottom:

| Part | What it shows |
| --- | --- |
| The run | What triggered it and when, who, the commit and its branch (or pull request), how the run stands, how long it took in all, and how many artifacts it kept. |
| The jobs graph | The workflow file and its event (`deploy.yml · on: push`), then every job and how they depend on each other. See [the jobs graph](#the-jobs-graph). |
| Annotations | Every job's errors, warnings and notices, counted by kind, each with the job it came from. Folds away. |
| Job summaries | What each job's steps wrote to `$GITHUB_STEP_SUMMARY`, under `<job> summary`. See [job summaries](#job-summaries). |
| Artifacts | What the run kept, to download. The count in the run's card jumps here. |

Under **Run details** in the sidebar, **Workflow file** opens the
workflow as it was at the run's commit.

### The jobs graph

Jobs are laid out left to right by their `needs:`: a job that needs
nothing starts a row on the left, and each job sits one column to the
right of the furthest job it needs. Within a column, jobs are ordered so
that as few connectors as possible cross.

| Node | How it shows |
| --- | --- |
| A job | Its status, its name and how long it took. Click it to open its steps and logs. |
| A job that deploys | Its environment's address (`environment.url`), as a link, under its name. |
| A matrix | One node with how many jobs it made (`test · 6 jobs`) and how they stand together. Click it to list each combination; click one to open it. |
| A reusable workflow | A box under the job that calls it, named with the called file, holding the called workflow's jobs laid out the same way; a matrix of calls shares one box, each call's jobs named with its combination. The jobs that need the calling job connect to the box. |

Connectors run from a job to each job that needs it. They are red from a
job that failed, and move while the job they lead to is running (they
stay still if your system asks for reduced motion).

A wide graph scrolls sideways inside its card, on a phone as on a desktop.

The sidebar groups jobs the same way: a matrix's jobs, and a called
workflow's jobs, fold under their name.

### Job summaries

Markdown a step appends to the file in `$GITHUB_STEP_SUMMARY` shows on
the run's summary, below the graph, a card per job, in the order its
steps wrote it. The card's title opens the job:

```yaml
- name: Report the tests
  if: always()
  run: |
    echo "### Test results" >> "$GITHUB_STEP_SUMMARY"
    echo "| Suite | Passed | Failed |" >> "$GITHUB_STEP_SUMMARY"
    echo "| --- | ---: | ---: |" >> "$GITHUB_STEP_SUMMARY"
    echo "| unit | 41 | 0 |" >> "$GITHUB_STEP_SUMMARY"
```

| What | How it works |
| --- | --- |
| Formatting | GitHub-flavoured Markdown: tables, task lists, alerts such as `> [!WARNING]`, code blocks, and the HTML GitHub allows. Scripts, styles and event handlers are removed. |
| Secrets | Masked like the log, before the summary leaves the runner. |
| Size | Up to 1 MiB a step. A larger summary is refused with an error in the step's log, as on GitHub. |
| Steps | Up to 20 steps of a job keep a summary; later ones are dropped. |
| Actions | A JavaScript action's `core.summary` writes to the same file, so it works unchanged. |

Summaries belong to their attempt: an earlier attempt keeps its own.

### Re-running

When a run has finished, someone with the Write role can run it again:

| Button | Runs again |
| --- | --- |
| **Re-run all jobs** | Every job. |
| **Re-run failed jobs** | Jobs that did not succeed (failed, cancelled or skipped), and every job that needs one of them. |
| The re-run button beside a job's name | That job, and every job that needs it. A job of a matrix runs again with the rest of its matrix; a job of a reusable workflow runs again with the job that calls it. |

Jobs that are not run again keep how they ended, and their outputs reach
the jobs that need them.

Each re-run is a new **attempt**. The run keeps its number, `github.run_attempt`
goes up by one, and the attempt before is kept as it ended: its jobs,
their steps, logs and summaries. Pick one from **Attempt #** at the top of
the page to read it. Its jobs have ids of their own, so a link to an
earlier attempt's job keeps showing that job's log.

#### Debug logging

Each re-run asks whether to **Enable debug logging**. The new attempt's
jobs then run with:

| Set | Effect |
| --- | --- |
| `RUNNER_DEBUG=1`, and `runner.debug` is `1` | Actions that check it, such as the toolkit's `core.isDebug()`, log more. |
| `ACTIONS_STEP_DEBUG=true` | `::debug::` lines are shown in the log. |
| `ACTIONS_RUNNER_DEBUG=true` | Set for actions that read it. |

With debug logging, each step's log also says how its `if:` read:
`Evaluating condition for step`, the expression, and the result. Setting a
secret or variable named `ACTIONS_STEP_DEBUG` to `true` shows `::debug::`
lines on every run instead. The attempt picker marks attempts that ran
with debug logging.

### Cancelling

**Cancel run** is at the top of the run's page while any job of its latest
attempt has not finished: waiting for the jobs it needs, held for an
environment's approval, queued for a runner (a self-hosted job waits
until a runner with its labels takes it), or running. It is there on an
earlier attempt's page too, and on a job's, and the re-run buttons appear
only once the run has finished. A page left open on a finished run hears
when it is re-run, from anywhere, and offers Cancel run.

It cancels jobs that have not started at once. A job that is running is
stopped the way GitHub stops one:

1. The step it is on gets `SIGINT`, then `SIGTERM` 7.5 seconds later, and
   is killed 2.5 seconds after that. Signals reach the processes the step
   started too; in a [job container](#job-containers) they reach only the
   `docker exec` that runs the step. The step ends **cancelled**.
2. Its remaining steps run only if they ask to: `if: always()` or
   `if: cancelled()`. Steps without an `if:`, or with `success()` or
   `failure()`, are skipped.
3. Post steps (an action's `post`, saving the cache) run, as their
   `post-if` is `always()` unless the action says otherwise.
4. The job ends **cancelled**, whatever those steps came to.

While that happens the run says **Cancelling**. A job still going 5
minutes after it was cancelled is stopped outright. **Force cancel**
(shown while a run is cancelling) stops every job at once, without
waiting for its cleanup steps.

A step learns of a cancellation within about 10 seconds, even when it
prints nothing. A job on a [self-hosted runner](/guides/self-hosted-runners/)
is stopped the same way.

### Searching and downloading logs

The **Search logs** box above a job's steps shows only the lines that hold
what you type, in any case, with each match marked and every step that has
one opened. Lines inside folded groups are searched too.

| Download | Where |
| --- | --- |
| One job's whole log, as text | The download button beside the job's name. |
| Every job's log of an attempt, as a zip | **Download logs** at the top of the run. The zip holds `1_<job>.txt` with each job's whole log, and a `<job>/` folder with `<step>_<step name>.txt` for each step. |

A zip holds up to 24 MiB of logs; jobs past that are listed with a note
to download them on their own. Each job keeps up to 4 MB of log.

### Status badges

A badge shows how a workflow's latest finished run went: **passing**,
**failing**, **cancelled**, or **no status** before it has finished one.

1. Open the repository's **Actions** page and pick the workflow.
2. Click **Create status badge**.
3. Choose a branch and an event, if you want them, and copy the Markdown.

```markdown
[![CI](https://g1t.sh/acme/web/actions/workflows/ci.yml/badge.svg)](https://g1t.sh/acme/web/actions?workflow=ci.yml)
```

The address is `https://g1t.sh/{workspace}/{repo}/actions/workflows/{file}/badge.svg`,
where `{file}` is the workflow's file name in `.g1t/workflows/`. It takes:

| Parameter | Shows |
| --- | --- |
| `branch` | Runs on that branch. Without it, the default branch's runs, or any branch's when the default branch has none. |
| `event` | Runs started by that event, such as `push` or `pull_request`. |

A public repository's badge loads for anyone and is cached for a minute.
A private repository's loads only for someone who can see the repository,
so it does not show in a README read anywhere else.

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

A [brokered secret](#brokered-secrets)'s stand-in is masked the same way.
Its real value never reaches the job, so the job cannot mask it; g1t
masks it in the log as the log arrives, should an answer have carried it
in.

## Pull requests

A pull request's workflows run on each new head: when it is opened and
when a commit is pushed to it. Each head runs each workflow once.

They also start on the activity types `reopened` (also run by
default, as `opened` and `synchronize` are), `converted_to_draft`,
`ready_for_review`, `labeled`, `unlabeled`, `milestoned`, `demilestoned`,
`assigned`, `review_requested` and `closed`, and `edited` when the branch
a pull request merges into changes; `issue_comment` workflows on
`created`, `edited` (with `github.event.changes.body.from`) and `deleted`; `issues` workflows on `assigned`, `labeled`, `unlabeled`, `milestoned` and
`demilestoned` too. List them under `types:` to run on them. For
`labeled` and `unlabeled`, `github.event.label` names the label; for
`assigned`, `github.event.assignee` names who was assigned. Assigning
several people at once starts one run, which names the first of them. A pull
request's `branches` filter, `github.base_ref` and
`pull_request.base.ref` are the branch it merges into, which is not
always the default branch: see
[pull requests into other branches](/guides/base-branches/).

### What a pull request's run builds

As on GitHub, a `pull_request` run builds the pull request merged into
its base branch, not its head alone:

| | Is |
| --- | --- |
| `github.ref`, `GITHUB_REF` | `refs/pull/<number>/merge` |
| `github.sha`, `GITHUB_SHA` | The test merge commit at `refs/pull/<number>/merge`: the head merged into the base branch's latest commit, its parents the base's commit and then the head, with the message `Merge <head> into <base>` |
| `github.event.pull_request.head.sha` | The head commit |
| `github.event.pull_request.merge_commit_sha` | The test merge commit |
| `actions/checkout` with no `ref` | The test merge commit, fetched from the repository itself as `+<sha>:refs/remotes/pull/<number>/merge` |

The workflow files the run uses are read from the test merge commit too.
Its status, its check runs and the run itself stay on the pull request's
head, so required checks hold the merge as before. `pull_request_review`
runs build the same commit. `pull_request_target` runs are unchanged: they
build the base branch, never the pull request's code.

g1t keeps two refs in the repository for every open pull request, from a
branch or a fork: `refs/pull/<number>/head` at
its head (a fork's head commit is copied into the repository), and
`refs/pull/<number>/merge` at its test merge commit. Both move each time
the head is pushed to, the pull request is opened or reopened, or its
base branch changes, and both can be fetched like any branch:

```sh
git fetch origin refs/pull/12/head refs/pull/12/merge
```

The merge commit moves when the head does. When only the base branch
moves, it moves at the pull request's next event, as on GitHub, where
workflows do not run again because the base branch moved.

**A pull request with conflicts runs no `pull_request` workflows**, as on
GitHub: it has no merge commit to build. Its checks box says so, and the
runs start once the conflicts are resolved and the head is pushed again.
g1t merges the two the way git does: a file only one side changed is
taken from it, and changes both made to the same file merge unless they
change the same or neighbouring lines differently, or the file is binary.
When g1t cannot make the merge itself (a file one side renamed or deleted
while the other changed it, a file where the other side has a directory,
more than 300 changed files, or a file over 1 MB that both changed), the
run builds the head commit instead, as it did before.

A pull request from outside the workspace may wait for approval before
its workflows run: see [pull requests from outside](#pull-requests-from-outside).

`github.event.pull_request` reads as it does on GitHub. `sender` is
whoever caused the event.

## The event payload

`github.event`, and the file at `GITHUB_EVENT_PATH`, hold the webhook
payload GitHub would send for the event, with the same keys and types.

- **Ids are numbers.** `repository.id`, `pull_request.id`, `issue.id`,
  `review.id`, `sender.id`, every `user.id` and `owner.id` are whole
  numbers, the same for an object wherever it appears and below 2^53, so
  JavaScript reads them exactly. `node_id` is g1t's own id, such as
  `rep_01kpw0…`. A person's or workspace's number comes from their name,
  so it changes when they are renamed. `github.repository_id`,
  `github.repository_owner_id`, `github.actor_id` and their
  `GITHUB_REPOSITORY_ID`, `GITHUB_REPOSITORY_OWNER_ID` and
  `GITHUB_ACTOR_ID` variables are the same numbers, as text.
- **What the API takes by id keeps g1t's id.** `comment.id`,
  `release.id`, `deployment.id`, `deployment_status.id`,
  `workflow_run.id` and `workflow_run.workflow_id` are g1t's ids
  (`cmt_…`, `rel_…`, `run_…`, `wfl_…`), so you can pass them straight
  back, as in `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`
  or `run-id: ${{ github.event.workflow_run.id }}`.
- **`repository.owner.type`** is `User` for a repository in a person's
  own workspace and `Organization` for any other workspace's.
- **On `push`,** `created` is true for a new branch or tag, and `forced`
  is true when the commit before the push is not in the new commit's
  history. g1t reads the 20 latest commits to tell, so a forced push onto
  a longer history says `false`. `head_commit` is the commit pushed and
  `commits` lists at most 20, oldest first. `pusher.email` is the
  pusher's noreply address (`<id>+<username>@users.noreply.g1t.sh`), or
  `g1t@users.noreply.g1t.sh` for g1t.
- **A commit's `added`, `removed` and `modified`** list the paths the
  push changed when it pushed one commit and a workflow on `push` has a
  `paths` or `paths-ignore` filter, which makes g1t compare the push.
  Otherwise, and for a push of several commits, they are empty lists.
- **On pull request events,** `pull_request.base.sha` is the tip of the
  branch it merges into when the event happened, and
  `pull_request.merge_commit_sha` is set only once it is merged, to the
  commit it landed as.
- **On `workflow_run`,** `workflow_run` has the followed run's `name`,
  `path`, `event`, `status`, `conclusion`, `head_branch`, `head_sha`,
  `head_commit`, `run_number`, `run_attempt`, `actor`, `created_at`,
  `updated_at`, `html_url`, `repository` and `pull_requests`. Each pull
  request there has its `id`, `number`, `url`, and `head` and `base`
  with their `ref`, `sha` and `repo` (`id`, `url`, `name`). As on
  GitHub, a pull request from a fork is not listed.

Labels on `issue`, `pull_request` and a `labeled` event's `label` have
their `id`, `name`, `color` and `description` as the repository has
them, and `default`, which is true for the labels a repository starts
with.

## Checks

A pull request's checks are its workflows. Each workflow that runs on
`pull_request` runs for every pull request, whoever opened it, a
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

To deploy to AWS, Google Cloud or Azure, or to a server of your own,
you need no secret at all: give the job `permissions: id-token: write`
and trade its [OIDC token](#oidc-tokens) for short-lived credentials.

Every job also gets `${{ secrets.G1T_TOKEN }}`, [its own token](#the-jobs-token),
with `GITHUB_TOKEN` as its alias. A pull request's runs get secrets only
when its author has the Write [role](/guides/access-and-roles/) or higher
on the repository, a member or an outside collaborator. Anyone else's, such as one
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
[personal access token](/guides/authentication/#workflow-files) that has
Workflow files: write, kept as a secret.

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
wait timer runs out. Reviewers are told in their [notifications](/guides/notifications/);
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

Members' pull requests never wait. Each new push to the pull request waits again.
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
| `job_logs` | `GET /repos/{owner}/{repo}/actions/jobs/{job}/logs?after=`, or `?format=text` for the whole log as plain text |
| `get_run` with `attempt` | `GET /repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}` |
| No tool: a download | `GET /repos/{owner}/{repo}/actions/runs/{id}/logs`, or `…/attempts/{attempt}/logs`: every job's log as a zip |
| `dispatch` | `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` with `ref` and `inputs` |
| `cancel` | `POST /repos/{owner}/{repo}/actions/runs/{id}/cancel`; `…/force-cancel`, or `force`, to stop running jobs without their cleanup steps |
| `rerun` | `POST …/runs/{id}/rerun`, or `…/rerun-failed-jobs`; one job and those that need it with `POST /repos/{owner}/{repo}/actions/jobs/{job}/rerun`. Each takes `enable_debug_logging` (or `debug`) |
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
| `get_access`, `set_access` | `GET` and `PUT /repos/{owner}/{repo}/actions/permissions/access`, with `access_level` (`none` or `organization`) |
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

Give only the inputs the workflow declares under
`on.workflow_dispatch.inputs`: a run with any other input is refused, and
the answer names the inputs it did not expect. A `boolean` input is `true`
or `false`, a `number` a number, a `choice` one of its `options`, and an
`environment` the name of one of the repository's
[environments](#environments). In the run, the `inputs` context keeps
booleans and numbers as they are, and `github.event.inputs` has every
input as text, `"true"` and `"3"`, as on GitHub.

To save an artifact from a script, follow the redirect:

```sh
curl -L -o web-dist.zip -H "Authorization: Bearer $G1T_TOKEN" \
  https://api.g1t.sh/repos/acme/web/actions/artifacts/4182/zip
```
