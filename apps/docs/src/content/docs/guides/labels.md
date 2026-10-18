---
title: Labels
description: Say what a work item or pull request is with colored labels, filter lists by them, and manage your workspace's labels.
---

A label says what a work item or a pull request is: a `bug`, a `question`,
`good first issue`. Labels belong to the workspace, so every repository in
it uses the same ones, each with a name, a color and a description. Work
items and pull requests carry them by name, lists show them as colored
chips, and you can filter either list by one.

## The labels a workspace starts with

A new workspace starts with these:

| Label | Color | Description |
| --- | --- | --- |
| `bug` | `d73a4a` | Something isn't working |
| `documentation` | `0075ca` | Improvements or additions to documentation |
| `duplicate` | `cfd3d7` | This work item or pull request already exists |
| `enhancement` | `a2eeef` | New feature or request |
| `good first issue` | `7057ff` | Good for newcomers |
| `help wanted` | `008672` | Extra attention is needed |
| `invalid` | `e4e669` | This doesn't seem right |
| `question` | `d876e3` | Further information is requested |
| `wontfix` | `ffffff` | This will not be worked on |
| `dependencies` | `0366d6` | Updates a dependency |
| `security` | `ee0701` | A security fix or a vulnerability |

Labels used to belong to each repository. When they moved to the
workspace, labels with the same name became one, and the one made first
kept its color and description; see
[Issues became work items](/about/issues-became-work-items/#labels-and-milestones).
To add the defaults a workspace lacks:

1. Open **Work**, then **Labels**.
2. Choose **Add the default labels**.

Labels the workspace has already are left as they are.

## Put labels on a work item or a pull request

1. Open the work item or pull request.
2. In the sidebar, choose the settings icon beside **Labels**.
3. Tick labels on and off. Type to find one by its name or description.
4. Close the menu. The labels save as it closes.

Each label put on or taken off is noted in the conversation, and is a
`work_item.labeled` or `work_item.unlabeled` event (`pull.labeled` and
`pull.unlabeled` on a pull request).

Who may do this:

- The author of a work item or a pull request, and whoever asked g1t for
  one, may use the workspace's labels on it.
- Anyone with the Triage [role](/guides/access-and-roles/) or higher may
  label anything, and make a label as they go: type a name the workspace
  does not have, and choose **Create**.

A work item or a pull request carries at most 20 labels.

You can label a work item as you open it, too: tick labels on **New work
item**, or with the Write role, type new ones beside them.

## Filter by a label

On **Work** or **Pull requests**, choose **Label** and pick one. The
address keeps it, as `?label=bug`, so the filtered list can be shared. You
can also write it as `?q=label:bug`, with quotes around a name with
spaces: `?q=label:"good first issue"`. **Clear filters** shows everything
again.

## Manage the workspace's labels

Open **Work**, then **Labels**, at `g1t.sh/<workspace>/-/work/labels`. It
lists every label with its description and how many work items and pull
requests carry it; choose a count to see them. Search finds a label by its
name or description.

With the Write role in the workspace or higher you can (applying labels
needs only Triage):

| To | Do this |
| --- | --- |
| Make a label | **New label**: a name (lowercase, at most 50 characters), a description (at most 100), and a color. |
| Change one | **Edit**. Renaming a label renames it on every work item and pull request that carries it, in every repository. |
| Delete one | **Delete**. It comes off everything that carries it. This cannot be undone. |

Names are lowercase and unique in a workspace: `Bug` and `bug` are the
same label.

## Labels and g1t

- [Dependency updates](/guides/dependency-updates/) carry `dependencies`
  and their ecosystem's label (`javascript`, `rust`, `go`, `python`, …)
  unless `labels` in the file says otherwise. Labels the workspace lacks
  are made for them.
- [Workflows](/guides/actions/) can start on `labeled` and `unlabeled`
  activity of `pull_request`.

## From the API

| To | REST | MCP |
| --- | --- | --- |
| List labels | `GET /workspaces/{workspace}/labels` | `workspace` `list_labels` |
| Make one | `POST /workspaces/{workspace}/labels` | `workspace` `create_label` |
| Change one | `PATCH /workspaces/{workspace}/labels/{label}` | `workspace` `update_label` |
| Delete one | `DELETE /workspaces/{workspace}/labels/{label}` | `workspace` `delete_label` |
| Add the defaults | `POST /workspaces/{workspace}/labels/defaults` | `workspace` `add_default_labels` |

URL-encode a label's spaces in a path: `good%20first%20issue`.

```sh
curl -X POST https://api.g1t.sh/workspaces/acme/labels \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "needs design", "color": "fbca04"}'
```

`labels` on the work item routes (`POST /workspaces/{workspace}/work` and
`PATCH /workspaces/{workspace}/work/{number}`, the `work_item` tool's
`create` and `update`) and on `update_pull_request` set an item's labels,
and `label` filters `list_work_items` and `list_pull_requests`. Managing
labels needs a token with `work:write`, and listing them `work:read`.
