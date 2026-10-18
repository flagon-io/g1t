---
title: Milestones
description: Gather work items and pull requests from across your workspace under a goal and a due date, and see how much of it is done.
---

A milestone gathers work items and pull requests under one goal, such as a
release, with an optional due date. Milestones belong to the workspace, so
one can hold work from any of its repositories. Its page shows everything
in it and how far along it is: the share of its work items and pull
requests that are closed. A merged pull request counts as closed.

## Make a milestone

You need the Triage [role](/guides/access-and-roles/) in the workspace or
higher.

1. Open **Work**, then **Milestones**.
2. Choose **New milestone**.
3. Give it a title, unique in the workspace, and if you like a due date
   and a description. The description is Markdown.
4. Choose **Create milestone**.

Milestones are numbered from 1 in each workspace, apart from work items
and pull requests. The number is in its address:
`g1t.sh/<workspace>/-/work/milestones/3`.

Milestones used to belong to each repository. When they moved to the
workspace they were numbered again, and each records the repository it
came from; see
[Issues became work items](/about/issues-became-work-items/#labels-and-milestones).

## Put a work item or a pull request in one

1. Open the work item or pull request.
2. In the sidebar, choose the settings icon beside **Milestone**.
3. Pick a milestone, or **Clear milestone** to take it out.

An item is in at most one milestone. Moving it is noted in the
conversation, and is a `work_item.milestoned` or `work_item.demilestoned`
event (`pull.milestoned` and `pull.demilestoned` on a pull request). With
the Triage role you can also choose a milestone on **New work item**.

## Follow its progress

**Milestones** lists open milestones soonest due first, then those without
a due date; **Closed** lists the rest, most recently closed first. Each
shows its due date, how many of its items are open and closed, and a bar
of how much is done. One whose due date has passed says how late it is.

A milestone's page lists its open and closed work items and pull
requests, newest first. On **Work** or **Pull requests**, choose
**Milestone** to filter the list by one; the address keeps it as
`?milestone=3`.

## Change, close or delete one

With the Write role in the workspace or higher, on **Milestones** or a
milestone's page (putting a work item in one needs only Triage):

| To | Do this |
| --- | --- |
| Change its title, due date or description | **Edit**, on its page. |
| Close it, once it is done | **Close**. **Reopen** opens it again. |
| Delete it | **Delete**. What was in it stays as it is, in no milestone. This cannot be undone. |

## From the API

| To | REST | MCP |
| --- | --- | --- |
| List milestones | `GET /workspaces/{workspace}/milestones`, `state` to filter | `workspace` `list_milestones` |
| Get one with its items | `GET /workspaces/{workspace}/milestones/{milestone}` | `workspace` `get_milestone` |
| Make one | `POST /workspaces/{workspace}/milestones` | `workspace` `create_milestone` |
| Change one | `PATCH /workspaces/{workspace}/milestones/{milestone}` | `workspace` `update_milestone` |
| Delete one | `DELETE /workspaces/{workspace}/milestones/{milestone}` | `workspace` `delete_milestone` |

A milestone has `number`, `title`, `description`, `due_on` (`YYYY-MM-DD`),
`state` (`open` or `closed`), `open_items` and `closed_items`. Send
`"due_on": ""` to clear a due date, and `"state": "closed"` to close it.

```sh
curl -X POST https://api.g1t.sh/workspaces/acme/milestones \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Launch", "due_on": "2026-10-14"}'
```

`milestone`, a milestone's number, puts an item in it when you open or
change a work item (`POST /workspaces/{workspace}/work`,
`PATCH /workspaces/{workspace}/work/{number}`) and on
`update_pull_request`; `null` or `0` takes it out. Work items and pull
requests carry `milestone` as `{"number", "title"}`, and `milestone`
filters `list_work_items` and `list_pull_requests`. Managing milestones
needs a token with `work:write`, and reading them `work:read`.

[Dependency updates](/guides/dependency-updates/) put their pull requests
in the milestone their entry's `milestone` names.
