---
title: Checks
description: Report what CI and integrations find on a commit as statuses and check runs, see them beside every commit, and require them before a merge.
---

Every commit can carry checks: what your workflows, your CI, your
deployments and any integration say about it. g1t shows them beside the
commit wherever it appears, so you can tell at a glance whether a change
works and how far along it is.

- A green check: every check passed.
- A red cross: at least one failed.
- An amber dot: at least one is still running or queued.

Select the mark to see the list: a headline ("All checks have passed",
"Some checks were not successful" or "Some checks haven't completed yet"),
how many passed, failed and are running, and each check with how it went,
how long it took, and a **Details** link.

## Where checks show

| Page | Where |
| --- | --- |
| **Code** | Beside the latest commit, above the files |
| **Commits** | Beside each commit |
| A commit's page | Beside its hash |
| **Branches** | Beside each branch's latest commit |
| **Tags** | Beside each tagged commit |
| A pull request | Beside its head commit, in the sidebar; its merge box lists them too |
| A project's overview | Beside the latest commit, and each active branch |

A page reads the checks of all its commits at once, after the page itself
has loaded: each mark shows a placeholder until they arrive.

## Statuses and check runs

There are two ways to report a check. Use either, or both.

| | A status | A check run |
| --- | --- | --- |
| What it is | A state for one context on a commit, such as `ci/build` | One run of one check, with a life of its own |
| States | `pending`, `success`, `failure`, `error` | `status`: `queued`, `in_progress`, `completed`; once completed, a `conclusion`: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out` or `action_required` |
| Report | A short `description` and a `target_url` | A `title`, a Markdown `summary` and `text`, up to 1,000 annotations on lines of files, and up to 3 buttons |
| On g1t | Listed with a link to `target_url` | Its own page under the repository, linked from the list |
| Set again | Replaces the context's status on that commit | Update the same run, or create a new one |
| Use it for | A quick pass or fail from any tool | Test, lint and scan results someone needs to read |

Every job of a [workflow](/guides/actions/) run is a check run, named
`Workflow / job (event)` in the list, such as `CI / test (push)`, and its
**Details** opens the job's log. You do not report those: g1t does.

## Report a status

You need a token with the `checks:write` scope (see
[scopes](/guides/authentication/#scopes)) and the Write
[role](/guides/access-and-roles/) on the repository.

```sh
curl -X POST https://api.g1t.sh/repos/<workspace>/<repo>/statuses/<sha> \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "success",
    "context": "ci/build",
    "description": "Build #4821 passed",
    "target_url": "https://ci.example.com/builds/4821"
  }'
```

| Field | Required | What it is |
| --- | --- | --- |
| `state` | Yes | `pending`, `success`, `failure` or `error`. `error` counts as a failure. |
| `context` | No | What reports it, such as `ci/build`; `default` when left out. At most 100 characters. |
| `description` | No | A short word on it, at most 140 characters. |
| `target_url` | No | Where to see more: an `http` or `https` address. |

[`create_commit_status`](/reference/api/checks/create-commit-status/)
returns the status. Set a context again to replace it: report `pending`
when a build starts, then `success` or `failure` when it ends.
[`get_combined_status`](/reference/api/checks/get-combined-status/) gives
a commit's statuses and what they add up to:
`GET /repos/<workspace>/<repo>/commits/<ref>/status`, where `<ref>` is a
commit SHA, a branch or a tag.

## Report a check run

A check run is reported in two steps: create it when the work starts,
then complete it.

1. Create it, in progress:

   ```sh
   curl -X POST https://api.g1t.sh/repos/<workspace>/<repo>/check-runs \
     -H "Authorization: Bearer $G1T_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name": "lint", "head_sha": "<sha>", "status": "in_progress", "details_url": "https://ci.example.com/builds/4821"}'
   ```

   The answer has its `id`, such as `cr_01kq4b7c8d9e0f1g2h3j4k5m6n`.

2. Complete it with a `conclusion`, a report and annotations:

   ```sh
   curl -X PATCH https://api.g1t.sh/repos/<workspace>/<repo>/check-runs/<id> \
     -H "Authorization: Bearer $G1T_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "conclusion": "failure",
       "output": {
         "title": "2 problems",
         "summary": "**2** problems in `src/parse.rs`.",
         "annotations": [
           {"path": "src/parse.rs", "start_line": 42, "end_line": 42, "annotation_level": "warning", "message": "unused variable: `depth`"},
           {"path": "src/parse.rs", "start_line": 57, "end_line": 60, "annotation_level": "failure", "message": "this match is not exhaustive"}
         ]
       }
     }'
   ```

Giving a `conclusion` completes the run; `started_at` and `completed_at`
are filled in when you leave them out. A run can also be created already
completed, in one call.

| Field | What it is |
| --- | --- |
| `name` | The check's name, at most 100 characters. Required to create one. |
| `head_sha` | The commit it is about. Required to create one. |
| `status` | `queued` (the default), `in_progress` or `completed`. |
| `conclusion` | `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out` or `action_required`. |
| `started_at`, `completed_at` | When it started and ended, in RFC 3339. |
| `details_url` | Your own page for it. |
| `external_id` | Your own id for it. |
| `output` | `title`, `summary` and `text` (Markdown, at most 65,535 characters each) and `annotations`. |
| `actions` | Up to 3 buttons: `label` (20 characters), `description` (40) and `identifier` (20). |
| `app` | Who reports it, such as `Codecov`. By default, your token's name. |

### A minimal reporter

This script runs a command and reports it as a check run, from any CI that
has `curl` and `jq`:

```sh
#!/bin/sh
# check.sh <name> <command…>: report a command as a g1t check run.
set -u
name=$1; shift
api="https://api.g1t.sh/repos/$G1T_REPO"
auth="Authorization: Bearer $G1T_TOKEN"

id=$(curl -sf -X POST "$api/check-runs" -H "$auth" -H "Content-Type: application/json" \
  -d "$(jq -n --arg name "$name" --arg sha "$G1T_SHA" '{name: $name, head_sha: $sha, status: "in_progress"}')" | jq -r .id)

if output=$("$@" 2>&1); then conclusion=success; else conclusion=failure; fi

curl -sf -X PATCH "$api/check-runs/$id" -H "$auth" -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$conclusion" --arg log "$(printf '%s' "$output" | tail -c 60000)" \
    '{conclusion: $c, output: {title: $c, summary: ("```\n" + $log + "\n```")}}')" > /dev/null
[ "$conclusion" = success ]
```

```sh
G1T_REPO=acme/web G1T_SHA=$(git rev-parse HEAD) ./check.sh lint npm run lint
```

### Annotations

An annotation points at lines of a file at the run's commit: `path`,
`start_line` and `end_line` (from 1), and for one line, `start_column`
and `end_column`. `annotation_level` is `notice`, `warning` or `failure`;
`message` says what is wrong, `title` names it, and `raw_details` holds
anything longer.

Send at most 50 in one request; each update adds to those the run has,
up to 1,000. On the check run's page they are grouped by file, each
linking to its lines.
[`list_check_run_annotations`](/reference/api/checks/list-check-run-annotations/)
returns them in the order they were reported.

### Buttons

`actions` puts up to 3 buttons on the check run's page, such as **Fix
this** or **Ignore**. When someone with the Write role presses one, g1t
sends your webhook a `check_run.requested_action` event with the button's
`identifier` in `data.requested_action`. What happens next is up to you.

### Check suites

Each reporter's check runs on a commit form one check suite, with a
status and conclusion worked out from its latest runs: in progress while any
is, then the worst conclusion. A workflow run is the suite of its jobs.
[`list_check_suites_for_ref`](/reference/api/checks/list-check-suites-for-ref/)
lists a commit's suites. A suite completing sends `check_suite.completed`.

## From a workflow

A workflow job reports extra check runs with its own `G1T_TOKEN`, given
`checks: write` in its [`permissions:`](/guides/actions/#the-jobs-token). They
report as **g1t Actions**:

```yaml
- name: Report coverage
  if: always()
  env:
    G1T_TOKEN: ${{ secrets.G1T_TOKEN }}
  run: |
    curl -sf -X POST "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/check-runs" \
      -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
      -d "{\"name\": \"coverage\", \"head_sha\": \"$GITHUB_SHA\", \"conclusion\": \"neutral\", \"output\": {\"title\": \"81% covered\", \"summary\": \"Up 2% from main.\"}}"
```

A pull request's runs from someone without the Write role get no token
that can write, so they cannot report checks.

## Required checks

A [required status check](/guides/pull-requests/#required-status-checks),
in branch protection or a [ruleset](/guides/rules/), is met by a status of
its name or a check run of its name alike:

| What reported it | Counts as |
| --- | --- |
| A status `success` | Passing |
| A status `failure` or `error` | Failing |
| A status `pending` | Running: the merge waits |
| A check run not yet completed | Running: the merge waits |
| A check run completed `success`, `neutral` or `skipped` | Passing |
| A check run completed `failure`, `cancelled`, `timed_out` or `action_required` | Failing |
| Nothing yet | Expected: the merge waits |

A workflow is required by its name, such as `CI`, which all its jobs
report under. To require only what was reported through the API, pin the
check to the `api` integration in a ruleset:
`{"context": "lint", "integration": "api"}`.

A pull request [g1t is working on](/guides/working-with-g1t/#seeing-it-through)
goes back to g1t when a check fails, whatever reported it.

## Run again

[`rerequest_check_run`](/reference/api/checks/rerequest-check-run/) and
[`rerequest_check_suite`](/reference/api/checks/rerequest-check-suite/), or
**Re-run** on a check run's page, ask for it to run again. A check run
reported through the API sends its reporter `check_run.rerequested` (or
`check_suite.rerequested`): run it again and report a new check run. A
workflow job's run runs again, which also needs `workflows:write`.

## Webhooks

[Webhooks](/guides/webhooks/) can be sent:

| Event | When |
| --- | --- |
| `status.created` | A status was set on a commit through the API. |
| `check_run.created` | A check run was reported. |
| `check_run.completed` | A check run completed. |
| `check_run.rerequested` | Someone asked for a check run to run again. |
| `check_run.requested_action` | Someone pressed one of a check run's buttons. |
| `check_suite.completed` | Every latest check run of a suite completed. |
| `check_suite.rerequested` | Someone asked for a check suite to run again. |

These are left out of a repository's timeline.

## Who can report checks

| | Can |
| --- | --- |
| Anyone who can read the repository | See its checks, and read them through the API with `checks:read` (no token for a public repository) |
| The Write role and up, with `checks:write` | Report statuses and check runs, and ask for them to run again |
| A workflow job, with `G1T_TOKEN` and `checks: write` or `statuses: write` | The same, in its repository |
| g1t's agents | Read checks, never report them |

An agent's own work is never judged by checks it reported: what a check
says is up to your CI and integrations.

## From the API and MCP

| Route | Operation |
| --- | --- |
| `POST /repos/{owner}/{name}/statuses/{sha}` | [`create_commit_status`](/reference/api/checks/create-commit-status/) |
| `GET /repos/{owner}/{name}/commits/{ref}/statuses` | [`list_commit_statuses`](/reference/api/checks/list-commit-statuses/) |
| `GET /repos/{owner}/{name}/commits/{ref}/status` | [`get_combined_status`](/reference/api/checks/get-combined-status/) |
| `POST /repos/{owner}/{name}/check-runs` | [`create_check_run`](/reference/api/checks/create-check-run/) |
| `PATCH /repos/{owner}/{name}/check-runs/{id}` | [`update_check_run`](/reference/api/checks/update-check-run/) |
| `GET /repos/{owner}/{name}/check-runs/{id}` | [`get_check_run`](/reference/api/checks/get-check-run/) |
| `GET /repos/{owner}/{name}/check-runs/{id}/annotations` | [`list_check_run_annotations`](/reference/api/checks/list-check-run-annotations/) |
| `POST /repos/{owner}/{name}/check-runs/{id}/rerequest` | [`rerequest_check_run`](/reference/api/checks/rerequest-check-run/) |
| `GET /repos/{owner}/{name}/commits/{ref}/check-runs` | [`list_check_runs_for_ref`](/reference/api/checks/list-check-runs-for-ref/) |
| `GET /repos/{owner}/{name}/commits/{ref}/check-suites` | [`list_check_suites_for_ref`](/reference/api/checks/list-check-suites-for-ref/) |
| `GET /repos/{owner}/{name}/check-suites/{id}` | [`get_check_suite`](/reference/api/checks/get-check-suite/) |
| `POST /repos/{owner}/{name}/check-suites/{id}/rerequest` | [`rerequest_check_suite`](/reference/api/checks/rerequest-check-suite/) |

[`list_check_runs_for_ref`](/reference/api/checks/list-check-runs-for-ref/)
gives each name's latest run and each workflow's latest run per event;
`filter=all` gives every one. Narrow it with `check_name`, `status` and
`app` (a reporter's slug; `actions` for workflow jobs).

On the [MCP server](/reference/mcp/#workflow), the `workflow` tool has an
action for each: `combined_status`, `list_statuses`, `set_status`,
`list_check_runs`, `get_check_run`, `check_run_annotations`,
`create_check_run`, `update_check_run`, `rerequest_check_run`,
`list_check_suites`, `get_check_suite` and `rerequest_check_suite`.
