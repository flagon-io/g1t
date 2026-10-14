---
title: Pull requests and checks
description: What the merge box shows before a pull request can merge, the checks your workflows report and which ones a merge needs, reviewers, sessions, how a large change's files load, drafts, closing and reopening, editing and deleting comments, merge methods, commit messages, auto-merge, closing issues, deleting branches, comments on commits, conflicts, and keeping a branch up to date.
---

At the foot of an open pull request's conversation, the **merge box** says
what stands between it and its target branch: its checks, its reviews,
whether it merges cleanly, and the button that merges it. Everything in it
updates by itself while something is still running.

## Checks

A pull request's checks are the statuses reported on its head commit. Most
come from the repository's [workflows](/guides/actions/): every workflow
that runs on `pull_request` runs on every pull request's head, whoever
opened it, and reports a check named after the
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
people or two coding agents each tried it, every one of them shows **Other attempts at #N**: the
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
has no checks**: nothing proves a change works.
**Add CI** writes a starter workflow for you; see
[add CI](/guides/actions/#add-ci). The same offer is on the
**Branches and merging** settings page and the **Actions** page.

## Required status checks

What a pull request needs before it merges is set by the
[rulesets](/guides/rules/) that cover the branch it merges into, the
repository's and its workspace's. They hold for every pull request into
that branch, whoever opened it. Someone with the Admin
[role](/guides/access-and-roles/) sets them under the
repository's **Settings → Rules**:

| Rule | What it does |
| --- | --- |
| Require a pull request before merging | Refuses pushes to the branch, so changes reach it only by merging. Sets the approvals a merge needs, whether approvals before the latest push count, and whether [code owners](/guides/codeowners/#require-review-from-code-owners) must approve. |
| Require status checks to pass | The checks that must pass on a pull request's head before it merges, whether it must be up to date with the branch first, whether someone who may merge can bypass the checks, and optionally only when some paths change. |
| Require the merge queue | See [merge queue](/guides/merge-queue/). |
| Require deployments to succeed | A pull request's head must have deployed to these environments. |

[Rules](/guides/rules/#rules) lists every rule, including those for
sensitive paths and merge windows.
The merge box on a pull request lists each rule it does not meet yet, with
the ruleset it comes from and what to do about it.

### Choosing the checks

**Require status checks to pass** offers the check names reported on the
repository's commits in the last 30 days. Pick from them, or type a name
that has not reported yet. A check can be pinned to the integration that
must report it, such as workflows or deployments.

A required check is met by a status of that name on the pull request's head,
whatever event reported it, or by a [g1t Actions](/guides/actions/) job
of that name, as on GitHub. A job's check is named as GitHub names it:
the job's `name:` (or its id), with a matrix combination's values after it
in brackets, such as `test` or `build (ubuntu-latest, 22)`, and
`<calling job> / <job>` for a job of a called workflow. A branch rule
copied from GitHub that requires `test` is met by the `test` job, and one
that requires the workflow's name, such as `CI`, is met by the whole run.
Type a job's name to require it: the list offers the names of statuses.
Each job's latest attempt counts. One that was skipped passes the check,
and one that was cancelled fails it.

| What reported it | What the merge does |
| --- | --- |
| A status that failed | Refused: "The required check CI failed." |
| A status still pending | Held: "The required check CI has not finished." |
| Nothing yet | Held: "The required check CI has not reported on its latest commit." |
| Success | Allowed |

The same rule holds wherever a pull request merges: the merge button,
[`merge_pull_request`](/reference/api/pull-requests/merge-pull-request/),
auto-merge and the [merge queue](/guides/merge-queue/). Where the rule lets a merger bypass the
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
`required_approvals`, `require_up_to_date`,
`merge_queue`, `allow_ignoring_checks` and `require_code_owner_review`, and
the repository's [merge settings](/guides/managing-repositories/#pull-requests);
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

## Sessions

A coding agent that works on a pull request can record how it made the
change, entry by entry, with the `pull_request` tool's `record_session`
action. Read it on the pull request's **Session** tab, or with
`read_session`. Blame uses it to say why a line is the way it is. See
[sessions and why-blame](/guides/why-blame/).

## Files changed

The **Files changed** tab lists every file the pull request changes, with
a tree of them beside the diffs and how many lines each adds and removes.
A commit's page and a comparison of two branches show their changes the
same way.

A large change opens quickly however many files it has. The page arrives
with the first files' lines, about 2,000 of them, and the rest of the list
with their counts; each later file's lines load as you scroll near it.
Files with comments on their lines arrive with the page wherever they are,
so their comments are there at once.

A file whose diff is longer than 1,000 lines (a lockfile or generated
code, usually) waits until you press **Load diff**. A link to a file
(`#file-` and its path, such as `…/pull/12?tab=changes#file-src/app.ts`)
opens it and loads its lines at once, however long.

Some changes are too large to read in one go:

- A comparison lists at most 300 files. When more changed, the page says
  so under the last one.
- Lines are read for the first files until about 20,000 have been read.
  The files after that are listed without their counts and load the same
  way as you reach them; until then the toolbar says how many files are
  not counted.
- A file over 512 KB, or a binary one, is listed without its contents.

From the API, `get_pull_request_changes` works the same way: a file left
out has `omitted: true`, and asking again with its path in `paths` (up to
50 at a time) returns its lines.

## Drafts, closing and reopening

A draft is still being worked on: it can be reviewed, but it cannot merge
until it is marked ready for review. Its author and anyone with the Triage [role](/guides/access-and-roles/) or higher can
move a pull request between these states. An
[archived](/guides/managing-repositories/) repository refuses all of them.

### Open a draft

When you open a pull request from a branch, choose **Open as draft** to
say it isn't ready yet. Push to the branch as often as you like; select
**Mark ready for review** when it is. Through the API, send `"draft": true` when you open it.

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

## Commit comments

You can comment on any commit: on the whole commit, under its changes on
the commit's page, or on one line of a file it changed, from the **+**
beside the line. A comment on a line stays with that line of the file as
the commit left it. Anyone who can read the repository can read and write
them, unless the repository has turned commit comments off in its
[settings](/guides/managing-repositories/#commits), which keeps the
comments already made readable.
The commit's author and anyone mentioned are notified.

You can edit and delete your own commit comments; anyone with the Maintain
[role](/guides/access-and-roles/) or higher can delete anyone's.

| To | API | MCP (`repository`) |
| --- | --- | --- |
| List a repository's, newest first | `GET /repos/{owner}/{name}/comments` (`page`, 30 a page) | `list_commit_comments` |
| List a commit's, oldest first | `GET /repos/{owner}/{name}/commits/{sha}/comments` | `commit_comments` |
| Comment | `POST /repos/{owner}/{name}/commits/{sha}/comments` with `body`, and `path` and `line` for a line | `comment_on_commit` |
| Edit | `PATCH /repos/{owner}/{name}/comments/{comment_id}` with `body` | `edit_commit_comment` |
| Delete | `DELETE /repos/{owner}/{name}/comments/{comment_id}`, which answers `204` | `delete_commit_comment` |

Reading needs the `repo:read` scope; commenting, editing and deleting need
`issues:write`, as comments on issues do. Each publishes
`commit_comment.created`, `commit_comment.edited` or
`commit_comment.deleted` to [webhooks](/guides/webhooks/).

## Merging a pull request

A pull request merges once it is ready for review, merges cleanly and meets
every rule for the branch it merges into. Merging needs the Write
[role](/guides/access-and-roles/) or higher. Choose how it merges from the
merge button's menu; the button offers the repository's default method
first.

### Merge methods

| Method | Name in the API | What lands on the base |
| --- | --- | --- |
| Create a merge commit | `merge` | Every commit of the branch, and a merge commit on top whose parents are the base and the branch. |
| Squash and merge | `squash` | One new commit holding everything the pull request changed, authored by whoever the pull request is for (its author, or whoever asked g1t for it), with you as committer and a `Co-authored-by:` trailer for every other author of its commits. |
| Rebase and merge | `rebase` | Each commit of the branch, made again on top of the base in order, keeping its author, date and message, with you as committer and a new hash. Merge commits and commits the base already has are left out. The base moves to the last of them. |
| Fast-forward | `fast_forward` | Nothing new: the base moves to the branch's head, the exact commit its checks ran on. Only possible when the branch contains the base's head; [update the branch](#keeping-it-up-to-date) first otherwise. |

A repository chooses the methods it allows, and which one is offered first,
in its [settings](/guides/managing-repositories/#pull-requests). A
[rule](/guides/rules/#pull-requests-and-checks) for the base branch can narrow them
further: `allowed_merge_methods` lists the methods a merge into that branch
may use, and **Require linear history** refuses `merge`, the one method
that lands a commit with two parents. The merge button offers only the
methods both allow, and a merge by any other method is refused, from the
API and the CLI too.

Merging is line-level: edits to the same file merge when their lines do
not clash. A merge that would clash is refused with nothing changed and
names the files; a `rebase` stops at the first commit that conflicts and
names it too. Resolve the [conflicts](#conflicts) and push, or choose
another method.

g1t merges, squashes and rebases by itself up to 1,000 changed files, 100
files merged line by line (1 MiB each) and 250 commits in a rebase. Beyond
those it refuses and nothing changes: squash or merge instead of rebasing,
or merge the base in a clone.

With the [merge queue](/guides/merge-queue/#how-entries-are-tested) on,
the method chosen (or the queue rule's, when none is) decides how the
pull request's state is built in the queue, and what is tested is what
lands.

### Commit messages

A merge commit and a squash commit get a message. You can write it in the
merge box before you confirm, or with `commit_title` and `commit_message`
in the API. Otherwise the repository's default decides:

| Default | Merge commit | Squash commit |
| --- | --- | --- |
| `default` | **Merge pull request #12 from *owner/branch***, with its title below | Its title with its number, **Greet the caller (#12)**; with more than one commit, a list of their subjects below |
| `pull_title` | Its title, with its number: **Greet the caller (#12)** | The same |
| `pull_title_and_description` | Its title, with its number, and its description below | The same |
| `pull_title_and_commits` | Not offered | Its title, with its number, and each commit's message below |
| `custom` | The repository's merge commit template | The repository's squash commit template |

A template is the whole message, its first line the title. These
placeholders are filled in:

| Placeholder | Becomes |
| --- | --- |
| `{title}` | The pull request's title |
| `{number}` | Its number, without `#` |
| `{body}` | Its description |
| `{branch}` | The branch it merges from |
| `{head_repo}` | The repository that branch is in, as `owner/name` |
| `{base}` | The branch it merges into |
| `{author}` | Its author's username |
| `{commits}` | Its commits' subjects, one `* subject` line each |
| `{issues}` | The issues it closes, as `#12, #14` |
| `{co_authors}` | A `Co-authored-by:` line for each author of its commits, each once |

```text
{title} (#{number})

{body}

Closes {issues}
{co_authors}
```

Each placeholder is filled in once, and what it holds is never read as
another placeholder. A name not in the table stays as written.

Where the repository requires sign-off on web commits, every commit g1t
makes when merging (the merge or squash commit, and each rebased commit)
ends with a `Signed-off-by:` trailer for whoever merged.

### Auto-merge

Turn on auto-merge when a pull request is waiting only on its checks or
reviews: it merges by itself, as you, by the method you chose, as soon as
everything it needs is met. A pull request that may merge already merges at
once instead. The repository must allow auto-merge (on by default), and you
need the Write role, since it merges as you; its author can also turn it
off.

Auto-merge stays on until the pull request merges or closes, until someone
turns it off, or until someone other than whoever turned it on pushes to it,
so a push nobody reviewed never lands by itself. Turning it on and off
publishes `pull.auto_merge_enabled` and `pull.auto_merge_disabled`.

### Closing issues

When a pull request merges into the default branch, it closes the issue it
was made for and every issue its title or description names after a
closing keyword: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`,
`resolve`, `resolves` or `resolved`, in any case, with or without a colon:

```text
Fixes #12. Resolves: #14, closes acme/web#15
```

An issue in another repository is never closed: `owner/name#3` counts only
when it names this one. The pull request's `closes` lists the issues it
will close, in the order named. Merging into any other branch closes
nothing. A repository can turn this off with `auto_close_issues`; the
issues then stay open after the merge.

### Deleting the branch

After a pull request from a branch merges or closes, the merge box offers
**Delete branch**. A repository can have it done on every merge
(`delete_branch_on_merge`), and a merge can ask for it or against it
(`delete_branch`). **Restore branch** makes it again at the pull request's
head commit, as long as no branch of that name exists. Both need the Write
role, or push access to the fork for a fork's branch, and publish
`pull.head_branch_deleted` and `pull.head_branch_restored`.

The default branch, a branch another open pull request merges from, and a
branch a rule protects from deletion are never deleted.

### From the API and the CLI

| To | API | MCP (`pull_request`) | CLI |
| --- | --- | --- | --- |
| Merge | `POST /repos/{owner}/{name}/pulls/{number}/merge` with `merge_method`, `commit_title`, `commit_message`, `sha`, `delete_branch` | `merge` | `g1t pr merge 12 --squash` |
| Turn on auto-merge | `PUT /repos/{owner}/{name}/pulls/{number}/auto-merge` with `merge_method`, `commit_title`, `commit_message` | `enable_auto_merge` | `g1t pr merge 12 --auto --squash` |
| Turn off auto-merge | `DELETE /repos/{owner}/{name}/pulls/{number}/auto-merge` | `disable_auto_merge` | `g1t pr merge 12 --disable-auto` |
| Update its branch | `PUT /repos/{owner}/{name}/pulls/{number}/update-branch` with `update_method`, `expected_head_sha` | `update_branch` | `g1t pr update-branch 12 --rebase` |
| Delete its branch | `DELETE /repos/{owner}/{name}/pulls/{number}/head-branch` | `delete_branch` | `g1t pr merge 12 --delete-branch`, as it merges |
| Restore its branch | `POST /repos/{owner}/{name}/pulls/{number}/head-branch/restore` | `restore_branch` | |
| See how it may merge | `GET /repos/{owner}/{name}/pulls/{number}/merge-options` | `merge_options` | |

Give `sha` (`--match-head-commit` in the CLI) with the head commit you
reviewed, and the merge is refused with `409` if anything was pushed since.
A merged pull request has `merge_method` and `merge_commit`: the merge or
squash commit, the last rebased commit, or its head for a fast-forward.
`auto_merge` holds the method, message, who turned it on and when.

`merge-options` answers what the merge box shows you: the `methods` it may
merge by and the `default_method`, each method's default commit message in
`options` (with `unavailable` saying why one cannot be used now), whether
it is `behind`, `can_fast_forward`, should be offered an update
(`suggest_update`), goes through the `merge_queue`, whether you may turn on
auto-merge (`auto_merge_allowed`), whether deleting its branch starts
ticked (`delete_branch_default`, `can_delete_branch`), and whether commits
made merging it are signed off (`sign_off`).

## Conflicts

g1t works out whether a pull request merges cleanly into its target before
anyone tries to merge it, and again whenever either side moves: a push to
the pull request, or anything landing on the target branch.

1. **Without a sandbox.** g1t compares the files the pull request changed
   since it and the target last agreed with the files the target changed
   since then. If they share none, the merge cannot conflict, and that is
   the answer.
2. **With a short probe.** If they share files, a sandbox merges the two
   commits and pushes nothing, and reports the files that
   conflict. Meanwhile the box says **Checking whether this merges cleanly**,
   and the merge button waits. Probes are charged as runner minutes; each
   pair of commits is probed once, and a repository runs at most
   three at a time, the rest following in turn.

A pull request that conflicts shows **This branch has conflicts that must
be resolved**, the conflicting files, each linked to its diff, and how to
resolve them:

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
requires pull requests to be up to date. Bringing it up to date makes a new
commit, so when the target branch requires checks, the merge box says
**Merging once checks pass** and the pull request lands when the required
checks pass on that commit, with nothing more to press. If one of them fails
there, it is not merged: the pull request says which check failed, and you
push a fix and merge again. With no required checks, it lands as soon as it
is up to date.

If the repository does not answer in time while merging, the merge box says
g1t couldn't reach the repository. Merge again: if the first merge went
through meanwhile, merging again records it rather than merging twice.

## Keeping it up to date

When the branch it merges into has moved, the merge box says **main has
moved since this was made**, and offers to update the branch. A repository
that requires pull requests to be up to date shows it whenever the branch
is behind; otherwise it shows it when the repository suggests updating
branches (on by default), and merging brings the branch up to date by
itself. Whoever can push to the pull request (whoever opened it, for one
in its own fork; anyone with the Write [role](/guides/access-and-roles/)
or higher, for a branch of the repository; whoever can push to the fork,
for a branch of a fork) can update it, two ways:

- **Merge.** g1t merges `main` into the branch. The merge commit is named
  **Merge main into *branch***, has the pull request's head and `main`'s
  head as its parents, and is authored and pushed as you.
- **Rebase.** g1t makes each of the branch's commits again on top of
  `main`'s head and moves the branch there. Its history is rewritten, so
  anyone with the branch checked out must reset to it before pushing
  again.

Either is done in a few seconds when the two sides' changes do not clash:
edits to different lines of the same file merge line by line. The
workflows then run again on the new head, as after any push. The update is
pushed only if the branch is still where it was when it started: if
someone pushed meanwhile, it stops with nothing lost, and you can try again.
When both changed the same lines, or one deleted a file the other changed,
nothing is pushed and the files are named: merge or rebase `main` in
yourself, with the commands under [conflicts](#conflicts). A rebase stops
at the first commit that conflicts and names it.

From the API, `PUT /repos/{owner}/{name}/pulls/{number}/update-branch` takes
`update_method` (`merge`, the default, or `rebase`) and `expected_head_sha`,
and answers with `outcome`: `updated`, `up_to_date`, or `needs_agent` when
nothing was pushed. On the MCP server it is the `pull_request` tool's
`update_branch` action; in the CLI, `g1t pr update-branch 12 --rebase`.

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
| `merge_method`, `merge_commit` | Once merged: how, and the commit its base was left at. |
| `auto_merge` | When auto-merge is on: `method`, `commit_title`, `commit_message`, `enabled_by` and `enabled_at`. |
| `closes` | The issues it closes when it merges into the default branch. |
| `head_branch_deleted` | Whether its branch was deleted after it merged or closed. |
| `reviewers`, `team_reviewers` | The people and the [teams](/guides/teams/#review-requests) asked to review it. |
| `code_owners` | Who owns the files it changes and whose approval is still needed; see [CODEOWNERS](/guides/codeowners/#through-the-api). Absent when its target has no CODEOWNERS file. |

A coding agent sees the same through the `pull_request` tool's `get`
action.
