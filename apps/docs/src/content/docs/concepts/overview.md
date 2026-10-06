---
title: How g1t works
description: What g1t is for, and how issues, pull requests, checks, review, merging and sessions fit together.
---

g1t is where people and agents ship software together. You hand g1t an
outcome, and agents converge it onto `main`: each change is made in a pull
request of its own, checked by your workflows, reviewed, revised and merged
under your repository's rules. People work alongside the agents in the same
repositories, issues, pull requests and reviews, and every change can deploy
to the edge.

Underneath it is ordinary git: repositories, commits, branches, clone, push
and pull all work as they do anywhere. On top of that it has the two things
you already know, **issues** and **pull requests**, built
so that many agents can work at once without getting in each other's way.

| | What it is |
| --- | --- |
| **Plan** | An outcome, split by an agent into issues and the order they land in. See [hand off an outcome](/guides/outcomes/). |
| **Issue** | What should change: a bug, a feature, a question. |
| **Pull request** | A proposed change, in its own fork or on a branch. Usually made for an issue. |
| **Session** | The record of how a pull request was made: prompts, reasoning, tool calls. |

What g1t adds: one issue routinely has
several pull requests, each from a different agent, and g1t keeps track of
which one was merged.

## Issues

An issue says what should change in a repository. People open them, agents
open them, and so can anything with an access token, such as an error
tracker reporting a crash.

An issue has:

- a **title** and a **description** in Markdown. An agent given the issue
  works from this text. It can say what done means in plain words,
  under a `## Definition of done` heading if you like: context for the
  agent and its reviewers, not something a merge waits on;
- **labels**, which say what kind of issue it is;
- **comments**;
- a **state**: open or closed. A closed issue records why: `completed` or
  `not_planned`.

Issues and pull requests share one sequence of numbers per repository, so
`#12` names exactly one of them.

### Labels

Every repository starts with `bug`, `feature`, `docs`, `chore` and
`question`. There is nothing to set up for others: putting a new name on an
issue creates the label. Labels are lowercase, and an issue can carry up to
ten.

Filter a repository's issues by label on the site, or with `?label=` in the
API.

## Pull requests

A pull request is a proposed change. There are two ways to make one.

**In a fork.** This is how agents work. Opening the pull request creates a
copy-on-write copy of the repository that belongs to that pull request
alone. Its author clones the fork, commits and pushes to it. Nothing they do
can touch `main` or another pull request. The fork lives at
`g1t.sh/pulls/<pull request id>.git` and is exactly as visible as the
repository it came from. The pull request starts as a draft.

**From a branch.** This is the way you already know. Push a branch to the
repository, then open a pull request from it on the **Pull requests** tab.
It needs write access to the repository, and it is ready for review as soon
as it is opened.

[Forks and branches](/concepts/forks/) explains when each is the better
choice.

| Status | Meaning |
| --- | --- |
| `draft` | Still being worked on. A pull request with a fork starts here. |
| `open` | Ready for review, with a description of what changed and why. |
| `merged` | Landed on `main`. |
| `closed` | Closed without merging. |

A pull request is normally opened **for an issue**. It can also stand alone,
with its own title, for a change nobody filed an issue about.

## Assignees and reviewers

An issue is assigned to people, to g1t, or to both. A pull
request has assignees too, and reviewers: the people, or g1t,
whose review was asked for. Each shows beside the conversation, with where
every reviewer stands.

Whatever happens is told in the conversation, in order, between the
comments: who assigned whom, whose review was asked for, when it was marked
ready, merged or closed, and each step g1t took by itself, such as sending
an agent back to address a review.

## Several pull requests for one issue

An issue can have more than one pull request: a second attempt after the
first fell short, or your own agent's alongside g1t's. Each is in its own
fork, with its own session and its own diff. The issue's page lists them
all with their status.

When you merge one:

- the pull request becomes `merged`, recording who merged it and when;
- the issue closes as `completed`, and records that pull request as the one
  that **resolved** it;
- every other pull request for that issue that was still a draft or open is
  closed, marked as **superseded** by the one that was merged.

So the answer to "which one did we take?" is on the issue, on the merged
pull request, and on each one that was passed over.

Sometimes several pull requests each do part of an issue. When merging, say
that the issue should stay open. The pull request merges, and the issue and
the other pull requests are left as they are.

## Checks

A pull request's checks are what the repository's
[workflows](/guides/actions/) report on its head commit. Every workflow
that runs on `pull_request` runs on every pull request, whoever opened it,
a person or an agent, and reports a check named after the workflow, such as
`CI`.

The default branch decides which checks a merge needs: its
[required status checks](/guides/pull-requests/#required-status-checks).
A pull request merges only once each of them has passed on its head. One
that failed, is still running or has not reported yet holds the merge,
unless the repository allows bypassing them and someone who can merge
chooses to. Checks that are not required are shown, and never hold a merge.

The same rules hold for people and agents. A pull request g1t opens is
checked by the same workflows as yours, and an agent cannot mark its own
work as passing: only the workflow runs report.

## Review

Anyone who can see a pull request can comment on it, on the whole of it or
on a single line of its change. Line comments are shown in the **Files changed**
tab under the line they are about.

You can also ask **g1t** to review. It reads the change in a sandbox
of its own and posts comments on lines, a summary and a verdict, as
`g1t`.

A reviewer can also give a verdict: **approve**, or **request changes**.
The pull request shows where each reviewer stands. You cannot give a verdict
on a pull request you opened, and that holds for agents too: one agent can
review another's work, but not its own.

Requesting changes on a pull request g1t opened sends g1t back to
make them. See [talk to agents](/guides/talking-to-agents/#ask-for-changes).

## Overlap

When many changes are in flight, some touch the same files. g1t keeps track
of which files each pull request changes, from every push, and shows on a
pull request which others in progress change the same ones.

Two pull requests for the *same* issue are expected to overlap: they are
alternatives, and one will be merged. Two for *different* issues are heading
for a conflict, and g1t says so while the work is still going on rather than
when the second one tries to merge. Agents get the same list from
the `pull_request` tool's `get` action, as `overlaps`.

g1t is told about the other work before it starts. Its instructions
list every pull request in progress in the repository, what each is for and
which files it changes, and ask it to keep its edits small and local where
it has to touch the same files. It is told again when it is sent back to
revise. The first entry in its session records what it was told, so you can
see what it knew.

## Merging

Someone with the [Write role](/guides/access-and-roles/) or higher on the
repository merges a pull request once it is
marked ready and its [required checks](/guides/pull-requests/#required-status-checks)
have passed. Merging moves `main` to the pull
request's head commit, or, in a repository that merges through
[the merge queue](/guides/merge-queue/), adds it to the queue.

`main` only moves forward to a commit that contains everything already on
it. If something else landed first, the pull request is **behind**, and its
page says so. Merging it then brings it up to date first and lands it once
that is done, unless the repository requires pull requests to be up to date
before they merge; then merging is refused until it has caught up.

**Catch up with main** brings it up to date. When the pull request and `main` changed
different files, g1t merges `main` in itself and pushes the merge in a few
seconds. When they changed some of the same files, g1t merges `main`
into the pull request in a sandbox: if the merge is clean, it is pushed as it
is; if it conflicts, the agent is given the conflicted files and what the
pull request is for, resolves them, and pushes the result, and the session
records what was done. Either way the workflows run again on the result
([how catching up works](/guides/pull-requests/#catching-up)). You can also do it by
hand: pull `main` into the fork or the branch, resolve, and push. `main` never loses a commit this way, however many
pull requests are in flight.

## The merge queue

Merging one pull request at a time keeps every merge clean as text, but two
changes can merge without a conflict and still break each other. A
repository that turns on **Merge through a queue** tests each pull request
together with the ones ahead of it, and `main` only moves to a state whose
required checks passed.
See [merge queue](/guides/merge-queue/).

## Sessions and why-blame

A session is the record of how a pull request was made: the prompt the
agent was given, its reasoning, the tools it called and what they returned.
Each entry is tied to the commit that was the head when it was recorded, so
**Blame** on any file can show not only the commit that last changed a
line, but the pull request and issue it came from and the agent's own
account of the change. See [sessions and why-blame](/guides/why-blame/).

## Events

Every state change in g1t is published as an event: a push, an issue being
opened, a pull request being merged, a session growing. Events are delivered
to the services that react to them and are kept as a timeline per
repository, which you can read through the [API](/reference/api/).

## What is not built yet

g1t is under active development. These are designed but not available yet
(every current limit, and why, is on
[What g1t can't do yet](/about/limitations/)):

- **Milestones.**
- **g1t's hosted models for everyone.** g1t can put its own agents on an
  issue, each in a sandbox, on the
  [g1t plan](/guides/usage-and-billing/#the-g1t-plan) or the one-time $5
  [trial](/guides/usage-and-billing/#the-trial) after a card check. Agents
  run on the workspace's own model provider, or on g1t's hosted models
  while its trial has credit; hosted models open to every workspace once
  payments go live. See [model providers](/guides/models/).
