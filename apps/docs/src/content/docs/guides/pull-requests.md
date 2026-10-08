---
title: Pull requests and checks
description: What the merge box shows before a pull request can merge, the checks your workflows report and which ones a merge needs, drafts, closing and reopening, editing and deleting comments, and conflicts found before anyone tries to merge.
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
`g1t / deploy (<project>)`) for a [deployment](/guides/deployments/), and
your own CI and integrations report statuses and check runs through the
API: see [Checks](/guides/checks/).

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

A closed or merged pull request keeps a checks section in its conversation:
its head commit's workflow runs, job by job, as they ended, each with
**Details** to its log. It is there to read; nothing in it can be re-run,
and it says nothing about merging.

### Other attempts at the same issue

When an issue has more than one pull request, for example because two
agents each tried it, every one of them shows **Other attempts at #N**: the
pull requests for that issue side by side, this one first. Each row has its
state (open, merged, or closed because another was merged instead), its
head commit's checks, where its review stands, its size, and the files it
changes that this one changes too. Pull requests for the same issue are
alternatives, so they are not listed under **Other work is changing the
same files**; that box is for work on other issues, which will collide.

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

What a pull request needs before it merges is set by the
[rulesets](/guides/rules/) that cover the branch it merges into, the
repository's and its workspace's. They hold for every pull request into
that branch, a person's or an agent's. Someone with the Admin
[role](/guides/access-and-roles/) sets them under the
repository's **Settings → Rules**:

| Rule | What it does |
| --- | --- |
| Require a pull request before merging | Refuses pushes to the branch, so changes reach it only by merging. Sets the approvals a merge needs, whether an agent's approval counts, whether approvals before the latest push count, and whether [code owners](/guides/codeowners/#require-review-from-code-owners) must approve. |
| Require status checks to pass | The checks that must pass on a pull request's head before it merges, whether it must be up to date with the branch first, whether someone who may merge can bypass the checks, and optionally only when some paths change. |
| Require the merge queue | See [merge queue](/guides/merge-queue/). |
| Require deployments to succeed | A pull request's head must have deployed to these environments. |

[Rules](/guides/rules/#rules) lists every rule, including those for
agents' changes, confidence, cost, sensitive paths and merge windows.
The merge box on a pull request lists each rule it does not meet yet, with
the ruleset it comes from and what to do about it.

### Choosing the checks

**Require status checks to pass** offers the check names reported on the
repository's commits in the last 30 days. Pick from them, or type a name
that has not reported yet. A check can be pinned to the integration that
must report it, such as workflows or deployments.

A required check is met by a status of that name on the pull request's head,
whatever event reported it:

| What reported it | What the merge does |
| --- | --- |
| A status that failed | Refused: "The required check CI failed." |
| A status still pending | Held: "The required check CI has not finished." |
| Nothing yet | Held: "The required check CI has not reported on its latest commit." |
| Success | Allowed |

The same rule holds wherever a pull request merges: the merge button,
[`merge_pull_request`](/reference/api/pull-requests/merge-pull-request/),
a g1t agent's [automatic merge](/guides/working-with-g1t/#merging-automatically)
and the [merge queue](/guides/merge-queue/). Where the rule lets a merger bypass the
required checks, the merge button has a **bypass** box, and the API takes
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
`check_names`, `get_settings` and `update_settings` actions. They read and
write the "Default branch protection" ruleset; [rulesets](/guides/rules/#from-the-api)
have routes of their own.

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

## Drafts, closing and reopening

A draft is still being worked on: it can be reviewed, but it cannot merge
until it is marked ready for review. Its author, whoever asked g1t for it,
and anyone with the Triage [role](/guides/access-and-roles/) or higher can
move a pull request between these states. An
[archived](/guides/managing-repositories/) repository refuses all of them.

### Convert to a draft

To take a pull request that is ready for review back to a draft, select
**Convert to draft** under the comment box. It leaves the
[merge queue](/guides/merge-queue/) if it is in it, and a merge that was
waiting for it to catch up is called off. Mark it ready again with
**Mark ready for review**.

Only an open pull request can be converted; a draft, a closed or a merged
one is refused with `409`.

### Reopen a pull request

To open a closed pull request again, select **Reopen pull request** under
the comment box. It comes back as it was when it was closed: a draft if it
was closed as a draft, otherwise ready for review. Its checks and whether
it merges cleanly are worked out again.

A merged pull request cannot be reopened. Neither can one from a branch of
the repository whose branch was deleted: push the branch again first.

### From the API

| To | Call | MCP |
| --- | --- | --- |
| Convert to a draft | `POST /repos/{owner}/{name}/pulls/{number}/draft` | `pull_request` with `"action": "draft"` |
| Close | `POST /repos/{owner}/{name}/pulls/{number}/close`, or `PATCH /repos/{owner}/{name}/pulls/{number}` with `"state": "closed"` | `pull_request` with `"action": "close"` |
| Reopen | `POST /repos/{owner}/{name}/pulls/{number}/reopen`, or `PATCH /repos/{owner}/{name}/pulls/{number}` with `"state": "open"` | `pull_request` with `"action": "reopen"` |

Each answers with the pull request as it is now. Converting publishes
`pull.converted_to_draft` and reopening publishes `pull.reopened`, with the
head commit in `commit`; both reach [webhooks](/guides/webhooks/) and can
start [workflows](/guides/actions/).

## Editing and deleting comments

You can edit and delete your own comments on issues and pull requests.
Anyone with the Maintain [role](/guides/access-and-roles/) or higher can
edit and delete anyone's.

- To edit a comment, select **Edit** under it, change the text and select
  **Save**. The comment shows **edited** beside its time.
- To delete a comment, select **Delete** under it and confirm. It is
  removed for everyone and cannot be brought back.

A review that approved or requested changes can be edited but not deleted,
so its verdict stays on record. The notes in the timeline of what happened,
such as "closed this", cannot be edited or deleted.

Through the API, `PATCH /repos/{owner}/{name}/issues/comments/{comment_id}`
with `body` edits a comment and answers with it, and
`DELETE /repos/{owner}/{name}/issues/comments/{comment_id}` deletes it and
answers `204`. Both work for comments on issues and on pull requests; each
comment's `id` is in `GET /repos/{owner}/{name}/issues/{number}` and
`GET /repos/{owner}/{name}/pulls/{number}`. On the MCP server they are the
`issue` tool's `edit_comment` and `delete_comment` actions. Editing
publishes `comment.edited`, with what the comment said before in
`changes.body.from`; deleting publishes `comment.deleted`, with the comment
as it was in `comment`.

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
