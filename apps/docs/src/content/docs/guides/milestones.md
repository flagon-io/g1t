---
title: Milestones
description: Gather issues and pull requests under a goal and a due date, and see how much of it is done.
---

A milestone gathers issues and pull requests under one goal, such as a
release, with an optional due date. Its page shows everything in it and how
far along it is: the share of its issues and pull requests that are
closed. A merged pull request counts as closed.

## Make a milestone

You need the Triage [role](/guides/access-and-roles/) or higher.

1. Open the project's **Issues**, then **Milestones**.
2. Choose **New milestone**.
3. Give it a title, unique in the repository, and if you like a due date
   and a description. The description is Markdown.
4. Choose **Create milestone**.

Milestones are numbered from 1 in each repository, apart from issues and
pull requests. The number is in its address:
`g1t.sh/<owner>/<repo>/milestones/3`.

## Put an issue or a pull request in one

1. Open the issue or pull request.
2. In the sidebar, choose the settings icon beside **Milestone**.
3. Pick a milestone, or **Clear milestone** to take it out.

An item is in at most one milestone. Moving it is noted in the
conversation, and is an `issue.milestoned` or `issue.demilestoned` event
(`pull.milestoned` and `pull.demilestoned` on a pull request). With the
Triage role you can also choose a milestone on **New issue**.

## Follow its progress

**Milestones** lists open milestones soonest due first, then those without
a due date; **Closed** lists the rest, most recently closed first. Each
shows its due date, how many of its items are open and closed, and a bar
of how much is done. One whose due date has passed says how late it is.

A milestone's page lists its open and closed issues and pull requests,
newest first. On **Issues** or **Pull requests**, choose **Milestone** to
filter the list by one; the address keeps it as `?milestone=3`.

## Change, close or delete one

With the Triage role or higher, on **Milestones** or a milestone's page:

| To | Do this |
| --- | --- |
| Change its title, due date or description | **Edit**, on its page. |
| Close it, once it is done | **Close**. **Reopen** opens it again. |
| Delete it | **Delete**. What was in it stays as it is, in no milestone. This cannot be undone. |

## From the API

| To | REST | MCP |
| --- | --- | --- |
| List milestones | `GET /repos/{owner}/{name}/milestones`, `state` to filter | `repository` `list_milestones` |
| Get one with its items | `GET /repos/{owner}/{name}/milestones/{milestone}` | `repository` `get_milestone` |
| Make one | `POST /repos/{owner}/{name}/milestones` | `repository` `create_milestone` |
| Change one | `PATCH /repos/{owner}/{name}/milestones/{milestone}` | `repository` `update_milestone` |
| Delete one | `DELETE /repos/{owner}/{name}/milestones/{milestone}` | `repository` `delete_milestone` |

A milestone has `number`, `title`, `description`, `due_on` (`YYYY-MM-DD`),
`state` (`open` or `closed`), `open_items` and `closed_items`. Send
`"due_on": ""` to clear a due date, and `"state": "closed"` to close it.

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/milestones \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Launch", "due_on": "2026-10-14"}'
```

`milestone`, a milestone's number, puts an item in it on `create_issue`,
`update_issue` and `update_pull_request`; `null` or `0` takes it out.
Issues and pull requests carry `milestone` as `{"number", "title"}`, and
`milestone` filters `list_issues` and `list_pull_requests`. Managing
milestones needs a token with `issues:write`.

[Dependency updates](/guides/dependency-updates/) put their pull requests
in the milestone their entry's `milestone` names.
