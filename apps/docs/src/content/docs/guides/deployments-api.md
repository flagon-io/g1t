---
title: Deployments API
description: Report deployments from any CI, see every deployment of a repository and its environments in one place, require them before a merge, and hear of them by webhook.
---

A repository keeps one list of its deployments, wherever they ran. A
deployment is one commit sent to one environment, such as `production` or
`staging`. An environment is the place it went: a name, and the address it
is served at. Each deployment has a list of statuses that say how it went,
and its latest status is its state.

Deployments reach that list three ways. Each deployment says which in its
`source`:

| `source` | Made by | Ids |
| --- | --- | --- |
| `api` | Any CI or script, through the routes on this page, with an access token. | `dep_…` |
| `actions` | A [g1t Actions](/guides/actions/) job with an `environment:`, by itself. | `dep_…` |
| `g1t_page` | A [g1t.page](/guides/deployments/) build of a project, to the `production` or `preview` environment. | `dpl_…` |

A status's id starts `dst_`. Every deployment, whatever its source, shows
on the repository's **Deployments** page, sets a check on its commit, and
sends [webhooks](#webhooks).

## Report a deployment from any CI

You report a deployment by creating it, then adding a status each time it
moves on. The base URL is `https://api.g1t.sh`, and every request carries
an access token as `Authorization: Bearer g1t_…`.

### Make a token

1. Open your **Settings → Access tokens**, or a workspace's
   **Settings → Access tokens** for a token that belongs to the workspace.
2. Give the token a name, such as `release-pipeline`.
3. Select the **CI** preset. It includes `deployments:read` and
   `deployments:write`. To report deployments and nothing else, tick only
   `deployments:write` under **Deployments**.
4. Choose an expiry and select **Create token**. Copy the token now: it is
   not shown again.
5. Store it in your CI as a secret named `G1T_TOKEN`.

Reporting also needs the Write [role](/guides/access-and-roles/) on the
repository. See [scopes](/guides/authentication/#scopes).

### Create the deployment

`POST /repos/{owner}/{name}/deployments` creates a deployment. Give it
`state: "in_progress"` when the deploy has started:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/deployments \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ref": "main",
    "environment": "staging",
    "description": "Deployed by the release pipeline",
    "state": "in_progress",
    "log_url": "https://ci.example.com/pipelines/4182"
  }'
```

The answer is the deployment, with its first status in `statuses`. Keep
its `id` for the next call.

| Field | Default | |
| --- | --- | --- |
| `ref` | Required | The branch, tag or commit deployed, such as `main` or `v1.4.0`. |
| `sha` | Resolved from `ref` | The commit deployed. Give the whole commit id to skip resolving `ref`. |
| `environment` | `production` | Any name up to 255 characters, such as `staging` or `review/feature-x`. Names are matched without regard to case, and the first spelling is kept. |
| `task` | `deploy` | What kind of deployment, such as `deploy:migrations`. Up to 100 characters. |
| `description` | None | A short note, up to 1,000 characters. |
| `payload` | `{}` | Anything else to keep with it: a JSON object, or a JSON string of one, up to 64 KB. Returned as given. |
| `production_environment` | `true` for `production`, else `false` | Whether people use this environment directly. |
| `transient_environment` | `false` | Whether the environment goes away, such as a review app. |
| `state` | `queued` | Its first status. See [statuses](#statuses). |
| `environment_url` | None | Where it is served, an `http` or `https` address. |
| `log_url` | None | Where its output can be read, an `http` or `https` address. |

### Report how it went

`POST /repos/{owner}/{name}/deployments/{id}/statuses` adds a status. When
the deploy succeeds, give the address it is served at:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/deployments/dep_01kq7z9a1c3e5g7j9m1p3r5t7v/statuses \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "success",
    "environment_url": "https://staging.example.com",
    "log_url": "https://ci.example.com/pipelines/4182"
  }'
```

When it fails:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/deployments/dep_01kq7z9a1c3e5g7j9m1p3r5t7v/statuses \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "failure",
    "description": "Smoke tests failed",
    "log_url": "https://ci.example.com/pipelines/4182"
  }'
```

| Field | Default | |
| --- | --- | --- |
| `state` | Required | `queued`, `in_progress`, `success`, `failure`, `error` or `inactive`. |
| `description` | None | A short note, up to 1,000 characters. |
| `environment_url` | None | Where it is served, an `http` or `https` address. |
| `log_url` | None | Where its output can be read, an `http` or `https` address. |
| `auto_inactive` | `true` | On a `success`, give the environment's older successful deployments an `inactive` status. See [auto_inactive](#auto_inactive). |

The deployment takes the status's state, and any address the status gives.

### A script for any CI

This script wraps a deploy command. It needs `curl`, `jq`, and three
variables: `G1T_TOKEN`, `G1T_REPO` (such as `acme/web`) and `GIT_COMMIT`
(the commit being deployed). Change `ENVIRONMENT`, `ENVIRONMENT_URL` and
the deploy command to yours.

```sh
#!/bin/sh
set -eu

API="https://api.g1t.sh/repos/$G1T_REPO/deployments"
ENVIRONMENT="staging"
ENVIRONMENT_URL="https://staging.example.com"

report() {
  curl -fsS -X POST "$1" \
    -H "Authorization: Bearer $G1T_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$2"
}

# 1. Create the deployment, in progress.
ID=$(report "$API" "$(jq -n \
  --arg ref "$GIT_COMMIT" \
  --arg environment "$ENVIRONMENT" \
  '{ref: $ref, environment: $environment, state: "in_progress"}')" | jq -r .id)

# 2. Deploy, then report how it went.
if ./deploy.sh; then
  report "$API/$ID/statuses" "$(jq -n --arg url "$ENVIRONMENT_URL" \
    '{state: "success", environment_url: $url}')" > /dev/null
else
  report "$API/$ID/statuses" '{"state": "failure", "description": "The deploy command failed"}' > /dev/null
  exit 1
fi
```

Give `log_url` in both calls to link the deployment to your CI's page for
the job.

## Statuses

| State | Means | The commit's check |
| --- | --- | --- |
| `queued` | It is waiting to start. | Pending |
| `in_progress` | It is deploying. | Pending |
| `success` | It is live. | Success |
| `failure` | It did not go live. | Failure |
| `error` | Something went wrong around it, such as a cancelled run. | Error |
| `inactive` | It is no longer what the environment serves. | Left as it was |

A g1t.page build's statuses are read from the build itself: `queued`, then
`in_progress` while it builds, then how it ended, and `inactive` once a
newer build replaced it or it was taken down. You cannot add statuses to a
g1t.page build: `POST …/deployments/dpl_…/statuses` answers `409`.

### auto_inactive

An environment serves one deployment at a time. When a deployment
succeeds, the environment's older successful deployments each get an
`inactive` status, so only the newest stays current. To keep them as they
are, for example when several deployments are live side by side, send
`"auto_inactive": false` with the `success`.

## Environments

An environment exists once something deploys to it. You do not create
environments first.

- **Production environments** are those people use directly. An
  environment named `production` is one unless the deployment says
  `"production_environment": false`. Set it to `true` for others, such as
  `live`.
- **Transient environments** go away, such as a review app for one pull
  request. Set `"transient_environment": true` on their deployments.

`GET /repos/{owner}/{name}/environments` lists them: `production` first,
then other production environments, then the rest, most recently deployed
first. Each has:

| Field | |
| --- | --- |
| `name` | The environment's name, as first spelled. |
| `url` | Where it is served: `current`'s `environment_url`. |
| `production_environment`, `transient_environment` | As its deployments said. |
| `deployments_count` | How many deployments went to it. |
| `latest` | Its newest deployment, whatever its state. |
| `current` | Its newest successful deployment that is still active. Null when none is. |
| `updated_at` | When it last changed. |

`total_count` counts deployments across every environment.
`GET /repos/{owner}/{name}/environments/{environment}` returns one, matched
without regard to case. URL-encode a name with slashes:
`…/environments/review%2Ffeature-x`.

An environment with [protection rules](/guides/actions/#environments)
also has `protection_rules` (`required_reviewers`, `wait_timer`,
`branch_policy`), `deployment_branch_policy`, `branch_policies` and
`can_admins_bypass`, and is listed even before anything deploys to it.
`PUT …/environments/{environment}` sets the rules and `DELETE` removes
them.

## Read deployments

| Route | What it returns |
| --- | --- |
| `GET /repos/{owner}/{name}/deployments` | Deployments, newest first, as `{ deployments, total_count, page, per_page }`. |
| `GET /repos/{owner}/{name}/deployments/{id}` | One deployment, with every status in `statuses`, oldest first. |
| `GET /repos/{owner}/{name}/deployments/{id}/statuses` | Its statuses, newest first. |
| `GET /repos/{owner}/{name}/environments` | The environments, as above. |
| `GET /repos/{owner}/{name}/environments/{environment}` | One environment. |

The list takes these filters:

| Query | |
| --- | --- |
| `environment` | Only this environment's, matched without regard to case. |
| `ref` | Only deployments of this branch, tag or commit, as it was given. |
| `sha` | Only deployments of this commit, or of commits starting with it. |
| `task` | Only this task's. |
| `state` | Only deployments whose latest status has this state. |
| `source` | `api`, `actions` or `g1t_page`. |
| `creator` | Only those this username made, or `g1t`. |
| `page`, `per_page` | Which page, from 1, and how many on it: 30 unless you say, at most 100. |

```sh
curl "https://api.g1t.sh/repos/acme/web/deployments?environment=production&state=success&per_page=5" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

A deployment has these fields:

| Field | |
| --- | --- |
| `id` | `dep_…`, or `dpl_…` for a g1t.page build. |
| `environment`, `ref`, `sha`, `task`, `description`, `payload` | As reported. |
| `production_environment`, `transient_environment` | As reported. |
| `state` | Its latest status's state. |
| `environment_url`, `log_url` | The latest addresses it was given. |
| `creator` | The username of whoever reported it or started its run, or `g1t`. |
| `source` | `api`, `actions` or `g1t_page`. |
| `run_id`, `run_url` | The g1t Actions run that made it. Null for other sources. |
| `project`, `number` | For a g1t.page build: the project, and for a preview its pull request's number. Null for other sources. |
| `created_at`, `updated_at` | When it was made, and when it last changed. |

Reading needs the `deployments:read` scope and the Read role. A public
repository's deployments can be read by anyone. Reporting needs
`deployments:write` and the Write role, and an
[archived](/guides/managing-repositories/) repository refuses it with
`409`. Every route, with its example, is in the
[API reference](/reference/api/deployments/list-deployments/).

## The commit's check

Every status sets a check on the deployment's commit, named
`deploy / <environment>`, such as `deploy / staging`. It links to the
deployment's page, `https://g1t.sh/{owner}/{name}/deployments/{id}`. The
[statuses table](#statuses) says which state the check takes. A pull
request whose head was deployed shows the check with its other checks.

g1t.page builds keep their own check, `g1t / deploy`. See
[previews of branches](/guides/deployments/#previews-of-branches).

### Require a deployment before merging

A ruleset's **Require deployments to succeed** rule
(`required_deployments`) holds a pull request until its head has deployed
successfully to each environment it names. A successful
`deploy / <environment>` check meets it, so any environment you report to,
from anywhere, can be required:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/rulesets \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ruleset_name": "Staging first",
    "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"] } },
    "rules": [
      { "type": "required_deployments", "parameters": { "environments": ["staging"] } }
    ]
  }'
```

For this to work, your CI deploys each pull request's head to `staging`
and reports it. See [rules](/guides/rules/#pull-requests-and-checks).

## Deployments from g1t Actions

A [g1t Actions](/guides/actions/) job with an `environment:` makes a
deployment by itself. You do not call the API.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh
```

Give the environment's address with `url`. Its expressions are filled in
from the `github`, `inputs` and `matrix` contexts, and it must be an
`http` or `https` address:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: https://staging.example.com/${{ github.sha }}
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh staging
```

A run makes one deployment per environment, however many of its jobs name
it. A matrix that deploys to three regions makes one `production`
deployment, not three:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        region: [us-east, eu-west, ap-south]
    environment: production
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh ${{ matrix.region }}
```

How the deployment goes:

1. It is made, `in_progress`, when the first job that names the
   environment starts.
2. If one of those jobs fails, it is marked `failure` at once, unless the
   job has `continue-on-error`.
3. When the run finishes, it settles: `failure` if any of those jobs
   failed, `error` if the run was cancelled, and `success` otherwise. Jobs
   that were skipped do not count. If none of them ran, no deployment is
   made.

Its `ref` is the run's branch, `sha` the run's commit, `creator` whoever
started the run, and `log_url` and `run_url` the run's page. A run
attempted again makes a deployment of its own. Jobs on
[self-hosted runners](/guides/self-hosted-runners/) make deployments the
same way.

A job that needs an environment's
[secrets and variables](/guides/secrets-and-variables/#a-value-per-environment)
but does not deploy, such as one that plans a change, says
`deployment: false`:

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    environment:
      name: production
      deployment: false
    steps:
      - uses: actions/checkout@v4
      - run: ./plan.sh
```

A job's `G1T_TOKEN` can also report deployments of its own with the API,
given `deployments: write` in its [`permissions:`](/guides/actions/#the-jobs-token).

A job that names an environment with
[protection rules](/guides/actions/#environments) waits for them before it
starts, and its deployment is made only once it does.

## Webhooks

[Webhooks](/guides/webhooks/) send two events for deployments of every
source, g1t.page builds included:

| Event | When | `data` |
| --- | --- | --- |
| `deployment.created` | A deployment was made. | `repo_id`, `deployment` (without `payload`) |
| `deployment_status.created` | A deployment got a status. | `repo_id`, `deployment` (without `payload`), `deployment_status` |

`deployment.succeeded` and `deployment.failed` are sent for g1t.page builds
only.

## MCP

The [`workflow` tool](/reference/mcp/#workflow) has an action for each route:

| Action | Route |
| --- | --- |
| `list_deployments` | `GET /repos/{owner}/{name}/deployments` |
| `get_deployment` | `GET /repos/{owner}/{name}/deployments/{id}` |
| `create_deployment` | `POST /repos/{owner}/{name}/deployments` |
| `deployment_statuses` | `GET /repos/{owner}/{name}/deployments/{id}/statuses` |
| `create_deployment_status` | `POST /repos/{owner}/{name}/deployments/{id}/statuses` |
| `list_environments` | `GET /repos/{owner}/{name}/environments` |
| `get_environment` | `GET /repos/{owner}/{name}/environments/{environment}` |
| `update_environment` | `PUT /repos/{owner}/{name}/environments/{environment}` |
| `delete_environment` | `DELETE /repos/{owner}/{name}/environments/{environment}` |

They take the repository as `repo`, written `owner/name`, and the same
fields as the routes.

## On the site

- **The Deployments page**, `g1t.sh/<owner>/<project>/deployments`, shows
  a card for each environment: its state, address, commit, ref, who
  deployed it and from where, when, and how many deployments it has had.
  Below is every deployment, newest first, filtered by **Environment**,
  **State**, **Source**, **Creator** and **Ref**. Projects deployed to
  g1t.page manage their apps under **On g1t.page** on the same page.
- **A deployment's page**, `g1t.sh/<owner>/<project>/deployments/<id>`,
  shows its statuses in order, links to its log and run, and its payload.
  Only the newest status can show as still under way; a `queued` or
  `in_progress` one that a later status followed shows as over.
- **Every link to where something runs**, a g1t.page address, an
  environment's URL, a pull request's preview or a project's homepage,
  opens in a new tab, wherever on the site it appears.
- **The repository's code page** and **the project's overview** show a
  **Deployments** panel with how many there are, and each environment's
  latest deployment and when. It links to the Deployments page.
- **The project's overview** shows a production environment deployed
  elsewhere in its production card: its address, state, commit and when it
  went up.
