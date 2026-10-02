---
title: Forks and branches
description: Why an agent's attempt gets its own fork, when a branch is the better choice, and what each costs.
---

On most forges, work happens on a branch of the repository. On g1t, an
agent's attempt happens in a **fork**: a separate repository that starts as
a copy of yours. People can still use branches. This page explains why the
two exist and what each is for.

## The short version

| | Fork per attempt | Branch in the repository |
| --- | --- | --- |
| Built for | Agents, in any number | A person, or a few |
| What the worker can write to | Its own fork, nothing else | The repository |
| Effect on the repository | None until something ships | A new ref for every piece of work |
| Sees `main` move | Only when it pulls | On the next fetch |
| Landing | Objects are copied in, then `main` moves | `main` moves |

## Why forks, for agents

### An agent cannot damage what it cannot write to

To push to a branch, an agent needs write access to the repository. That
access also covers `main` and every other branch, unless protection rules
are written and kept correct for each one.

An agent working in a fork holds a credential for that fork. It can rewrite
history, force-push, or delete everything it has, and `main` and every other
attempt are untouched. The limit is structural: it does not depend on a rule
being configured correctly.

### A thousand attempts leave the repository unchanged

Every clone and fetch begins with the server listing the repository's refs.
A branch per attempt means a repository with thousands of refs, each listed
to every client on every fetch, and each needing cleanup once the work is
done or abandoned.

Forks add nothing to the repository. An abandoned attempt is a fork that is
never looked at again. The repository's own refs stay the handful that
describe the project.

### Each attempt has its own capacity

Storage and request limits apply per repository. A hundred agents pushing to
one repository share one budget and slow each other down. A hundred forks
have a hundred budgets.

### Forks are cheap here

A fork on g1t is copy-on-write. Creating one does not copy the repository's
history; the fork shares it and stores only what changes. A fork of a large
repository is ready in about the time a branch would be.

### Anyone's agent can contribute

Starting an attempt on a public repository does not need any access to it.
The attempt's owner pushes to their own fork, and the repository's owner
decides whether it ships. This is how open source has always taken
contributions from strangers, applied to agents.

## What forks cost

Forks are not free of trade-offs.

- **Falling behind is silent.** A branch sees new commits on `main` at the
  next fetch. A fork has to pull from the original repository, which is a
  second remote. g1t tells an attempt it is behind when it tries to ship,
  and the fix is one pull, but the agent has to do it.
- **Landing does more work.** Shipping from a fork copies the new objects
  into the repository before moving `main`. From a branch they are already
  there.
- **It is one more concept.** Engineers who have only used branches need to
  learn that an attempt's remote is a different URL.

## When to use a branch

Use a branch when you are a person working on your own repository, or a
small team that already has write access. Nothing about isolation or scale
is at stake, and a branch is the tool you already know.

Opening pull requests from branches on g1t is being built. Today, attempts
are created from forks.

## How this adds up

One person, one change: a branch and a pull request are right, and g1t keeps
them. Hundreds of agents, many of them wrong, some of them not yours: the
repository should not carry their weight or trust them with its history.
Forks give each of them room to work and give `main` one narrow, checked way
in.
