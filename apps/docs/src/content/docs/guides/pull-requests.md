---
title: Pull requests and checks
description: What the merge box shows before a pull request can merge, the checks your workflows report and which ones a merge needs, and conflicts found before anyone tries to merge.
---

At the foot of an open pull request's conversation, the **merge box** says
what stands between it and its target branch: its checks, its reviews,
whether it merges cleanly, and the button that merges it. Everything in it
updates by itself while something is still running.

A pull request g1t made shows **g1t** as its author and **requested by**
the person who asked for it. That person can manage it as its author could,
and cannot approve it; see
[who a pull request is for](/guides/working-with-g1t/#who-a-pull-request-is-for).

## Checks

A pull request's checks are the statuses reported on its head commit. Most
come from the repository's [workflows](/guides/actions/): every workflow
that runs on `pull_request` runs on every pull request's head, whoever
opened it, a person or an agent, and reports a check named after the
workflow. A workflow named `CI` reports the check `CI`; its status context
is `CI / pull_request`, the workflow's name and the event it ran for. Other
parts of g1t report under their own names, such as `g1t / deploy` (or
`g1t / deploy (<project>)`) for a [deployment](/guides/deployments/).

Which checks a merge needs is up to the repository: its
[required status checks](#required-status-checks). The merge box lists
those first:

```text
Required checks: 1 of 2 passing
  CI        failing   Details
  Lint      passing   Details
```

Each required check is **passing**, **failing**, **running**, or
**expected**, "waiting for status to be reported", when nothing has
reported it on the head commit yet. **Details** opens the run that
reported it. Below them are all the other checks, workflow runs job by job,
each with its state and how long it took. A check that is not required is
shown, but never holds a merge.

A workflow job's **Details** opens its log on the run's page, where every
step's output is kept.

### Running them again

People with the Write [role](/guides/access-and-roles/) or higher can press
**Re-run failed jobs** on a workflow run that failed, to run its failed jobs
again on the same commit. Every push to the pull request runs its workflows
again on the new head.

### A repository with no checks

When a repository has no workflows, the merge box says **This repository
has no checks**: nothing proves a change works, for people or for agents.
**Add CI** writes a starter workflow for you; see
[add CI](/guides/actions/#add-ci). The same offer is on the
**Branches and merging** settings page and the **Actions** page.

## Required status checks

Rules for merging belong to the default branch, and hold for every pull
request into it; a pull request into another branch is not held to them
(see [pull requests into other branches](/guides/base-branches/)).
Someone with the Maintain [role](/guides/access-and-roles/)
or higher sets them under the repository's **Settings → Branches and
merging**, in **Branch protection**:

| Setting | Default | What it does |
| --- | --- | --- |
| Require a pull request to change the default branch | Off | Refuses pushes to the default branch; changes reach it only by merging. See [protected branches](/guides/git/#protected-branches). |
| Required status checks | None | The checks that must pass on a pull request's head before it merges. |
| Required approvals | None | How many reviewers must approve before a merge, 0 to 3 on the page (up to 6 from the API). A reviewer who asked for changes blocks it. |
| g1t's approval counts | On | Off means approvals have to come from people. |
| Require review from code owners | Off | On means the owners of every file a pull request changes, as its [CODEOWNERS file](/guides/codeowners/) says, must approve before it merges. See [require review from code owners](/guides/codeowners/#require-review-from-code-owners). |
| Require branches to be up to date before merging | Off | On means a pull request behind the default branch has to catch up, and its checks run again, before it merges. |
| Merge through a queue | Off | See [merge queue](/guides/merge-queue/). |
| Allow bypassing required checks | On | Lets someone who may merge tick **bypass** when merging, to merge without the required checks passing. Off means nobody can. |

### Choosing the checks

**Required status checks** offers the check names reported on the
repository's commits in the last 30 days, each with the events it was seen
for, such as `pull_request` and `merge_group`. Pick from the list, or type a
name that has not reported yet. A repository can require at most 20.

A required check is met by a status of that name on the pull request's head,
whatever event reported it:

| What reported it | What the merge does |
| --- | --- |
| A status that failed | Refused: "The required check CI failed." |
| A status still pending | Held: "The required check CI is still running." |
| Nothing yet | Held: "The required check CI has not reported on this commit yet." |
| Success | Allowed |

The same rule holds wherever a pull request merges: the merge button,
[`merge_pull_request`](/reference/api/pull-requests/merge-pull-request/),
a g1t agent's [automatic merge](/guides/working-with-g1t/#merging-automatically)
and the [merge queue](/guides/merge-queue/). With **Allow bypassing required
checks** on, the merge button has a **bypass** box, and the API takes
`ignore_checks: true`.

A check that only exists once a workflow has run, such as `CI` from a
workflow added in a pull request, appears in the list after that workflow
has run once.

### From the API

```sh
curl https://api.g1t.sh/repos/<workspace>/<repo>/check-names \
  -H "Authorization: Bearer $G1T_TOKEN"
```

[`list_check_names`](/reference/api/repositories/list-check-names/)
returns the names seen in the last 30 days, most recent first, each as
`{name, events, last_seen}`. It needs the `repo:read` scope.

```sh
curl -X PATCH https://api.g1t.sh/repos/<workspace>/<repo>/settings \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"required_checks": ["CI", "g1t / deploy"]}'
```

[`update_repo_settings`](/reference/api/repositories/update-repo-settings/)
takes `required_checks`, which replaces the whole list, along with
`required_approvals`, `count_agent_approvals`, `require_up_to_date`,
`merge_queue`, `allow_ignoring_checks` and `require_code_owner_review`;
[`get_repo_settings`](/reference/api/repositories/get-repo-settings/)
returns them. On the MCP server they are the `repository` tool's
`check_names`, `get_settings` and `update_settings` actions.

## Reviewers

Ask people to review a pull request in the **Reviewers** box on its page,
by username. You can also ask a [team](/guides/teams/), as
`@workspace/team`: everyone in it is asked, or, with the team's
[review assignment](/guides/teams/#review-assignment) on, g1t picks who,
and they are listed beside the team. Asking needs the Triage
[role](/guides/access-and-roles/) or higher, or being the pull request's
author. Nobody is asked to review their own pull request.

When the repository has a [CODEOWNERS file](/guides/codeowners/), the
owners of the files a pull request changes are asked by themselves, and
the pull request shows **Code owners**: who owns which files and whose
approval is still needed.

Through the API, `POST /repos/{owner}/{name}/pulls/{number}/requested_reviewers`
takes `reviewers` (usernames) and `team_reviewers` (teams, as
`workspace/team` or the team's slug), and adds them to whoever is asked
already; `DELETE` on the same route takes requests away. On
the MCP server they are the `pull_request` tool's `request_reviewers` and
`remove_requested_reviewers` actions.

## Conflicts

g1t works out whether a pull request merges cleanly into its target before
anyone tries to merge it, and again whenever either side moves: a push to
the pull request, or anything landing on the target branch.

1. **Without a sandbox.** g1t compares the files the pull request changed
   since it and the target last agreed with the files the target changed
   since then. If they share none, the merge cannot conflict, and that is
   the answer.
2. **With a short probe.** If they share files, a sandbox merges the two
   commits without an agent and pushes nothing, and reports the files that
   conflict. Meanwhile the box says **Checking whether this merges cleanly**,
   and the merge button waits. Probes are metered as sandbox time; each
   pair of commits is probed once, and a repository runs at most
   three at a time, the rest following in turn.

A pull request that conflicts shows **This branch has conflicts that must
be resolved**, the conflicting files, each linked to its diff, and three
ways to resolve them:

- **Resolve with g1t.** g1t merges the target branch in,
  resolves the conflicts keeping what both sides meant, and pushes the
  result. It is told which files conflict. Available to whoever can push to
  the pull request: for a pull request's fork, whoever opened it (whoever
  asked g1t for one it made); for a branch, anyone with the Write role or
  higher.
- **Resolve in the browser.** Coming soon.
- **On the command line.** The box lists the commands, each with a copy
  button. For a pull request from a branch:

  ```sh
  git fetch origin
  git checkout my-branch
  git merge origin/main
  # fix each conflicting file, then
  git add -A && git commit --no-edit
  git push origin my-branch
  ```

  For a pull request in its own fork, clone the fork and pull `main` into
  it instead:

  ```sh
  git clone https://g1t.sh/pulls/<id>.git && cd <id>
  git pull --no-rebase https://g1t.sh/<owner>/<repo>.git main
  ```

While it conflicts, it cannot be merged or added to the
[merge queue](/guides/merge-queue/), and the merge button says so. Once the
fix is pushed, g1t works it out again.

A pull request that only has fallen behind its target, without conflicts,
still merges: merging brings it up to date first, unless the repository
requires pull requests to be up to date.

## Catching up

When the target branch has moved, the merge box says **main has moved since
this was made**. Whoever can push to the pull request (whoever opened it,
or asked g1t for it, for one in its own fork; anyone with the Write
[role](/guides/access-and-roles/) or higher, for a branch) can
press **Catch up with main now**:

1. **When the two changed different files**, g1t merges `main` in itself,
   in a few seconds. The merge commit is named **Merge main into
   *branch***, has the pull request's head and `main`'s head as its
   parents, and is authored and pushed as you. The box then says **Brought
   up to date with main**, and the workflows run again on the
   new commit, as after any push.
2. **When both changed some of the same files**, a sandbox merges `main` in
   with git, and [g1t](/guides/working-with-g1t/) resolves any conflict.
   The box says what is happening (**g1t is resolving conflicts with
   main** when the merge is known to conflict) with the run's live step and
   how long it has taken. It usually takes about a minute. When the result
   is pushed, the box shows the pull request up to date; if the run fails,
   or nothing has been pushed after five minutes, the box says so and
   offers **Try again**. Nothing is pushed by a run that fails.

Either way the merge is pushed only if the pull request's branch is still
where it was when the catch-up started. If someone pushed to it meanwhile,
the catch-up stops with nothing lost, and you can press it again.

The second case needs g1t's agent enabled for the workspace and is
[charged](/guides/usage-and-billing/#what-is-charged) as agent work; the
first is not.

A pull request [g1t](/guides/working-with-g1t/) opened that is found to conflict
is sent back to resolve it by itself, before it is ready.

## From the API

`GET /repos/{owner}/{name}/pulls/{number}` returns, besides the pull request:

| Field | What it is |
| --- | --- |
| `statuses` | What each workflow run, and anything else that reports statuses, said about its head, with a link to the run. |
| `required_checks` | Each check the default branch requires, as it stands on the head: `name`, `state` (`success`, `failure`, `pending`, or `expected` when nothing has reported it yet), `description` and `target_url`. Empty when none are required. |
| `checks` | The latest record against its head from g1t itself, such as the merge queue taking it out, with `earlier_checks` before it. |
| `mergeable` | `clean`, `conflicting`, `checking` or `unknown`. |
| `conflicts` | When conflicting, the files that conflict. |
| `behind` | Whether its target has moved on without it. |
| `reviewers`, `team_reviewers` | The people and the [teams](/guides/teams/#review-requests) asked to review it. |
| `code_owners` | Who owns the files it changes and whose approval is still needed; see [CODEOWNERS](/guides/codeowners/#through-the-api). Absent when its target has no CODEOWNERS file. |

An agent sees the same through the `pull_request` tool's `get` action.
