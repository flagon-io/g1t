---
title: Issues became work items
description: Issues moved out of repositories into workspace-level work items. What happened to the issues, labels and milestones you had, why old links still work, and what to change in scripts and agents.
---

Issues used to belong to one repository each. They are now
[work items](/guides/work-items/), which belong to the workspace and can
link several repositories. **Work**, after **Home** in the left rail,
replaces each repository's **Issues** tab.

## What happened to your issues

Every issue became a work item, with everything it had: its title and
description, comments, reactions, labels, assignees, milestone, claims,
sessions, pull requests and what it was blocked by.

- **It has a new number.** Work items are numbered once for the whole
  workspace, and each issue was given the next number, oldest first, above
  every number any of the workspace's repositories had used. So an issue
  number and a work item number never mean two things.
- **Its repository is its origin.** The work item links the repository
  the issue was in as its `origin`, and keeps the old number there. Its
  pull requests' repositories are linked as `touched`.
- **Pull requests kept their numbers.** New ones take the workspace's next
  number.
- **Who can see it did not change.** Anyone who could read the repository
  still sees the work item filed there. Members of the workspace now see
  every work item in it.

## Old links still work

- `g1t.sh/<owner>/<repo>/issues/12` redirects to the work item that issue
  became, at `g1t.sh/<owner>/-/work/<number>`. **Issues**, **New issue**,
  **Labels** and **Milestones** under a repository redirect to **Work**:
  the repository's issue list to the Work list filtered to it, and its
  labels and milestones to the workspace's. A milestone's own old address,
  `…/milestones/3`, lands on the milestones list, since milestones were
  renumbered.
- A person's **Issues** tab is their **Work items** tab, at
  `g1t.sh/u/<name>/items`.
- `#12` and `owner/repo#12` in descriptions, comments and commit messages
  written before still link to that issue's work item.
- `Closes #12` in history still points at the right work item.
- A repository has no **Work** or **Sessions** page of its own, and
  `g1t.sh/<owner>/<repo>/work` and `…/sessions` are not found. Its claims
  and sessions are on the workspace's
  [Sessions](/guides/sessions/#the-sessions-page), filtered to it:
  `g1t.sh/<workspace>/-/sessions?repo=<name>`. A session's page is
  `g1t.sh/<workspace>/-/sessions/<id>`, and a pull request's recorded
  session is its **Session** tab, `…/pull/<number>/session`.

## Labels and milestones

Labels and milestones now belong to the workspace, too.

- Labels with the same name in several repositories became one label. The
  one made first kept its color and description.
- Milestones were renumbered in the workspace. Each records the
  repository it came from, and every work item and pull request in it
  stayed in it.

## What to change

Nothing that reads links or references needs to change. What calls g1t by
name does:

| Was | Now |
| --- | --- |
| `g1t issue …` | `g1t work …`: `list`, `view`, `new`, `comment`, `edit`, `close`, `reopen` |
| `g1t browse --issues` | `g1t browse --work` |
| `g1t work context N` | `g1t work view N` |
| `g1t work list` (claims and sessions) | `g1t work status` |
| `--issue N` on `g1t pr create`, `g1t session …` and `g1t work events` | `--item N` |
| The MCP `issue` tool | `work_item`, with `workspace` and `number` |
| `pull_request` `create` with `issue` | `pull_request` `create` with `item` |
| `/repos/{owner}/{name}/issues…` | `/workspaces/{workspace}/work…` |
| Repository labels and milestones routes | `/workspaces/{workspace}/labels` and `/workspaces/{workspace}/milestones` |
| `issue.*` events and webhooks | `work_item.*`. Webhooks you had were moved over for you. |
| `issue` and `other_issue` in event payloads | `item` and `other_item` |
| Workflows `on: issues` and `on: issue_comment`, and `permissions: { issues: … }` | `on: work_item`, `on: work_item_comment` and `permissions: { work: … }`. The old names still read but start and grant nothing, and the workflow's page says so. |
| The repository settings `has_issues` and `auto_close_issues` | `has_work_items` and `auto_close_items` |
| Search `is:issue` and `type: issues` | `is:item` and `type: items` |
| `issues:read`, `issues:write` scopes | `work:read`, `work:write` |
| `/g1t:work-on-issue` in Claude Code | `/g1t:work-on-item`, with the plugin 0.3.0 and the CLI 0.4.0 or later |

There are no aliases for the old names: a script that calls one gets an
error, not a silent change. Numbers in your own data, such as a tracker
that stored `owner/repo#12`, still resolve, but a work item's own number
is the one to keep from now on.
