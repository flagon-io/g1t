---
title: Work items
description: Track any work, a feature, a bug or a chore, as a work item of your workspace. Link it to the repositories it starts in and lands in, number it once for the whole workspace, close it when every repository has landed, and work on it from the site, the CLI, MCP and the API.
---

A work item is anything your team means to do: a feature, a bug, a chore.
It belongs to the workspace, not to one repository, so work that spans a
service, its client and its docs is one item, with one number, one
conversation and one place that says what is done.

**Work** is in the left rail, directly after **Home**, at
`g1t.sh/<workspace>/-/work`. A work item's page is
`g1t.sh/<workspace>/-/work/<number>`.

Work items used to be issues, one repository's each. [Issues became work
items](/about/issues-became-work-items/) says what changed for the ones you
had.

## What a work item has

- a **title** and a **description** in Markdown. Whoever works on it,
  person or agent, works from this text. Say what done means in plain
  words, under a `## Definition of done` heading if you like: it is
  context for whoever works on it and its reviewers, not something a merge
  waits on;
- its **repositories**, each with a role (see below);
- **labels** and a **milestone**, both the workspace's;
- **comments**, **reactions** and **assignees**;
- what it is **blocked by**: other work items that must land first;
- a **state**: open or closed. A closed work item records why:
  `completed` or `not_planned`.

## One number for the workspace

Work items and pull requests share one sequence of numbers per workspace,
so `#12` names exactly one thing in it. Pull requests still live in their
repository, at `g1t.sh/<owner>/<repo>/pull/<number>`, but a new one takes
the workspace's next number. Pull requests opened before work items keep
the numbers they had.

Wherever Markdown shows, in a description, a comment, a commit message or
chat, a reference links to what it names:

| You write | It names |
| --- | --- |
| `#12`, in a repository | That repository's pull request #12, else the work item that was its issue #12, else the workspace's work item #12, else pull request #12 in another of the workspace's repositories |
| `#12`, outside a repository | The workspace's work item #12, else its pull request #12 |
| `owner/name#12` | `#12` as it reads in repository `owner/name` |
| `workspace#12` | Work item or pull request #12 of another workspace |

So old references keep working: `#12` written about an issue before work
items, `owner/repo#12`, and `Closes #12` in a commit, all reach the work
item that issue became.

## Repositories and their roles

A work item links any number of the workspace's repositories, each in one
role:

| Role | Means |
| --- | --- |
| `origin` | The repository it was filed in. A work item opened from a repository has one; one opened on **Work** itself has none. |
| `target` | A repository the work is meant to land in. |
| `touched` | A repository where a pull request or commit for it landed or is in progress. g1t adds these itself, when a pull request is opened for the work item or a commit names it. |

A work item's page lists its repositories with their roles, each with its
pull requests for the item and whether it has **landed**. Under them,
**Suggested** names repositories it may also need, each with why: work
items like it landed there before, its CODEOWNERS cover what the item
talks about, or sessions on the item touched it. Choose **Add as target**
to link one.

With the Triage role or higher, choose **Link a repository** to add one
in a role, and the cross beside a repository to unlink it. Each is noted in
the conversation, and is a `work_item.linked` or `work_item.unlinked`
event.

## Closing a work item

A pull request that merges into its repository's default branch, or a
commit pushed there, marks **its repository** as landed on every work item
it names after a closing keyword (`Closes #12`, `Fixes #12`,
`Resolves #12`; see [Closing work items](/guides/pull-requests/#closing-work-items)).
The work item records it as a **resolution**: the repository, and the pull
request or commit that landed it.

The work item closes as `completed`:

- when it has no target, at the first resolution;
- when it has targets, once every target has landed.

Until then it stays open, and its page says which targets are still
missing. A pull request that does only part of a repository's share says
`Part of #12` instead (or `Refs #12`): it links the pull request to the
work item, and the repository as touched, without landing anything.

A work item in another workspace is never closed by your repositories:
`Closes other-workspace#3` does nothing.

You can also close a work item yourself, as `completed` or `not_planned`,
and reopen it. Reopening clears its resolutions.

## Labels and milestones

Labels and milestones belong to the workspace, and every work item and
pull request in it uses the same ones. See [labels](/guides/labels/) and
[milestones](/guides/milestones/). Both are under **Work**:
**Labels** at `g1t.sh/<workspace>/-/work/labels` and **Milestones** at
`g1t.sh/<workspace>/-/work/milestones`.

## Who sees a work item

- The workspace's members see every work item.
- Anyone who can read a work item's origin repository sees it. Work items
  filed in a public repository are public, and anyone who can take part in
  a public repository can file one there.
- A work item with no origin is seen only by members.

What you can do with one follows your [role](/guides/access-and-roles/):
the higher of your role in the workspace and your role in its origin
repository. Triage labels, assigns and links repositories; the author and
whoever asked for it can edit it.

## The Work list

**Work** lists the workspace's work items, open first, newest first.
Filter it by state, label, milestone, assignee, repository and role (for
example the items a repository is a target of). The address keeps the
filters, so a filtered list can be shared.

Work's sidebar has **Open**, **Assigned to you** and **Closed**, then
**New work item**, **Labels** and **Milestones**. On a phone, the bar
along the bottom is **Home**, **Work**, **Chat**, **Notifications** and
**More**, with **Work** there for every member, Code access or not, and
**Code** first in **More**. Tapping **Work** again opens that sidebar.

A repository's **Work** tab is the same list, filtered to the work items
linked to that repository: `g1t.sh/<workspace>/-/work?repo=<name>`.

## Open a work item

On **Work**, choose **New work item**. Give it a title and a description,
and pick the repositories it should land in, as targets: none, one or
several. Opened from a repository's **Work** tab, that repository is its
origin.

From the CLI, `g1t work new` opens one in the current repository's
workspace, with the repository as its origin:

```sh
g1t work new --title "Sign-in times out on slow networks" --body "…"
g1t work new --title "Rename the flag" --target acme/api --target acme/docs
```

`--target` names a repository it should land in; repeat it for more.
`--workspace`, outside a repository of that workspace, opens one with no
repository as its origin.

## Work on one

Claims, hand-offs, dependencies and sessions are how people and coding
agents work on a work item at once without getting in each other's way;
see [sessions, claims and dependencies](/guides/sessions/). A session is
recorded in the repository it is checked out in, and the work item it
works on is the workspace's.

To open a pull request for a work item, use `g1t pr create --item 12`, or
the `pull_request` tool's `create` with `item: 12`. The pull request's
repository becomes touched on the work item, and the pull request lands it
there when it merges.

## The CLI

`g1t work` works on the current repository's workspace, or the one in
`--workspace` (or the `G1T_WORKSPACE` environment variable). `-R` (or
`--repo`) `owner/name` names a repository instead of the current one:
it filters `g1t work list`, and is the repository `g1t work link` and
`g1t work unlink` act on. Every command takes `--json`.

| Command | Does |
| --- | --- |
| `g1t work list` | Lists open work items. `-R`, `--state`, `--label`, `--milestone`, `--assignee` and `--author` narrow it; with `-R`, `--role` keeps those linked to the repository in one role. |
| `g1t work view N` | Shows the work item with everything about its work: its repositories and what landed, claims, sessions, pull requests, what blocks it, decisions. |
| `g1t work new` | Opens a work item; `--target` for each repository it should land in. `--attach FILE` adds an image to its description: uploaded to the repository it is filed from, or, filed in the workspace alone, to the work item once it is open. |
| `g1t work comment N` | Comments on it. `--attach FILE` uploads an image to the work item and adds it to the comment. |
| `g1t work edit N` | Changes its title, description, labels, assignees or milestone. |
| `g1t work close N` | Closes it, as completed, or `--reason not_planned`. `--commit SHA` names a commit on the default branch that did it, which lands it there. |
| `g1t work reopen N` | Opens it again. |
| `g1t work link N` | Links a repository in a role: `--role target` (the default) or `touched`, the current repository or `-R owner/name`. |
| `g1t work unlink N` | Unlinks a repository, never its origin. |
| `g1t work claim N` | Says you are working on it. With `--title` instead of a number, opens a work item and claims it. |
| `g1t work release N` | Lets go of your claim. |
| `g1t work handoff N` | Hands it to someone else, or to anyone, with a note. |
| `g1t work status` | The repository's active claims and sessions. |
| `g1t work block N --by M` | Says it waits on work item M; `g1t work unblock N --by M` takes that back. |
| `g1t work events` | The repository's events; `--follow` keeps printing them, `--item N` for one work item. |
| `g1t work dispatch N` | Starts work on it in a session on your own Claude, or prints the Claude Code command for it. |

[CLI commands](/reference/cli/#g1t-work) lists every flag.

## MCP and the API

The MCP server's `work_item` tool takes an `action`: `list`, `get`,
`create`, `update`, `close`, `reopen`, `links`, `link`, `unlink`, the
label actions, `comment`, `react`, `attach`, `decisions`, `resolve`, `claim`,
`release`, `handoff`, `work` and `import`, among others. A workspace's
labels and milestones are on the `workspace` tool, and a repository's
work list is the `repository` tool's `work`. It takes
`workspace` and `number`; `repo` is optional, as the origin of a new work
item, a filter, or to find the workspace. See [MCP tools](/reference/mcp/).

The REST API has the same under `/workspaces/{workspace}/work`:

| To | REST |
| --- | --- |
| List work items | `GET /workspaces/{workspace}/work` |
| Open one | `POST /workspaces/{workspace}/work` |
| Get one | `GET /workspaces/{workspace}/work/{number}` |
| Change one | `PATCH /workspaces/{workspace}/work/{number}` |
| Close or reopen it | `POST /workspaces/{workspace}/work/{number}/close`, `…/reopen` |
| Its repositories | `GET /workspaces/{workspace}/work/{number}/links` |
| Link or unlink a repository | `POST` or `DELETE /workspaces/{workspace}/work/{number}/links` |
| Its labels | `GET`, `POST`, `PUT` or `DELETE /workspaces/{workspace}/work/{number}/labels` |
| Comment | `POST /workspaces/{workspace}/work/{number}/comments`; `PATCH` or `DELETE /workspaces/{workspace}/work/comments/{id}` |
| React | `POST /workspaces/{workspace}/work/{number}/reactions` |
| Upload an image for it | [`POST /workspaces/{workspace}/work/{number}/attachments`](/reference/api/work-items/upload-work-item-attachment/), with `work:write`; anyone who may comment on it may |
| Its decisions, with its pull requests' | `GET /workspaces/{workspace}/work/{number}/decisions` |
| Watch it | `GET`, `PUT` or `DELETE /workspaces/{workspace}/work/{number}/subscription` |
| Its work context | `GET /workspaces/{workspace}/work/{number}/work` |
| Claim, release, hand off | `POST /workspaces/{workspace}/work/{number}/claim`, `…/release`, `…/handoff` |
| A repository's work items | `GET /repos/{owner}/{name}/work` |
| What `#N` names | `GET /repos/{owner}/{name}/refs/{number}`, or `GET /workspaces/{workspace}/refs/{number}` |
| The workspace's labels and milestones | `/workspaces/{workspace}/labels`, `/workspaces/{workspace}/milestones` |

```sh
curl -X POST https://api.g1t.sh/workspaces/acme/work \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Sign-in times out", "repo": "acme/web", "targets": ["acme/web", "acme/api"]}'
```

A work item has `workspace`, `number`, `title`, `body`, `state`, `reason`,
`labels`, `milestone`, `assignees`, `blocked_by`, `repos` (each with
`path`, `role`, `landed` and, for one that was an issue, its
`legacy_number`) and `resolutions` (each with `repo` and the `pull` or
`commit` that landed it). Changing work items needs a token with
`work:write`.

Every change is an event, `work_item.opened`, `work_item.closed` and so
on, sent to [webhooks](/guides/webhooks/): a repository's webhooks for the
work items linked to it, a workspace's for all of them.
