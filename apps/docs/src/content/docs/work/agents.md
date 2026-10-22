---
title: Working with agents
description: How coding agents, and people at a terminal, work on work items. Load a work item's whole context in one call, claim it, open a pull request for it, and use g1t work, the work_item MCP tool and the REST API. What the Claude Code plugin and the work-on-item skill do.
---

Coding agents work on work items the way people do, through the same
calls: the [g1t CLI](/guides/cli/), the [MCP server](/reference/mcp/) and
the [REST API](/reference/api/). g1t runs no model: work happens in your
own harness, with your own agent, and g1t ties it back to the work item.
To connect one, see [connect a coding agent](/guides/bring-your-own-agent/).

## How an agent works on a work item

1. **Load its context**: `g1t work view 12`, or the `work_item` tool's
   `work`. One call has everything: what done means, where it should land
   and where it has, who is on it, its pull requests and what blocks it.
   See [pick up a work item](#pick-up-a-work-item).
2. **Claim it**: `g1t work claim 12 --note "…"`, or `work_item` `claim`.
   The answer says who else is on it. See
   [claims](/work/claims-and-dependencies/#claims).
3. **Open a pull request for it** in the repository the change is for:
   `g1t pr create --item 12`, or `pull_request` `create` with `item`. See
   [open a pull request for it](#open-a-pull-request-for-it).
4. **Push commits** with the session's trailer,
   `git commit --trailer "G1t-Session: $G1T_SESSION"`, and watch the
   checks: `g1t pr checks --watch`.
5. **Mark it ready** with a summary: `g1t pr ready`, or `pull_request`
   `ready`. When it merges, it [lands the work item](/work/closing/) in
   that repository.
6. **Hand it off** if it stops before the work is done:
   `g1t work handoff 12 --note "…"`.

All along, its [session](/work/sessions/) records what it does, and its
[coordination updates](/work/claims-and-dependencies/#coordination-updates)
say what changed around it.

## Find what to take next

When nobody has said which work item to take, the
[plan](/work/plan/) does: the first one in **Now** that nobody is on, or
else the top of **Next**, skipping work items that are blocked, claimed,
or assigned to someone else. Ask for it with `g1t work next` (`--claim`
claims it too), `work_item` with `"action": "next"` over MCP, or
[`next_work_item`](/reference/api/work-items/next-work-item/). Nothing ready
answers with none: then ask a person what to do, rather than picking
something from Triage or Later.

## Pick up a work item

A work item's **work context** is everything about it in one call:
`g1t work view 12`, `work_item` with `"action": "work"` over MCP, or
[`GET /workspaces/{workspace}/work/{number}/work`](/reference/api/work-items/get-work/):

```sh
curl https://api.g1t.sh/workspaces/acme/work/12/work \
  -H "Authorization: Bearer $G1T_TOKEN"
```

| Field                      | What it holds                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item`                     | The work item, with its description.                                                                                                                                                                                                                                                                                                                                    |
| `definition_of_done`       | The items under its **Definition of done** heading.                                                                                                                                                                                                                                                                                                                     |
| `repos`                    | Its repositories, each with its `role`, whether it has `landed`, its old issue number (`legacy_number`), the `required_checks` its default branch requires, and its `pulls` for the work item. Those still open or draft carry their checks as they stand on the head, `mergeable`, the other pull requests they `overlaps` with, and their place in the merge `queue`. |
| `missing`                  | Its targets that have not landed yet.                                                                                                                                                                                                                                                                                                                                   |
| `suggested_targets`        | Up to five repositories of the workspace it may also need, each with `path` and `why`. See [suggested targets](/work/work-items/#suggested-targets).                                                                                                                                                                                                                    |
| `claims`                   | Who says they are working on it now.                                                                                                                                                                                                                                                                                                                                    |
| `sessions`                 | Sessions on it or its pull requests, or tied to it any other way, subagents included, those still going first; up to 50. Each says how many `subagents` it started.                                                                                                                                                                                                     |
| `blocked_by`               | Each work item it waits on, with that work item's claims and pull requests.                                                                                                                                                                                                                                                                                             |
| `blocks`                   | The work items waiting on it.                                                                                                                                                                                                                                                                                                                                           |
| `decisions`                | [Decision records](/guides/why-blame/#decision-records) on it and its pull requests, newest first; up to 20.                                                                                                                                                                                                                                                            |
| `last_integration_failure` | The latest `integration_failure` decision among them, if any: the combination that failed in the merge queue, the check, the `suspects` and, when it failed on `main` alone, the pull requests that `landed` on `main` since it branched.                                                                                                                               |
| `recent`                   | Its latest 20 coordination events, newest first.                                                                                                                                                                                                                                                                                                                        |

`g1t work view 12` prints the same: its description and definition of
done, its repositories with their pull requests, checks and overlaps,
**Still to land in**, **Suggested targets** (with the
`g1t work link 12 --repo owner/name` that adds one), its claims, sessions,
what blocks it and what it blocks, the last integration failure, its
decisions and what happened lately. A target the work needs that is not
linked yet is worth linking before starting:

```sh
g1t work link 12 --role target --repo acme/docs
```

## Open a pull request for it

`g1t pr create --item 12`, or `pull_request` `create` with `item: 12`,
opens a pull request for the work item in the repository it runs in:

- Without a branch, g1t makes a
  [working copy](/concepts/forks/#working-copies-for-pull-requests) for
  it and opens a **draft**. The answer has the pull request and the git
  remote of its working copy, to clone and push to.
- With a `branch` already pushed, it opens the pull request from it.

Its title is the work item's unless you give one. The work item notes
**opened acme/web#14 for this**, and the repository is linked as
`touched` unless it is already a target. When the pull request merges
into the default branch, it lands the work item there; see
[closing work items](/work/closing/).

```json
{ "name": "pull_request", "arguments": { "action": "create", "repo": "acme/web", "item": 12 } }
```

## Work with no work item yet

Most of what an agent is asked starts without a work item, and a question,
a look around or a quick fix never needs one. The session is recorded
anyway, and shows on [Sessions](/work/sessions/) and the repository's
**Live now**. When the work becomes a change others should know about (a
branch to push, a pull request), the agent looks for its work item
(`g1t work list`, `work_item` `list` or `list_claims`), and claims it. If
there is none, it files one and claims it in one step:

```sh
g1t work claim --title "Preview builds time out on large repositories"
```

See [work with no work item yet](/guides/sessions/#work-with-no-work-item-yet).

## The CLI

`g1t work` works on the current repository's workspace, or the one in
`--workspace` (or the `G1T_WORKSPACE` environment variable). `-R` (or
`--repo`) `owner/name` names a repository instead of the current one: it
filters `g1t work list`, and is the repository `g1t work link` and
`g1t work unlink` act on. Every command takes `--json`.

| Command                   | Does                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `g1t work list`           | Lists open work items. `-R`, `--state` (`open`, `closed` or `all`), `--label`, `--milestone`, `--assignee` and `--author` narrow it; with `-R`, `--role` keeps those linked to the repository in one role.                                                                      |
| `g1t work view N`         | Shows its [work context](#pick-up-a-work-item). `--comments` adds its comments, `--web` opens it in the browser.                                                                                                                                                                |
| `g1t work new`            | Files a work item; `--target` for each repository it should land in, `--label`, `--assignee`, `--milestone`. `--attach FILE` adds an image to its description: uploaded to the repository it is filed from, or, filed in the workspace alone, to the work item once it is open. |
| `g1t work comment N`      | Comments on it. `--attach FILE` uploads an image to the work item and adds it to the comment.                                                                                                                                                                                   |
| `g1t work check N BOX`    | Ticks a box of its description's [task list](/work/task-lists/), by its number or words of its text; `--uncheck` unticks it. Only that box changes.                                                                                                                             |
| `g1t work edit N`         | Changes its title, description, labels, assignees or milestone.                                                                                                                                                                                                                 |
| `g1t work close N`        | Closes it, as completed, or `--reason not_planned`; `--comment` says why. `--commit SHA` names a commit on the default branch that did it, which lands it there. See [closing work items](/work/closing/).                                                                      |
| `g1t work reopen N`       | Opens it again.                                                                                                                                                                                                                                                                 |
| `g1t work link N`         | Links a repository in a role: `--role target` (the default) or `touched`, the current repository or `-R owner/name`.                                                                                                                                                            |
| `g1t work unlink N`       | Unlinks a repository, never its origin.                                                                                                                                                                                                                                         |
| `g1t work claim N`        | Says you are working on it, with `--note` and `--ttl`. With `--title` instead of a number, files a work item and claims it.                                                                                                                                                     |
| `g1t work release N`      | Lets go of your claim.                                                                                                                                                                                                                                                          |
| `g1t work handoff N`      | Hands it to someone else (`--to`), or to anyone, with a `--note`.                                                                                                                                                                                                               |
| `g1t work status`         | The repository's active claims and sessions.                                                                                                                                                                                                                                    |
| `g1t work block N --by M` | Says it waits on work item M; `g1t work unblock N --by M` takes that back.                                                                                                                                                                                                      |
| `g1t work events`         | The repository's events; `--follow` keeps printing them, `--item N` for one work item.                                                                                                                                                                                          |
| `g1t work dispatch N`     | Starts work on it in a session on your own Claude, or prints the Claude Code command for it. See [start a session on your Anthropic account](/guides/sessions/#start-a-session-on-your-anthropic-account).                                                                      |

[CLI commands](/reference/cli/#g1t-work) lists every flag.

## MCP and the API

The MCP server's `work_item` tool takes an `action`: `list`, `get`,
`create`, `update`, `close`, `reopen`, `links`, `link`, `unlink`,
`labels`, `add_labels`, `set_labels`, `remove_labels`, `comment`,
`edit_comment`, `delete_comment`, `react`, `attach`, `decisions`,
`resolve` (what `#N` names), `import`, `work`, `claim`, `release`,
`handoff` and `list_claims`. It takes `workspace` and `number`; `repo` is
optional, as the origin of a new work item, a filter, or to find the
workspace. A workspace's labels and milestones are on the `workspace`
tool, and a repository's work items are the `repository` tool's `work`.
See [MCP tools](/reference/mcp/#work_item).

The REST API has the same under `/workspaces/{workspace}/work`:

| To                                     | REST                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List work items                        | `GET /workspaces/{workspace}/work`                                                                                                                                      |
| File one                               | `POST /workspaces/{workspace}/work`                                                                                                                                     |
| Get one                                | `GET /workspaces/{workspace}/work/{number}`                                                                                                                             |
| Change one                             | `PATCH /workspaces/{workspace}/work/{number}`                                                                                                                           |
| Close or reopen it                     | `POST /workspaces/{workspace}/work/{number}/close` (with `reason`, or `repo` and `commit`), `…/reopen`                                                                  |
| Its repositories                       | `GET /workspaces/{workspace}/work/{number}/links`                                                                                                                       |
| Link or unlink a repository            | `POST` or `DELETE /workspaces/{workspace}/work/{number}/links`                                                                                                          |
| Its labels                             | `GET`, `POST`, `PUT` or `DELETE /workspaces/{workspace}/work/{number}/labels`, `DELETE …/labels/{label}`                                                                |
| Comment                                | `POST /workspaces/{workspace}/work/{number}/comments`; `PATCH` or `DELETE /workspaces/{workspace}/work/comments/{id}`                                                   |
| React                                  | `POST /workspaces/{workspace}/work/{number}/reactions`                                                                                                                  |
| Upload an image for it                 | [`POST /workspaces/{workspace}/work/{number}/attachments`](/reference/api/work-items/upload-work-item-attachment/), with `work:write`; anyone who may comment on it may |
| Its decisions, with its pull requests' | `GET /workspaces/{workspace}/work/{number}/decisions`                                                                                                                   |
| Watch it                               | `GET`, `PUT` or `DELETE /workspaces/{workspace}/work/{number}/subscription`                                                                                             |
| Its work context                       | `GET /workspaces/{workspace}/work/{number}/work`                                                                                                                        |
| Claim, release, hand off               | `POST /workspaces/{workspace}/work/{number}/claim`, `…/release`, `…/handoff`                                                                                            |
| Bring work items in from a tracker     | `POST /workspaces/{workspace}/work/import`                                                                                                                              |
| A repository's work items              | `GET /repos/{owner}/{name}/work`                                                                                                                                        |
| What `#N` names                        | `GET /repos/{owner}/{name}/refs/{number}`, or `GET /workspaces/{workspace}/refs/{number}`                                                                               |
| The workspace's labels and milestones  | `/workspaces/{workspace}/labels`, `/workspaces/{workspace}/milestones`                                                                                                  |

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
`commit` that landed it). Reading work items needs a token with
`work:read`, and changing them `work:write`.

## The Claude Code plugin

The [Claude Code plugin](/guides/claude-code-plugin/) does the
bookkeeping for Claude Code, so Claude works on work items the way this
page describes without being told each time:

- **At the start of a session**, in a working copy of a g1t repository,
  it finds the work item: the one the session claimed before, `G1T_ITEM`,
  or one named by the branch (`42-fix-login`, `item-42`, `fix/42`). It
  gives Claude that work item's context (`g1t work view`) and tells it to
  claim it. With none, it tells Claude to just work, and to claim or file
  a work item only once the work becomes a change.
- **It records the session**: its prompts, its tool calls (never what
  they returned), the files, commits and branches it touched, and each
  subagent as a session of its own.
- **It ties the session to the work item** Claude claims, starts a pull
  request for, or attaches to, and gives Claude `G1T_SESSION` for the
  commit trailer. It never claims anything itself.
- **It shows coordination updates** before Claude's tools and prompts,
  until they are acknowledged.
- It adds g1t's MCP server, the skills below, and the `/g1t:claim`,
  `/g1t:handoff` and `/g1t:status` commands.

The plugin's hooks need the g1t CLI 0.4.0 or later.

### The work-on-item skill

`/g1t:work-on-item 12` (or asking Claude to work on a work item) takes it
from start to merge:

1. Read the work item: `g1t work view 12`.
2. Check who else is on it and what it waits on, carry on an existing pull
   request rather than start another, and link a target the work needs.
3. Claim it, with a note on its scope, the interfaces it touches, what it
   depends on and the checks it will run.
4. Make a branch named after it, `12-…`.
5. Open a draft pull request early: `g1t pr create --item 12 --draft --fill`.
6. Commit with the `G1t-Session` trailer, and push often.
7. Watch the checks (`g1t pr checks --watch`), and read a failure's logs.
8. Mark it ready with a summary, and merge. A pull request that does only
   part of the work says `Part of #12`; the last says `Closes #12`.
9. Hand it off with a note if it stops before the work is done.

Work that has no work item yet starts by looking for one, then
`g1t work claim --title`. Alongside it, the **coordinate** skill keeps a
long session in step with others, and **fix-integration** fixes a pull
request the merge queue found failing together with others. Sessions g1t
starts on your Anthropic account use the same skills.

## Hand a work item to g1t

You can also hand a work item to a session g1t starts for you, on the
workspace's own Anthropic account: **Start a session** on its page,
**Assign to g1t**, `@g1t` in a comment, or `g1t work dispatch 12`. See
[start a session on your Anthropic account](/guides/sessions/#start-a-session-on-your-anthropic-account)
and [assign g1t, or ask it in the thread](/guides/sessions/#assign-g1t-or-ask-it-in-the-thread).
