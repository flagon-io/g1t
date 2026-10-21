---
title: Forking a repository
description: Copy a repository into your own workspace, keep it up to date with the one it came from, and propose changes back.
---

Forking copies a repository into a workspace of yours as a new repository
that remembers where it came from: its **parent**. The fork is yours. You
can push to it, change its settings and run its workflows, and the parent
is untouched until you open a pull request into it and someone there merges
it.

Fork a repository to contribute to one you cannot push to, or to start your
own line of work from someone else's code. To work on a work item in a
repository you can already write to, you do not need a fork: open a pull
request from a branch, or let it [make a working copy](/concepts/forks/#working-copies-for-pull-requests).

See [Forks](/concepts/forks/) for what a fork is, who can see it and what
happens to it when its parent changes.

## Who can fork

- **A public repository**: anyone signed in, into any workspace where they
  can create a public repository.
- **A private repository**: anyone who can read it, once its admins allow
  forking (see [Allow forking a private repository](#allow-forking-a-private-repository)),
  into a workspace where they can create a private repository.

Your email address must be confirmed. An access token made for a workflow
run or an agent's run cannot fork.

## Fork a repository

1. Open the repository and choose **Fork** in its header.
2. Pick the **workspace** to fork it into. Only workspaces where you can
   create a repository of its kind are listed.
3. Keep its **name**, or give the fork another. It starts with
   the parent's **description**; change it later on the fork's
   **Settings → General**.
4. Leave **Copy the `<default>` branch only** on to copy just the default
   branch, or turn it off to copy every branch and tag.
5. Choose **Create fork**.

You land on the fork. Under its name, its header says **forked from** and
links to the parent.

From the CLI, `g1t repo fork` forks the current repository, or the one you
name, into your personal workspace unless you say `--workspace`. With
`--clone` it clones the fork and adds the parent as the remote `upstream`:

```sh
g1t repo fork acme/rocket --workspace ada-labs --clone
```

From the API, call
[`POST /repos/{owner}/{name}/forks`](/reference/api/repositories/fork-repo/):

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/forks \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace": "ada-labs", "default_branch_only": true}'
```

`workspace`, `name` and `default_branch_only` may each be left out: your
personal workspace, the parent's name, and the default branch only. Over MCP, it is the `repository` tool's `fork`
action.

### What the fork gets

| Copied                                      | Not copied                                   |
| ------------------------------------------- | -------------------------------------------- |
| The default branch, or every branch and tag | Work items, pull requests and comments       |
| Its description                             | Settings, rulesets and branch protection     |
|                                             | Secrets, variables and webhooks              |
|                                             | Environments, deployments and custom domains |
|                                             | Releases, packages and stars                 |

Filing work items is off in a new fork, and so are its workflows: a fork runs none of
the workflows it copied until someone turns them on (see
[Turn on workflows](#turn-on-workflows)). Deployments stay off until you turn
them on for the fork.

While a fork is being copied, the repository it is copied from takes no
writes, whatever room its workspace has. A commit from the site, a merge or a
pull request update is refused with **This repository is being copied into a
fork. Try again in a few minutes; if it lasts more than an hour, g1t staff
release it.** A push is refused before any data is sent, and git prints,
before it stops with a `403`:

```text
remote: acme/rocket is being copied into a fork, and takes no pushes until the copy ends. Nothing was pushed; try again in a few minutes. If it lasts more than an hour, g1t staff release it: https://docs.g1t.sh/guides/git/#size-limits
```

A copy ordinarily ends within a few minutes, and writes are taken again. A
fork whose copy timed out may still be copying, so it holds the repository
until its lease of an hour has passed; g1t staff release it then. Once the
copy has taken longer than it should or did not finish cleanly, writes are
refused with **This repository is being copied into a fork, and the copy
has taken longer than it should, or did not finish cleanly, so it takes no
writes until it ends or g1t staff have checked it. That can take a few
hours. Try again later.**, and git prints the same. The merge queue
waits either out: its entries stay queued, saying why, and are
[tried again](/guides/merge-queue/#when-the-repository-takes-no-writes-for-now)
once writes are taken again.

### When forking is refused

| Response               | Why                                                                                                                                | What to do                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `403 forbidden`        | The repository is private and its admins have not allowed forking, or you cannot create a repository of its kind in the workspace. | Ask its admins to allow forking, or pick another workspace.           |
| `409 conflict`         | The workspace already has a repository with that name, or a recently deleted one holds it.                                         | Give the fork another `name`.                                         |
| `402 payment_required` | The fork is private, the workspace is on no plan, and its private repositories would hold more than a free workspace's 1 GB.       | Start the g1t plan in the workspace, or fork into another.            |
| `422 invalid`          | The name is not valid, no workspace was named and you belong to several, or the repository is a pull request's working copy.       | Name a workspace, or fork the repository the working copy belongs to. |

## Sync a fork

A fork does not follow its parent by itself. Syncing brings one of its
branches up to date with the parent's branch of the same name; the fork's
default branch follows the parent's default branch, whatever each is
called.

On the fork's **Code** page, a bar names the parent's branch the branch you
are looking at follows. Choose **Sync fork**, then **Update branch**; the
bar then says what happened.

From the CLI, in a clone of the fork:

```sh
g1t repo sync            # the default branch
g1t repo sync --branch release/2.x
```

From the API, call
[`POST /repos/{owner}/{name}/merge-upstream`](/reference/api/repositories/sync-fork/)
on the fork, with `branch` or without it for the default branch:

```sh
curl -X POST https://api.g1t.sh/repos/ada-labs/rocket/merge-upstream \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"branch": "main"}'
```

Syncing needs the Write role on the fork and read access to its parent. What
happens depends on the branch:

| `status`         | The branch                                                                                                                                                                  | What changed                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `up_to_date`     | Already had every commit of the parent's branch.                                                                                                                            | Nothing.                               |
| `fast_forwarded` | Was only behind.                                                                                                                                                            | It now points where the parent's does. |
| `merged`         | Had commits of its own, and the two sides' changes do not clash: different files, or different lines of the same file.                                                      | A merge commit joins them.             |
| `conflicted`     | Had commits of its own, and both sides changed the same lines (or one deleted a file the other changed, or both changed a binary file), in the files listed in `conflicts`. | Nothing.                               |

The answer also says how many commits the branch was `behind` and `ahead`.
A conflicted branch is yours to merge: pull the parent's branch into your
clone, settle the conflicts and push.

```sh
git pull upstream main
git push origin main
```

Syncing moves the branch on g1t. Pull it into your clone afterwards with
`git pull origin <branch>`. The fork's rules hold as for any push: a
protected branch is not moved by syncing.

## Propose changes to the parent

Push a branch to your fork and open a pull request from it into the parent.

1. On the fork's **Code** page, choose **Contribute** on the bar that names
   the parent's branch.
2. The base is the parent's default branch; pick another of its branches if
   you were asked to.
3. Write a title and description and choose **Create pull request**.

From the CLI, in a clone of the fork whose `upstream` is the parent,
`g1t pr create` opens the pull request on the parent and pushes the branch
to your fork (`origin`). `--head-repo OWNER/NAME` names the fork when the
remotes are set up differently.

```sh
git switch -c fix-link
git commit -am "Fix the broken link"
g1t pr create --fill
```

From the API, create the pull request on the parent with the fork in
`head_repo` and its branch in `branch`:

```sh
curl -X POST https://api.g1t.sh/repos/acme/rocket/pulls \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"head_repo": "ada-labs/rocket", "branch": "fix-link", "title": "Fix the broken link"}'
```

The pull request lives on the parent and is reviewed, checked and merged
there, under the parent's rules. Its checks are the **parent's** workflows,
run under the parent's settings, and a pull request from someone outside
the parent's workspace waits for approval as the parent's
[approval policy](/guides/actions/#pull-requests-from-outside) says.
Whoever opened it, its runs get none of the parent's secrets and no token
that can write to the parent: anyone who can push to the fork can change the
code they run. Pushing to the branch in your fork updates the pull request.

## Allow forking a private repository

A private repository cannot be forked until its admins allow it.

1. Open the repository's **Settings → Repository**.
2. Under **Forking**, turn on **Allow forking**.

From the API, send `allow_forking` to
[`PATCH /repos/{owner}/{name}`](/reference/api/repositories/update-repo/);
it needs the Admin role. Forks of a private repository are private, and stay
private. Clearing the setting stops new forks; forks already made stay, but
a private fork whose maker can no longer read the parent is deleted (and
can be restored for 30 days by its workspace's owners).

Public repositories can always be forked.

## Turn on workflows

A fork's workflows are off when it is made, so nothing it copied runs on
your account until you decide it should. In the fork's
**Settings → Actions**, turn on **Run workflows**. Only someone who manages
the fork's settings (the Admin role) can. See
[Turn workflows on or off](/guides/actions/#turn-workflows-on-or-off).

## List a repository's forks

The repository's **Forks** page lists the forks you can see, newest first.
From the CLI, `g1t repo forks`; from the API,
[`GET /repos/{owner}/{name}/forks`](/reference/api/repositories/list-forks/).

## Detach a fork

Detaching makes a fork an ordinary repository with no parent. Do it when the
fork has become a project of its own, or to change who can see it: a fork stays
exactly as visible as its parent until it is detached.

1. Open the fork's **Settings → Repository**.
2. Under **Danger zone**, choose **Detach fork**, type the fork's full name
   (`<workspace>/<name>`) to confirm, and choose **Detach fork**.

From the CLI, `g1t repo detach`; from the API,
[`POST /repos/{owner}/{name}/detach`](/reference/api/repositories/detach-fork/).
It needs the Admin role on the fork.

A detached fork keeps its code, settings and the pull requests it already
opened into the parent, which stay open there. It can no longer be synced or
open new pull requests into the parent, and its workflows and work items stay
off unless someone had turned them on. It cannot be attached again.
