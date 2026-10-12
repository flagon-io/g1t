# g1t/deploy

Builds the checkout a g1t Actions job is in and puts it on
[g1t.page](https://docs.g1t.sh/guides/deployments/): production when the
run is on the project's production branch, the pull request's preview for
a pull request's run, and the branch's preview for a run on any other
branch.

```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - id: deploy
        uses: g1t/deploy@v1
      - run: echo "Live at ${{ steps.deploy.outputs.url }}"
```

The project must have Deployments on, and the workspace's plan must
include them. The guide,
[Deploying from a workflow](https://docs.g1t.sh/guides/deployments/#deploying-from-a-workflow),
says what is built and when.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `project` | The repository's one project with Deployments on | The project's slug. Needed when the repository has several. |
| `root-dir` | The project's setting | Where the project is in the checkout. |
| `build-command` | The project's setting, else what the build finds | What builds it. |
| `output-dir` | The project's setting, else the first of `dist`, `build`, `out`, `public`, `_site`, `.output/public` | The folder a static build writes. |
| `sha` | The run's commit | The commit this is a build of, for its `g1t / deploy` check. |
| `token` | `${{ github.token }}` | The job's own token. It needs `deployments: write`; any other token is refused. |

## Outputs

| Output | |
| --- | --- |
| `url` | Where the app is served. |
| `deployment-id` | The build's id, `dpl_…`. |
| `kind` | `production` or `preview`. |

## How it works

1. It calls `POST /repos/{owner}/{repo}/deployments/builds` with the job's
   token. g1t checks the plan and the spend limit, decides production or
   preview from the run, sets the commit's `g1t / deploy` check to pending,
   and answers with a token for this build alone and the project's
   variables and secrets for builds of that kind.
2. It masks that token and every secret with `::add-mask::`.
3. It runs `g1t-runner deploy` in the checkout, which installs, builds and
   uploads the app exactly as g1t's own builds do, and reports to g1t with
   the build's token. The build's log is in the step's.

A pull request from a fork or from someone without the Write role, and a
run that had to be approved, build without the project's secrets. The
build's time is the job's Actions time; it is not charged again.

`g1t-runner` is on g1t's machines. Elsewhere (a self-hosted runner), the
action uses the one on `PATH`, or downloads the newest release from
`https://g1t.sh/downloads/runner/latest/` and checks it against the
release's `SHA256SUMS`. It runs on Linux and macOS, with `curl` and either
`jq` or `python3`.
