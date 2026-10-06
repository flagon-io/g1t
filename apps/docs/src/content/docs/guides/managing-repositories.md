---
title: Managing a repository
description: Rename a repository or a branch, change its default branch, website and topics, make it public or private, archive it, and delete and restore it.
---

A repository's details and its lifecycle are managed from its
**Settings → Repository** page, at
`g1t.sh/<workspace>/<repo>/settings/repository`, and from the API and MCP
server. This guide covers each change, who can make it, and what happens
when you do.

## The settings page

| Section | What it holds |
| --- | --- |
| **Name** | The repository's name, the second part of its address. |
| **Details** | Its description, website and topics, shown on its page, in [search and Explore](/guides/search/). |
| **Branches** | The default branch, renaming a branch, and a link to **Branches and merging**: [branch protection](/guides/git/#protected-branches), required approvals, the [merge queue](/guides/merge-queue/) and what agents do. What a sandbox may reach is under **Guardrails**; see [guardrails](/guides/guardrails/). |
| **Danger zone** | Change visibility, archive, [transfer](/guides/transferring-repositories/) and delete. Shown to people with the Admin role. |

While a repository is [archived](#archive-a-repository), the settings that
change it are turned off until it is unarchived.

## Who can do what

Each change needs a [role](/guides/access-and-roles/) on the repository.
Owners of its workspace have Admin on it.

| Change | Needs |
| --- | --- |
| Description, website, topics | Maintain |
| Default branch | Admin |
| Rename a branch | Write; Admin for the default branch |
| Rename the repository | Admin |
| Make it public or private | Admin |
| Archive or unarchive | Admin |
| [Transfer](/guides/transferring-repositories/) | An owner of both workspaces |
| Delete, restore and purge | An owner of its workspace |
| See the Recently deleted list | An owner of its workspace |

Renaming the repository or its default branch, changing its visibility
and archiving it are done by a person, not a workspace token.
A g1t agent's token can never use the tools that make these changes,
whatever its run. See [credentials](/guides/g1t-agents/#credentials).

## Edit the details

1. Open the repository's **Settings → Repository**.
2. Under **Details**, change **Description**, **Website** or **Topics**.
3. Choose **Save**.

| Field | Rules |
| --- | --- |
| Description | Up to 200 characters. Empty clears it. |
| Website | An http or https address. `https://` is added when you leave the scheme out. Empty clears it. |
| Topics | Lowercase letters, digits and hyphens, at most 20, each up to 35 characters. Separate them with commas or spaces. |

From the API, call
[`PATCH /repos/{owner}/{name}`](/reference/api/repositories/update-repo/)
with the fields to change. Fields you leave out stay as they are.

```sh
curl -X PATCH https://api.g1t.sh/repos/acme/rocket \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"description": "Launches things.", "website": "rocket.acme.dev", "topics": ["cli", "rust"]}'
```

The MCP tool is `update_repo`, with `repo` and the same fields.

## Change the default branch

The default branch is what the repository opens on, what new clones check
out, what pull requests target, and what branch protection covers.

1. Open the repository's **Settings → Repository**.
2. Under **Branches → Default branch**, pick another branch.
3. Choose **Change default branch**.

The branch must already exist; push it first. When you change it:

- Open pull requests merge into the new default branch.
- New clones check out the new default branch. Existing clones keep the
  branches they have; run `git remote set-head origin -a` to update what
  `origin/HEAD` points at.
- [Branch protection](/guides/git/#protected-branches) covers the new
  default branch.

From the API, send `default_branch` to
[`PATCH /repos/{owner}/{name}`](/reference/api/repositories/update-repo/):

```sh
curl -X PATCH https://api.g1t.sh/repos/acme/rocket \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"default_branch": "trunk"}'
```

The MCP tool is `update_repo`, with `repo` and `default_branch`. When the
same call changes other fields, they are changed first.

## Rename a branch

1. Open the repository's **Settings → Repository**.
2. Under **Branches → Rename a branch**, pick the **Branch** and type its
   **New name**.
3. Choose **Rename branch**.

Renaming the default branch needs Admin. It stays the default under its
new name. When a branch is renamed:

- Open pull requests from it follow it to the new name.
- Web addresses that name the old branch, such as
  `g1t.sh/acme/rocket/tree/old-name`, redirect to the new one until a
  branch with the old name is made again.
- Git remotes do not follow. In each clone, rename the local branch and
  track the new one:

```sh
git branch -m old-name new-name
git fetch origin
git branch -u origin/new-name new-name
git remote set-head origin -a
```

From the API, call
[`POST /repos/{owner}/{name}/branches/{branch}/rename`](/reference/api/repositories/rename-branch/)
with `new_name`. A branch name with slashes goes in the path URL-encoded,
as one segment: `feature/login` is `feature%2Flogin`.

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/branches/feature%2Flogin/rename \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"new_name": "feature/sign-in"}'
```

The MCP tool is `rename_branch`, with `repo`, `branch` and `new_name`.

## Rename a repository

1. Open the repository's **Settings → Repository**.
2. Under **Name**, type the new name. It shows the new address.
3. Choose **Rename**.

A name is lowercase letters, digits, dots, hyphens and underscores, up to
100 characters. It cannot start with a dot or end in `.git`, and no other
repository in the workspace may have it, including one that was
[recently deleted](#restore-a-repository).

Everything stays with the repository: its git data, issues, pull requests,
workflow runs, deployments, settings, secrets and webhooks. Its old address
keeps working, the same way as after a
[transfer](/guides/transferring-repositories/#old-addresses):

| | Behaviour |
| --- | --- |
| Web pages | A permanent redirect (`301`) to the same page at the new address. |
| `git clone`, `fetch`, `pull` and `push` | Redirected to the new remote. Git follows it and prints a warning each time. |
| API and MCP | A call that names the repository by its old name runs against it under its new name. |

Its project follows: a project that had the repository's name takes the
new one, unless another project in the workspace already has it, and its
deployed apps are built again under the new name while the old addresses
redirect.

A redirect stops as soon as a repository is made at the old address.
Update your remotes rather than relying on it:

```sh
git remote set-url origin https://g1t.sh/acme/launcher.git
```

From the API, call
[`POST /repos/{owner}/{name}/rename`](/reference/api/repositories/rename-repo/)
with `name`:

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/rename \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "launcher"}'
```

The MCP tool is `rename_repo`, with `repo` and `name`.

## Change who can see a repository

A public repository can be seen and cloned by anyone, signed in or not. A
private one can be seen only by people with a
[role](/guides/access-and-roles/) on it.

1. Open the repository's **Settings → Repository**.
2. Under **Danger zone → Change visibility**, choose **Make private** or
   **Make public**.
3. Read what changes, type the repository's full name (`<workspace>/<repo>`)
   to confirm, and choose **Make private** or **Make public** again.

| | Making it public | Making it private |
| --- | --- | --- |
| Who can see it | Anyone: its code, issues and pull requests, and cloning it, without signing in. | Only people with a role on it: its workspace's owners, its members (unless the [base permission](/guides/access-and-roles/#the-base-permission) is None), and anyone given a role on it. Anyone else gets a page that says it does not exist. |
| Search and Explore | It is added to [search](/guides/search/) and Explore for everyone. | It leaves search and Explore for everyone outside the workspace. |
| Link previews | Links to it show a preview card with its name and description. | Links to it stop showing a preview card. |
| Storage | It stops counting toward the workspace's private storage. | It counts toward the workspace's private storage. A free workspace has 1 GB; making it private is refused when that would go over. See [what is free](/guides/usage-and-billing/#what-is-free). |

Nothing else changes: its address, members, settings, secrets, webhooks
and deployments stay as they are.

From the API, call
[`POST /repos/{owner}/{name}/visibility`](/reference/api/repositories/set-repo-visibility/)
with `private` and its full name in `confirm`:

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/visibility \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"private": true, "confirm": "acme/rocket"}'
```

The MCP tool is `set_repo_visibility`, with `repo`, `private` and
`confirm`. `private` on
[`PATCH /repos/{owner}/{name}`](/reference/api/repositories/update-repo/)
makes the same change without the confirmation, for people with Admin.

## Archive a repository

Archiving makes a repository read-only. Use it for work that is finished
but should stay readable.

1. Open the repository's **Settings → Repository**.
2. Under **Danger zone**, choose **Archive**.
3. Read what changes and choose **Archive** again.

While it is archived:

| | |
| --- | --- |
| Pushes and merges | Refused, whatever your role, and for agents too. |
| Issues and pull requests | Locked. They stay readable. |
| Agents and workflows | Do not run. |
| Settings | The ones that change the repository are turned off. |
| Deployments | Keep serving. |
| Who can see it | Unchanged. Anyone who could see it still can, and clone it. |

Its page says it is archived, and so do its project's card on the
workspace overview and its card on [Explore](/guides/search/#explore),
with an **archived** label. To undo it, someone with Admin chooses **Unarchive**
in the same place. Pushes, merges, issues, pull requests, agents and
workflows work again; nothing that was refused while it was archived runs
by itself.

From the API, call
[`POST /repos/{owner}/{name}/archive`](/reference/api/repositories/archive-repo/)
or
[`POST /repos/{owner}/{name}/unarchive`](/reference/api/repositories/unarchive-repo/):

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/archive \
  -H "Authorization: Bearer $G1T_TOKEN"
```

The MCP tools are `archive_repo` and `unarchive_repo`, with `repo`. The
repository's `archived_at` field says when it was archived, and is null
when it is not.

## Delete a repository

Deleting takes a repository away at once, but an owner can restore it for
30 days. After that it is purged: removed for good, its git data with it.

1. Open the repository's **Settings → Repository**.
2. Under **Danger zone**, choose **Delete**.
3. Read what happens, type the repository's full name
   (`<workspace>/<repo>`) to confirm, and choose **Delete repository**.

| | While it is deleted | When it is purged |
| --- | --- | --- |
| Its pages, git remote and API | Answer as if it did not exist, for everyone. | The same. |
| Its name | Stays taken: no repository can be made at its address. | Free to use again. |
| Agents and workflows | Stop, and do not start. | |
| Deployments | Taken down. Its `g1t.page` addresses stop serving. | Removed. |
| Custom domains | Kept, and serve nothing. | Removed. |
| Search | Drops it. | |
| Webhooks | The workspace's webhooks are sent `repo.deleted`. | Sent `repo.purged`. |
| Storage | Stops counting toward the workspace's storage. | |
| Git data, issues, pull requests, settings, secrets | Kept, for restoring. | Removed, and cannot be recovered. |

Its entries in the [audit log](/guides/audit-log/) are kept, as for
anything else.

From the API, call
[`DELETE /repos/{owner}/{name}`](/reference/api/repositories/delete-repo/)
with its full name in `confirm`. It returns the deleted repository with
`purge_after`, when it will be purged:

```sh
curl -X DELETE https://api.g1t.sh/repos/acme/rocket \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm": "acme/rocket"}'
```

The MCP tool is `delete_repo`, with `repo` and `confirm`.

To move a repository to another workspace instead of deleting it, see
[transferring a repository](/guides/transferring-repositories/).

## Restore a repository

A workspace's recently deleted repositories are listed for its owners
under **Recently deleted** in the workspace's **Settings → Repositories**,
at `g1t.sh/<workspace>/-/repositories`, each with who deleted it and when
it will be purged.

1. Open the workspace's **Settings → Repositories**.
2. Under **Recently deleted**, find the repository and choose **Restore**.

It comes back at the address it had, as it was when it was deleted: git
data, issues, pull requests, settings, secrets and webhooks. Its
deployments are built again, and its custom domains serve them once they
are live. Agents and workflows run again for new work; they do not catch
up on what they missed.

From the API, list them with
[`GET /workspaces/{workspace}/repos/deleted`](/reference/api/repositories/list-deleted-repos/)
(MCP: `list_deleted_repos`), then call
[`POST /repos/{owner}/{name}/restore`](/reference/api/repositories/restore-repo/)
with the path it had (MCP: `restore_repo`):

```sh
curl https://api.g1t.sh/workspaces/acme/repos/deleted \
  -H "Authorization: Bearer $G1T_TOKEN"

curl -X POST https://api.g1t.sh/repos/acme/rocket/restore \
  -H "Authorization: Bearer $G1T_TOKEN"
```

### Purge a repository now

To remove a deleted repository for good before its 30 days are up, and
free its name:

1. Open the workspace's **Settings → Repositories**.
2. Under **Recently deleted**, choose **Delete permanently** beside it.
3. Type its full name (`<workspace>/<repo>`) to confirm, and choose
   **Delete permanently** again.

This cannot be undone. From the API, call
[`POST /repos/{owner}/{name}/purge`](/reference/api/repositories/purge-repo/)
with its full name in `confirm`:

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/purge \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm": "acme/rocket"}'
```

The MCP tool is `purge_repo`, with `repo` and `confirm`.

A workspace whose only repositories are recently deleted ones can itself
be [deleted](/guides/workspaces/#delete-a-workspace); they are purged with
it.

## When a change is refused

| Response | Why | What to do |
| --- | --- | --- |
| `401 unauthenticated` | No token, or one that is not valid. | Send a personal access token. |
| `403 forbidden` | You are not an owner, for a change that needs one; or a g1t agent's token was used. | Ask an owner of the workspace. |
| `404 not_found` | No such repository or branch, or you cannot see it. For restore and purge: no deleted repository had that path, or it was purged. | Check the path. A deleted repository is named by the path it had. |
| `409 conflict` | The new name is taken in the workspace, by a repository or a recently deleted one; or a branch with the new name exists. | Pick another name, or purge the deleted repository first. |
| `422 invalid` | `confirm` is not the repository's full name; the name, branch name or website is not valid; or the new default branch does not exist. | Type `<workspace>/<repo>` exactly; push the branch first. |
| `402 payment_required` | Making it private would take a free workspace's private storage over 1 GB. | Start [the g1t plan](/guides/usage-and-billing/#the-g1t-plan), or make room first. |

Each refusal comes with a message that says what to do.

## Events and the audit log

Each change is sent to [webhooks](/guides/webhooks/#events) and recorded
in the [audit log](/guides/audit-log/):

| Change | Event |
| --- | --- |
| Description, website, topics, protection | `repo.updated` |
| Visibility | `repo.visibility_changed` |
| Rename | `repo.renamed` |
| Default branch | `repo.default_branch_changed` |
| Branch rename | `branch.renamed` |
| Archive, unarchive | `repo.archived`, `repo.unarchived` |
| Transfer | `repo.transferred` |
| Delete, restore, purge | `repo.deleted`, `repo.restored`, `repo.purged` |
