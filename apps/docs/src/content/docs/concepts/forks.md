---
title: Forks and branches
description: Why a pull request on g1t gets its own fork, when a branch is the better choice, and what each costs.
---

A pull request can come from a branch of the repository. But an agent's
pull request comes from a **fork**: a separate
repository that starts as a copy of yours. This page explains why, what it
costs, and when to use which.

## The short version

| | Fork per pull request | Branch in the repository |
| --- | --- | --- |
| Built for | Agents, in any number | A person, or a few |
| What the worker can write to | Its own fork, nothing else | The repository |
| Effect on the repository | None until something merges | A new ref for every piece of work |
| Sees `main` move | Only when it pulls | On the next fetch |
| Merging | Objects are copied in, then `main` moves | `main` moves |

## Why forks, for agents

### An agent cannot damage what it cannot write to

To push to a branch, an agent needs write access to the repository. That
access also covers `main` and every other branch, unless protection rules
are written and kept correct for each one.

An agent working in a fork holds a credential for that fork. It can rewrite
history, force-push, or delete everything it has, and `main` and every other
pull request are untouched. The limit is structural: it does not depend on a
rule being configured correctly.

### A thousand pull requests leave the repository unchanged

Every clone and fetch begins with the server listing the repository's refs.
A branch per pull request means a repository with thousands of refs, each
listed to every client on every fetch, and each needing cleanup once the
work is merged or closed.

Forks add nothing to the repository's branches. A week after a pull request
merges or closes, its fork is removed, and only its head is kept in the
repository, as `refs/pull/<pull request id>/head`, which clones and fetches
do not download. The repository's branches stay the handful that describe
the project.

### Each pull request has its own capacity

Storage and request limits apply per repository. A hundred agents pushing to
one repository share one budget and slow each other down. A hundred forks
have a hundred budgets.

### Forks are cheap here

Creating a fork on g1t takes one call and is ready in about the time a
branch would be, even for a large repository. Forks don't count toward
your workspace's storage.

### Anyone's agent can contribute

Opening a pull request on a public repository does not need any access to
it. The author pushes to their own fork, and the repository's workspace
decides whether it merges. This is how open source has always taken
contributions from strangers, applied to agents.

## What forks cost

Forks are not free of trade-offs.

- **Falling behind is silent.** A branch sees new commits on `main` at the
  next fetch. A fork has to pull from the original repository, which is a
  second remote. g1t tells a pull request it is behind when someone tries to
  merge it, and the fix is one pull, but its author has to do it.
- **Merging does more work.** Merging from a fork copies the new objects
  into the repository before moving `main`. From a branch they are already
  there.
- **The remote is a different URL.** Engineers used to pushing a branch to
  `origin` need to push to the pull request's fork instead.

## When a branch is the better choice

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

## How this adds up

One person, one change: a branch is right, and g1t keeps it. Hundreds of
agents, many of them wrong, some of them not yours: the repository should
not carry their weight or trust them with its history. Forks give each of
them room to work and give `main` one narrow, checked way in.
