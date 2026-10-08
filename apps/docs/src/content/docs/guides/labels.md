---
title: Labels
description: Say what an issue or pull request is with colored labels, filter lists by them, and manage a repository's labels.
---

A label says what an issue or a pull request is: a `bug`, a `question`,
`good first issue`. Each repository has its own labels, each with a name,
a color and a description. Issues and pull requests carry them by name,
lists show them as colored chips, and you can filter either list by one.

## The labels a repository starts with

A new repository starts with these:

| Label | Color | Description |
| --- | --- | --- |
| `bug` | `d73a4a` | Something isn't working |
| `documentation` | `0075ca` | Improvements or additions to documentation |
| `duplicate` | `cfd3d7` | This issue or pull request already exists |
| `enhancement` | `a2eeef` | New feature or request |
| `good first issue` | `7057ff` | Good for newcomers |
| `help wanted` | `008672` | Extra attention is needed |
| `invalid` | `e4e669` | This doesn't seem right |
| `question` | `d876e3` | Further information is requested |
| `wontfix` | `ffffff` | This will not be worked on |
| `dependencies` | `0366d6` | Updates a dependency |
| `security` | `ee0701` | A security fix or a vulnerability |

A repository made before labels had colors kept every label its issues
already carried. To give it the defaults too:

1. Open the project's **Issues**, then **Labels**.
2. Choose **Add the default labels**.

Labels the repository has already are left as they are.

## Put labels on an issue or a pull request

1. Open the issue or pull request.
2. In the sidebar, choose the settings icon beside **Labels**.
3. Tick labels on and off. Type to find one by its name or description.
4. Close the menu. The labels save as it closes.

Each label put on or taken off is noted in the conversation, and is an
`issue.labeled` or `issue.unlabeled` event (`pull.labeled` and
`pull.unlabeled` on a pull request).

Who may do this:

- The author of an issue or a pull request, and whoever asked g1t for one,
  may use the repository's labels on it.
- Anyone with the Triage [role](/guides/access-and-roles/) or higher may
  label anything, and make a label as they go: type a name the repository
  does not have, and choose **Create**.

An issue or a pull request carries at most 20 labels.

You can label an issue as you open it, too: tick labels on **New issue**,
or with the Write role, type new ones beside them.

## Filter by a label

On **Issues** or **Pull requests**, choose **Label** and pick one. The
address keeps it, as `?label=bug`, so the filtered list can be shared. You
can also write it as `?q=label:bug`, with quotes around a name with
spaces: `?q=label:"good first issue"`. **Clear filters** shows everything
again.

## Manage a repository's labels

Open **Issues**, then **Labels**, at `g1t.sh/<owner>/<repo>/labels`. It
lists every label with its description and how many issues and pull
requests carry it; choose a count to see them. Search finds a label by its
name or description.

With the Write role or higher you can (applying labels needs only Triage):

| To | Do this |
| --- | --- |
| Make a label | **New label**: a name (lowercase, at most 50 characters), a description (at most 100), and a color. |
| Change one | **Edit**. Renaming a label renames it on every issue and pull request that carries it. |
| Delete one | **Delete**. It comes off everything that carries it. This cannot be undone. |

Names are lowercase and unique in a repository: `Bug` and `bug` are the
same label.

## Labels and g1t

- An [agent rule](/guides/working-with-g1t/) can queue an issue for g1t
  when it is given a label.
- [Dependency updates](/guides/dependency-updates/) carry `dependencies`
  and their ecosystem's label (`javascript`, `rust`, `go`, `python`, …)
  unless `labels` in the file says otherwise. Labels the repository lacks
  are made for them.
- [Workflows](/guides/actions/) can start on `labeled` and `unlabeled`
  activity of `issues` and `pull_request`.

## From the API

| To | REST | MCP |
| --- | --- | --- |
| List labels | `GET /repos/{owner}/{name}/labels` | `repository` `list_labels` |
| Make one | `POST /repos/{owner}/{name}/labels` | `repository` `create_label` |
| Change one | `PATCH /repos/{owner}/{name}/labels/{label}` | `repository` `update_label` |
| Delete one | `DELETE /repos/{owner}/{name}/labels/{label}` | `repository` `delete_label` |
| Add the defaults | `POST /repos/{owner}/{name}/labels/defaults` | `repository` `add_default_labels` |
| An item's labels | `GET /repos/{owner}/{name}/issues/{number}/labels` | `issue` `labels` |
| Add labels | `POST /repos/{owner}/{name}/issues/{number}/labels` | `issue` `add_labels` |
| Replace them | `PUT /repos/{owner}/{name}/issues/{number}/labels` | `issue` `set_labels` |
| Take one off | `DELETE /repos/{owner}/{name}/issues/{number}/labels/{label}` | `issue` `remove_labels` |
| Take all off | `DELETE /repos/{owner}/{name}/issues/{number}/labels` | `issue` `remove_labels` |

The `issues/{number}/labels` routes work on pull requests too, since issues
and pull requests share numbers. URL-encode a label's spaces in a path:
`good%20first%20issue`.

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/issues/12/labels \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"labels": ["bug", "help wanted"]}'
```

`labels` on `create_issue`, `update_issue` and `update_pull_request` set
them as well, and `label` filters `list_issues` and `list_pull_requests`.
Managing labels needs a token with `issues:write`.
