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
| `actions/upload-artifact`, `actions/download-artifact`, `actions/upload-artifact/merge` | The same inputs and outputs as version 4: `retention-days`, `overwrite`, `compression-level`, `include-hidden-files`, `!` exclusions, download by `pattern` with `merge-multiple`, and from another run with `run-id` and `github-token`. Up to 5 GiB each; see [artifacts](#artifacts). |
| `actions/cache`, `actions/cache/restore`, `actions/cache/save` | Kept per repository, found by `key` or the newest under a `restore-keys` prefix. `path` takes globs and `!` exclusions. Up to 2 GiB each; see [the cache](#the-cache). |
| Actions that cache through the toolkit, such as `actions/setup-node` with `cache: npm` or `Swatinem/rust-cache` | The same: they save to and restore from the repository's cache. See [actions built on the toolkit](#actions-built-on-the-toolkit). |
| `permissions: id-token: write` | The job can ask for an OIDC token, and trade it for a cloud provider's credentials. See [OIDC tokens](#oidc-tokens). |

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
- **Actions that upload artifacts with the toolkit's artifact library
  themselves.** The library refuses to run against any server but
  github.com. `actions/upload-artifact`, `actions/download-artifact` and
  `actions/upload-artifact/merge` work, because g1t runs them itself. See
  [actions built on the toolkit](#actions-built-on-the-toolkit).
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
