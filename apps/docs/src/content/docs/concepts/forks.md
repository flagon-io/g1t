---
title: Forks and working copies
description: What a fork is, who can see it and what it costs; why a pull request on g1t gets a working copy of its own, and when a branch is the better choice.
---

g1t has two kinds of copy of a repository, made for different reasons:

- A **fork** is a repository someone copied into their own workspace. It
  belongs to them, lives at its own address, and remembers the repository
  it came from, its **parent**, so it can be kept up to date and propose
  changes back.
- A **working copy** is the separate repository a pull request gets when it
  is not opened from a branch: an agent's pull request, usually. It belongs
  to that one pull request, is hidden from listings, and is removed a day
  after the pull request closes.

This page explains both. To fork a repository, see
[Forking a repository](/guides/forking-repositories/).

## Forks

A fork is an ordinary repository of the workspace it is in. It has its own
access, settings, rules, issues, pull requests, workflows and project. What
it shares with its parent is where it came from: it can be synced from the
parent and can open pull requests into it.

### What a fork starts with

Forking copies the parent's **code** (its default branch, or every branch
and tag), and the fork's project starts with the **description** of the
parent's project. Nothing else comes with it: no issues or
pull requests, settings, rulesets, secrets, variables, webhooks,
environments, deployments or releases. The fork starts with its own
defaults, and with two things off:

- **Workflows.** A fork runs none of the workflows it copied until someone
  who manages its settings turns them on in **Settings → Actions**. Code you
  copied should not start running on your account, with your secrets and
  your minutes, just because you copied it.
- **Issues.** A fork usually exists to change code and propose it back;
  the conversation stays on the parent. Turn them on in the fork's settings
  if it becomes a project of its own.

Deployments stay off until the fork's own project is set up.

### Who can see a fork

A fork is exactly as visible as its parent: a public repository's forks
are public, a private repository's are private. Within that, the fork's
own workspace and roles decide who can read and write it.

A fork cannot be made public or private on its own. To change who can see
it, [detach it](/guides/forking-repositories/#detach-a-fork) first.

### Forking a private repository

Anyone who can read a public repository may fork it. A private repository
is forked only when its admins allow it under **Settings → Repository →
Forking**, and only by people who can read it. A private fork stays tied to
that access: when whoever made it can no longer read the parent (they left
its workspace, say), their fork is deleted, and its workspace's owners can
restore it for 30 days. A fork made with a workspace's own token is kept.

### What a fork costs

A fork's full size counts toward the
[private repository storage](/guides/usage-and-billing/#private-repository-storage)
of the workspace it goes in, from the moment it is made, however much of it
is the same as its parent. Its workflows' minutes and its other usage are
its own workspace's too.

A free workspace cannot take a private fork that would carry its private
repositories past 1 GB. Public forks, as all public repositories, are not
charged for storage.

### Keeping up with the parent

A fork does not move when its parent does. **Syncing** a branch brings in
the commits the parent's branch of the same name has (the parent's default
branch, for the fork's default branch):

- a branch that is only behind moves forward to match;
- a branch with commits of its own gets a merge commit, when the two sides'
  changes do not clash: edits to the same file merge line by line;
- when both changed the same lines, nothing changes, and you are told which
  files: merge them in a clone and push.

See [Sync a fork](/guides/forking-repositories/#sync-a-fork).

### Proposing changes back

A pull request from a fork is opened on the parent, from a branch of the
fork, and is reviewed, checked and merged there under the parent's rules.
Its checks are the **parent's** workflows, run under the parent's settings,
and the parent's [approval policy](/guides/actions/#pull-requests-from-outside)
decides whether they wait for someone to approve them. Whoever opened the
pull request, its runs get none of the parent's secrets and no token that
can write to it, since anyone who can push to the fork can change the code
they run. The fork's own settings do not change any of that.

### When the parent changes

| The parent | Its forks |
| --- | --- |
| Is made public or private | Are detached: they become ordinary repositories, and keep the visibility they had. |
| Is deleted | Stay forks while it can be restored. When it is purged, they become forks of the repository it was forked from, or ordinary repositories if it was not a fork. |
| Is renamed or transferred | Follow it: they are forks of it at its new address. |
| Is archived | Stay forks; syncing from it still works. |

A detached fork keeps its code, settings and pull requests, and its
workflows and issues stay off unless someone had turned them on. It can no longer be
synced, and it cannot be attached again.

## Working copies for pull requests

A pull request can come from a branch of the repository. But a coding
agent's pull request comes from a **working copy**: a separate repository
that starts as a copy of yours and belongs to that pull request alone. This
part explains why, what it costs, and when to use which.

### The short version

| | Working copy per pull request | Branch in the repository |
| --- | --- | --- |
| Built for | Coding agents, in any number | A person, or a few |
| What the worker can write to | Its own working copy, nothing else | The repository |
| Effect on the repository | None until something merges | A new ref for every piece of work |
| Sees `main` move | Only when it pulls | On the next fetch |
| Merging | Objects are copied in, then `main` moves | `main` moves |

### Why working copies, for agents

#### An agent cannot damage what it cannot write to

To push to a branch, an agent needs write access to the repository. That
access also covers `main` and every other branch, unless protection rules
are written and kept correct for each one.

An agent working in a working copy holds a credential for that copy. It can
rewrite history, force-push, or delete everything it has, and `main` and
every other pull request are untouched. The limit is structural: it does
not depend on a rule being configured correctly.

#### A thousand pull requests leave the repository unchanged

Every clone and fetch begins with the server listing the repository's refs.
A branch per pull request means a repository with thousands of refs, each
listed to every client on every fetch, and each needing cleanup once the
work is merged or closed.

Working copies add nothing to the repository's branches. A day after a pull
request merges or closes, its working copy is removed, and only its head is
kept in the repository, as `refs/pull/<pull request id>/head`, which clones
and fetches do not download. The repository's branches stay the handful
that describe the project.

#### Each pull request has its own capacity

Storage and request limits apply per repository. A hundred agents pushing to
one repository share one budget and slow each other down. A hundred working
copies have a hundred budgets.

#### Working copies are cheap here

Making a working copy takes one call and is ready in about the time a
branch would be, even for a large repository. Its storage is counted with
the repository it belongs to, and it is gone a day after its pull request
closes.

#### Anyone's agent can contribute

Opening a pull request on a public repository does not need any access to
it. The author pushes to the pull request's working copy, and the
repository's workspace decides whether it merges. This is how open source
has always taken contributions from strangers, applied to agents.

### What working copies cost

They are not free of trade-offs.

- **Falling behind is silent.** A branch sees new commits on `main` at the
  next fetch. A working copy has to pull from the original repository,
  which is a second remote. g1t tells a pull request it is behind when
  someone tries to merge it, and the fix is one pull, but its author has to
  do it.
- **Merging does more work.** Merging from a working copy copies the new
  objects into the repository before moving `main`. From a branch they are
  already there.
- **The remote is a different URL.** Engineers used to pushing a branch to
  `origin` need to push to the pull request's working copy instead.

### When a branch is the better choice

When you are a person working on your own repository, or a small team that
already has write access. Nothing about isolation or scale is at stake, and
a branch is the tool you already know.

Push the branch, open **Pull requests**, choose **New pull request** and
pick it. Or from the API, send `branch` when creating the pull request:

```sh
git push origin my-change
curl -X POST https://api.g1t.sh/repos/<workspace>/<repo>/pulls \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"branch": "my-change", "title": "My change", "issue": 12}'
```

A branch can have one open pull request at a time. Pushing to the branch
updates it.

Without write access, [fork the repository](/guides/forking-repositories/)
and open the pull request from a branch of your fork.

### How this adds up

One person, one change: a branch is right, and g1t keeps it. Someone
outside who wants to keep their own line of work: a fork. Hundreds of
agents, many of them wrong, some of them not yours: the repository should
not carry their weight or trust them with its history. Working copies give
each of them room to work and give `main` one narrow, checked way in.
