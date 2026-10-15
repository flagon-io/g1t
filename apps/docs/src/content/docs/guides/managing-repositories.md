---
title: Managing a repository
description: What a repository's header and Code page show, and how to rename it or a branch, change its default branch, website and topics, make it public or private, archive it, and delete and restore it.
---

A repository's details and its lifecycle are managed from its
**Settings → Repository** page, at
`g1t.sh/<workspace>/<repo>/settings/repository`, and from the API and MCP
server. This guide covers each change, who can make it, and what happens
when you do.

## What it is, and the facts beside the files

The header at the top of every page of a repository (Code, Issues, Pull
requests, Actions, Settings and the rest) shows its project's description,
and its website and topics as you set them under
[Edit the details](#edit-the-details). The website is the project's
homepage when it has one.

A repository has no description of its own: its
[project](/guides/projects/) has, and search, link previews and lists of
repositories show that one. Change it in the project's **Settings →
General**, or with
[`update_project`](/reference/api/projects/update-project/).

The **Code** page shows its files with its facts beside them. On a phone
they come after the files.

| Part | What it shows |
| --- | --- |
| **Readme** | A link to the README shown under the files. |
| **License** | The license its `LICENSE` file holds, such as **MIT license**, linked to the file. **View license** when the text is not one g1t recognizes. `LICENCE`, `COPYING` and `UNLICENSE` are read too, with or without an extension, and an `SPDX-License-Identifier` line says it outright. |
| **Security policy** | A link to `SECURITY.md` at the root, or in `.g1t`, `.github` or `docs`. |
| **Activity** | The repository's [activity](#activity): pushes, merges, new branches and tags. |
| **Stars**, **watching** | How many people [starred](#stars) it, and how many watch all or some of its activity from the [Watch menu](/guides/notifications/). |
| **Releases** | How many [releases](/guides/releases/) it has and the latest. With none published, how many tags it has, linked to its tags, and **Create a new release** for people who can push. |
| **Packages** | [Packages](/guides/packages/) linked to it, or how to publish the first. |
| **Contributors** | How many people and agents made it. Up to five are listed by name with how many commits each made; more show as the most active's avatars. Each opens their card. See [contributors](#contributors). |
| **Languages** | The languages it is written in, by bytes. See [languages](#languages). |

The license, security policy, languages and contributors are read from the
default branch in the background each time it moves, and kept by commit, so
the page never waits for them. A push to the default branch starts the
reading as soon as git has its answer; a branch that moved otherwise, such
as by merging a pull request, is read again when its page is next opened.
A repository pushed to for the first time shows **Reading the default
branch…** for a few seconds.

### Languages

The bar counts the bytes of each language's files on the default branch.
Programming and markup languages count; data such as JSON and YAML, and
prose such as Markdown, do not. TSX counts as TypeScript and JSX as
JavaScript. The sidebar lists every language down to a tenth of a percent,
the largest eight, and gathers the rest as **Other**. Neither do these count:

| Files | Such as |
| --- | --- |
| Vendored | `node_modules/`, `vendor/`, `third_party/`, minified jQuery, and anything under a dot-directory such as `.github/` |
| Generated | `dist/`, `*.min.js`, `*.pb.go`, lockfiles |
| Documentation | `docs/`, `doc/`, `examples/` |

Change what counts with `linguist-*` attributes in the repository's
`.gitattributes` file at the root. A later line wins over an earlier one.

```text
vendor/ours/** -linguist-vendored
*.gen.ts linguist-generated
docs/** -linguist-documentation
*.inc linguist-language=PHP
*.sql linguist-detectable
```

A repository too large to read in full (more than 10,000 files) counts the
files read.

### Contributors

**Insights → Contributors** lists everyone whose commits are on the default
branch, most commits first, with their commits by week, and the
repository's commits per week over the last year.

| Who | How they are matched |
| --- | --- |
| A person | By an address they confirmed on their account, or their noreply address. Several addresses of one account count as one. |
| g1t | Its own commits, by its address. |
| A coding agent or bot | Claude, Codex, Copilot, Gemini, Jules, Cursor, Devin, Aider, Dependabot, Renovate and GitHub Actions, by the address they write on their commits (as author or `Co-authored-by`), never by name. Each shows its maker's mark and a card saying what it is; none is an account on g1t. |
| Anyone else | By the name on their commits, with a card that says they aren't on g1t and how to add the address to your account if the commits are yours. |

The newest 3,000 commits are counted.

### Activity

**Insights → Activity** lists, newest first, who pushed to which branch,
created a branch or tag, deleted a branch (with the commit it pointed to),
merged a pull request, renamed a branch or changed the default branch,
person or agent. A branch's **Activity**, from its **⋯** menu on the
[Branches page](/guides/git/#the-branches-page), keeps only what happened to
that branch (`?branch=<name>`); each page of the repository's activity is
read and filtered, so **Older** may be needed to reach earlier changes.

### Stars

Choose **Star** in the repository's header to keep it in your profile's
**Stars** tab, at `g1t.sh/u/<you>?tab=stars`. The number beside it leads
to who starred it. Anyone signed in who can read a repository can star it;
stars on a private repository are seen only by people who can read it.

## The settings page

| Section | What it holds |
| --- | --- |
| **Name** | The repository's name, the second part of its address. |
| **Details** | Its website and topics, shown on its page, in [search and Explore](/guides/search/). Its description is its project's, on **General**. |
| **Branches** | The default branch, renaming a branch, and a link to **Branches and merging**: [branch protection](/guides/git/#protected-branches), [required status checks](/guides/pull-requests/#required-status-checks), required approvals, and the [merge queue](/guides/merge-queue/). What a sandbox may reach is under **Guardrails**; see [guardrails](/guides/guardrails/). |
| **Artifacts** | How many days the files workflow runs upload are kept, 1 to 90 (14 unless changed). See [artifacts](/guides/actions/#artifacts). |
| **Features** | Whether it has issues. A [fork](/concepts/forks/) starts with them off. |
| **Forking** | For a private repository, whether people who can read it may [fork it](/guides/forking-repositories/#allow-forking-a-private-repository). Public repositories can always be forked. |
| **Danger zone** | Change visibility, archive, [transfer](/guides/transferring-repositories/), [detach a fork](/guides/forking-repositories/#detach-a-fork) and delete. Shown to people with the Admin role. |

While a repository is [archived](#archive-a-repository), the settings that
change it are turned off until it is unarchived.

## Settings

How a repository handles pull requests, commits, pushes and issues. Each
setting is a field of
[`PATCH /repos/{owner}/{name}/settings`](/reference/api/repositories/update-repo-settings/)
(the `repository` tool's `update_settings` action), except
`max_ref_updates`, which is
[`PATCH /repos/{owner}/{name}`](/reference/api/repositories/update-repo/)'s.
Fields you leave out stay as they are. Changing them needs the Maintain
[role](/guides/access-and-roles/) or higher; `max_ref_updates` needs Admin.

### Pull requests

| Setting | Field | Default | What it does |
| --- | --- | --- | --- |
| Allow merge commits | `allow_merge_commit` | On | Pull requests may merge with a merge commit (`merge`). |
| Allow squash merging | `allow_squash_merge` | On | They may merge as one squashed commit (`squash`). |
| Allow rebase merging | `allow_rebase_merge` | On | They may merge by making each commit again on the base (`rebase`). |
| Allow fast-forward merging | `allow_fast_forward` | Off | They may merge by moving the base to their head, with no new commit (`fast_forward`). |
| Default merge method | `default_merge_method` | `merge` | The method the merge button offers first, and the one a merge that names none uses. It must be allowed. |
| Default merge commit message | `merge_commit_message` | `default` | What a merge commit says unless its merger writes it: `default`, `pull_title`, `pull_title_and_description` or `custom`. |
| Default squash commit message | `squash_commit_message` | `default` | What a squash commit says: the same, and `pull_title_and_commits`. |
| Merge and squash commit templates | `merge_commit_template`, `squash_commit_template` | None | The message used with `custom`, with [placeholders](/guides/pull-requests/#commit-messages). An empty string clears it. |
| Always suggest updating branches | `suggest_updating_branches` | On | Offer to update a pull request's branch whenever its base has new commits, not only when it must be up to date. |
| Allow auto-merge | `allow_auto_merge` | On | People may turn on [auto-merge](/guides/pull-requests/#auto-merge) for a pull request. |
| Delete branches when they merge | `delete_branch_on_merge` | Off | A pull request's branch is deleted once it merges. It can be [restored](/guides/pull-requests/#deleting-the-branch) from the pull request. |

At least one method stays allowed. [Rules](/guides/rules/#pull-requests-and-checks)
can narrow the methods for a branch, with `allowed_merge_methods` and
**Require linear history**; they never allow one the repository does not.

### Commits

| Setting | Field | Default | What it does |
| --- | --- | --- | --- |
| Require sign-off on web commits | `require_web_commit_sign_off` | Off | Commits made on g1t (web edits, merge and squash commits) end with a `Signed-off-by:` trailer for whoever made them, agreeing to the repository's terms, commonly the Developer Certificate of Origin. |
| Allow comments on commits | `allow_commit_comments` | On | Anyone who can read the repository may [comment on its commits](/guides/pull-requests/#commit-comments). Off keeps existing comments readable and refuses new ones. |

### Pushes

| Setting | Field | Default | What it does |
| --- | --- | --- | --- |
| Limit how many branches and tags a push can update | `max_ref_updates` | No limit | The most branches and tags one push may create, move or delete, 1 to 1,000. A push that would change more is declined whole, so nothing of it lands: "This push changes N branches and tags; owner/name takes at most M at a time. Push fewer at once." `0` removes the limit. |

### Archives

| Setting | Field | Default | What it does |
| --- | --- | --- | --- |
| Include Git LFS objects in archives | None yet | Off | Coming soon. g1t does not store Git LFS files yet (see [limitations](/about/limitations/)), so archives hold what git stores; the setting is shown, turned off, until it does. |

### Issues

| Setting | Field | Default | What it does |
| --- | --- | --- | --- |
| Issues | `has_issues` | On; off for a [fork](/concepts/forks/) | Whether issues can be opened. Off keeps existing issues readable. `null` goes back to the default. `issues_enabled` says whether they can be opened now. |
| Close issues when pull requests merge | `auto_close_issues` | On | A pull request that merges into the default branch closes its issue and those it names after a [closing keyword](/guides/pull-requests/#closing-issues). |

```sh
curl -X PATCH https://api.g1t.sh/repos/acme/rocket/settings \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"allow_merge_commit": false, "default_merge_method": "squash", "squash_commit_message": "pull_title_and_description", "delete_branch_on_merge": true}'
```

## Who can do what

Each change needs a [role](/guides/access-and-roles/) on the repository.
Owners of its workspace have Admin on it.

| Change | Needs |
| --- | --- |
| Website, topics | Maintain |
| How long artifacts are kept | Maintain |
| [Merge, commit and issue settings](#settings) | Maintain |
| How many branches and tags a push may update | Admin |
| Default branch | Admin |
| Create, delete or restore a branch | Write; the default branch is never deleted. See [branches](/guides/git/#the-branches-page) |
| Rename a branch | Write; Admin for the default branch |
| Rename the repository | Admin |
| Make it public or private | Admin, and the [member privileges](/guides/workspaces/#member-privileges) to allow it, or an owner |
| Archive or unarchive | Admin |
| [Transfer](/guides/transferring-repositories/) | An owner of its workspace, or a member with Admin when the member privileges allow it; and in the other workspace, being able to create a repository |
| Delete | An owner of its workspace, or a member with Admin when the member privileges allow it |
| Restore and purge | An owner of its workspace |
| See the Recently deleted list | An owner of its workspace |

Renaming the repository or its default branch, changing its visibility
and archiving it are done by a person, not a workspace token.

## Edit the details

1. Open the repository's **Settings → Repository**.
2. Under **Details**, change **Website** or **Topics**. The description
   is the project's: change it on **Settings → General**.
3. Choose **Save**.

| Field | Rules |
| --- | --- |
| Website | An http or https address. `https://` is added when you leave the scheme out. Empty clears it. |
| Topics | Lowercase letters, digits and hyphens, at most 20, each up to 35 characters. Separate them with commas or spaces. |

From the API, call
[`PATCH /repos/{owner}/{name}`](/reference/api/repositories/update-repo/)
with the fields to change. Fields you leave out stay as they are.

```sh
curl -X PATCH https://api.g1t.sh/repos/acme/rocket \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"website": "rocket.acme.dev", "topics": ["cli", "rust"]}'
```

Over MCP, it is the `repository` tool's `update` action, with `repo` and
the same fields.

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

Over MCP, it is the `repository` tool's `update` action, with `repo` and
`default_branch`. When the
same call changes other fields, they are changed first.

## Rename a branch

1. Open the repository's **Settings → Repository**.
2. Under **Branches → Rename a branch**, pick the **Branch** and type its
   **New name**.
3. Choose **Rename branch**.

Or, on the repository's [Branches page](/guides/git/#the-branches-page),
open the branch's **⋯** menu and choose **Rename branch**.

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

Over MCP, it is the `repository` tool's `rename_branch` action, with
`repo`, `branch` and `new_name`.

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

Over MCP, it is the `repository` tool's `rename` action, with `repo` and
`name`.

## Change who can see a repository

A public repository can be seen and cloned by anyone, signed in or not. A
private one can be seen only by people with a
[role](/guides/access-and-roles/) on it.

1. Open the repository's **Settings → Repository**.
2. Under **Danger zone → Change visibility**, choose **Make private** or
   **Make public**.
3. Read what changes, type the repository's full name (`<workspace>/<repo>`)
   to confirm, and choose **Make private** or **Make public** again.

A [fork](/concepts/forks/) is as visible as the repository it came from and
cannot change on its own: [detach it](/guides/forking-repositories/#detach-a-fork)
first. When a repository with forks is made public or private, its forks
are detached and keep the visibility they had.

| | Making it public | Making it private |
| --- | --- | --- |
| Who can see it | Anyone: its code, issues and pull requests, and cloning it, without signing in. | Only people with a role on it: its workspace's owners, its members (unless the [base permission](/guides/access-and-roles/#the-base-permission) is None), and anyone given a role on it. Anyone else gets a page that says it does not exist. |
| Search and Explore | It is added to [search](/guides/search/) and Explore for everyone. | It leaves search and Explore for everyone outside the workspace. |
| Link previews | Links to it show a preview card with its name and its project's description. | Links to it stop showing a preview card. |
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

Over MCP, it is the `repository` tool's `set_visibility` action, with
`repo`, `private` and `confirm`. `private` on
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
| Workflows | Do not run. |
| Settings | The ones that change the repository are turned off. |
| Deployments | Keep serving. |
| Who can see it | Unchanged. Anyone who could see it still can, and clone it. |

Its page says it is archived, and so do its project's card on the
workspace overview and its card on [Explore](/guides/search/#explore),
with an **archived** label. To undo it, someone with Admin chooses **Unarchive**
in the same place. Pushes, merges, issues, pull requests and workflows
work again; nothing that was refused while it was archived runs
by itself.

From the API, call
[`POST /repos/{owner}/{name}/archive`](/reference/api/repositories/archive-repo/)
or
[`POST /repos/{owner}/{name}/unarchive`](/reference/api/repositories/unarchive-repo/):

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/archive \
  -H "Authorization: Bearer $G1T_TOKEN"
```

Over MCP, they are the `repository` tool's `archive` and `unarchive`
actions, with `repo`. The
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
| Workflows | Stop, and do not start. | |
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

Over MCP, it is the `repository` tool's `delete` action, with `repo` and
`confirm`.

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
are live. Workflows run again for new work; they do not catch up on what
they missed.

From the API, list them with
[`GET /workspaces/{workspace}/repos/deleted`](/reference/api/repositories/list-deleted-repos/)
(the `repository` tool's `list_deleted` action over MCP), then call
[`POST /repos/{owner}/{name}/restore`](/reference/api/repositories/restore-repo/)
with the path it had (the `restore` action):

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

Over MCP, it is the `repository` tool's `purge` action, with `repo` and
`confirm`.

A workspace whose only repositories are recently deleted ones can itself
be [deleted](/guides/workspaces/#delete-a-workspace); they are purged with
it.

## When a change is refused

| Response | Why | What to do |
| --- | --- | --- |
| `401 unauthenticated` | No token, or one that is not valid. | Send a personal access token. |
| `403 forbidden` | You are not an owner, for a change that needs one; or g1t's token was used. | Ask an owner of the workspace. |
| `404 not_found` | No such repository or branch, or you cannot see it. For restore and purge: no deleted repository had that path, or it was purged. | Check the path. A deleted repository is named by the path it had. |
| `409 conflict` | The new name is taken in the workspace, by a repository or a recently deleted one; or a branch with the new name exists. | Pick another name, or purge the deleted repository first. |
| `422 invalid` | `confirm` is not the repository's full name; the name, branch name or website is not valid; or the new default branch does not exist. | Type `<workspace>/<repo>` exactly; push the branch first. |
| `402 payment_required` | Making it private would take a free workspace's private storage over 1 GB. | Start [the g1t plan](/guides/usage-and-billing/#the-g1t-plan), or make room first. |

Each refusal comes with a message that says what to do.

## From the API and MCP

| Route | MCP | What it does |
| --- | --- | --- |
| [`GET /repos/{owner}/{name}/languages`](/reference/api/repository-insights/get-languages/) | `repository` `languages` | Its languages by bytes, with `color` and `percent`. |
| [`GET /repos/{owner}/{name}/contributors`](/reference/api/repository-insights/list-contributors/) | `repository` `contributors` | Its contributors with `kind`, `commits` and `weeks`. |
| [`GET /repos/{owner}/{name}/license`](/reference/api/repository-insights/get-license/) | `repository` `license` | Its license's `spdx_id`, `name` and `path`. |
| [`GET /repos/{owner}/{name}/stargazers`](/reference/api/stars/list-stargazers/) | `repository` `stargazers` | Who starred it, newest first. |
| [`PUT /user/starred/{owner}/{name}`](/reference/api/stars/star-repo/) | `repository` `star` | Star it. `DELETE` takes the star back; `GET` says whether you did. |
| [`GET /user/starred`](/reference/api/stars/list-starred/) | `repository` `list_starred` | What you starred. |

Answers read from the default branch say which `commit` they are for and
the `head` now; `pending` is true until the first is read. Stars take the
`account:read` and `account:write` scopes; the rest `repo:read`.

## Events and the audit log

Each change is sent to [webhooks](/guides/webhooks/#events) and recorded
in the [audit log](/guides/audit-log/):

| Change | Event |
| --- | --- |
| Website, topics, protection | `repo.updated` |
| Visibility | `repo.visibility_changed` |
| Rename | `repo.renamed` |
| Default branch | `repo.default_branch_changed` |
| Branch rename | `branch.renamed` |
| Branch made or deleted | `git.push`, `git.deleted`; in the audit log, `branch.created`, `branch.deleted` |
| Archive, unarchive | `repo.archived`, `repo.unarchived` |
| Transfer | `repo.transferred` |
| Delete, restore, purge | `repo.deleted`, `repo.restored`, `repo.purged` |
