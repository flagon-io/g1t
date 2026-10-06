---
title: Transferring a repository
description: Move a repository to another workspace you own, with its issues, pull requests, deployments and history, while its old address keeps working.
---

Transferring moves a repository from one workspace to another. It keeps its
name, and everything in it moves with it. Its address changes from
`g1t.sh/<old>/<repo>` to `g1t.sh/<new>/<repo>`, and the old address keeps
working as a redirect.

To change only its name and keep it in its workspace,
[rename it](/guides/managing-repositories/#rename-a-repository) instead;
its old address redirects the same way. To be rid of a repository rather
than move it, [delete it](/guides/managing-repositories/#delete-a-repository).

## Who can transfer

You must be an **owner of both workspaces**: the one the repository is in
and the one it moves to. A member of either cannot, and neither can an
access token that belongs to a workspace or a g1t agent's token. Your email
address must be confirmed.

## Transfer a repository

1. Open the repository's **Settings → Repository**.
2. Under **Danger zone**, choose **Transfer**.
3. Pick the workspace to move it to. Only workspaces you own are listed.
4. Read what changes, type the repository's full name (`<old>/<repo>`) to
   confirm, and choose **Transfer**.

You land on the repository's settings at its new address. Everything kept
about it elsewhere in g1t (search, the context hub, deployments and the
rest) follows within a few seconds.

From the API, call
[`POST /repos/{owner}/{name}/transfer`](/reference/api/repositories/transfer-repo/)
with the destination in `to`:

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/transfer \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "acme-labs"}'
```

Over MCP, it is the `repository` tool's `transfer` action, with `repo` and
`to`. A token's owner must
own both workspaces, as on the site.

## When a transfer is refused

| Response | Why | What to do |
| --- | --- | --- |
| `403 forbidden` | You do not own one of the two workspaces, or you are using a workspace or agent token. | Ask an owner of both to transfer it, or use a personal token. |
| `409 conflict` | The destination already has a repository with that name, or a recently deleted one held it. | Rename or move that repository first, or purge the deleted one. |
| `402 payment_required` | The repository is private, the destination is on no plan, and its private repositories would hold more than a free workspace's 1 GB. | Start the g1t plan in the destination, or make the repository public first. |
| `422 invalid` | No destination, or the destination is the workspace it is already in. | Name another workspace. |

## What moves

Everything that belongs to the repository moves with it:

| | |
| --- | --- |
| Code | Every branch and tag. The git data does not move or copy; only the address changes. |
| Issues and pull requests | With their numbers, comments, reviews, labels, sessions and merge queue. |
| Workflows | Workflow runs, their jobs, logs and artifacts. |
| Deployments | The repository's project, its deployments and its custom domains. See [deployments](#deployments). |
| Its own settings | Merge rules, branch protection, guardrails, and the project's memory. |
| Its own secrets and variables | Set on the repository, they move with it. |
| Its own webhooks | They now name the repository by its new path. |
| Agents at work on it | Their runs carry on and are listed in the new workspace. |

These belong to the old workspace and stay with it:

| | |
| --- | --- |
| Workspace secrets and variables | The old workspace's stop reaching the repository; the new workspace's start, if they reach every repository or name this one. |
| Workspace webhooks | The old workspace's stop hearing about the repository; the new one's start. |
| Integrations | Model providers, Sentry, Datadog, Jira and Linear connections stay with their workspace. Connect them in the new one if you need them there. |
| Workspace memory and guardrails | The new workspace's apply from now on. |
| The audit log | What happened before the transfer stays in the old workspace's log. Each workspace's log records the transfer itself. |
| Billing history | See [billing](#billing). |

## Old addresses

The old address keeps working, for as long as nothing else is made there:

| | Behaviour |
| --- | --- |
| Web pages | A permanent redirect (`301`) to the same page at the new address, query string included. A private repository redirects only for people who can see it; anyone else gets a 404, as before. |
| `git clone`, `fetch` and `pull` | Redirected to the new remote. Git follows it and prints a warning each time. |
| `git push` | Redirected the same way: git asks for the push's refs at the old address, follows the redirect, and sends the push to the new one. |
| API and MCP | A call that names the repository by its old path runs against it at its new path. |
| `g1t.page` apps | The old app addresses redirect to the new ones for 90 days. |

A redirect stops as soon as a repository is created at the old address,
whether by the site, the API or a push that creates one. Update your
remotes rather than relying on it:

```sh
git remote set-url origin https://g1t.sh/<new>/<repo>.git
```

Update anything else with the old address in it too: links in READMEs, CI
configuration, API clients and MCP clients.

If the old workspace is later [deleted](/guides/workspaces/#delete-a-workspace),
its name is never given to anyone else, so the redirects keep working.

## Deployments

A `g1t.page` address ends in its workspace's name: production is at
`<project>-<workspace>.g1t.page`. After a transfer, each of the project's
apps (production and every open preview, including one paused by the old
workspace's usage limit) is built again from the same commit under the new
workspace's name. The old address keeps serving until the new one is live,
then redirects to it for 90 days, whatever the old workspace's plan or
limit. Custom domains move with the project and serve the new build.

From the transfer on, the apps are the new workspace's: its plan and usage
limit decide whether they build and serve. If the new workspace cannot
build yet (Deployments are off, or it reached its limit), the rebuild waits
and is tried again until it can.

## Billing

- Usage from the moment of the transfer is charged to the new workspace:
  agent runs, builds, app traffic, git operations and storage.
- What the repository used before stays on the old workspace's bill.
  Runs already under way finish on the bill they started on.
- Storage follows the repository: from the next daily count it is the new
  workspace's private storage.
- A public repository's share of the open-source pool this month moves
  with it.
