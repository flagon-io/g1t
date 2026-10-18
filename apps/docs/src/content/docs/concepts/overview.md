---
title: How g1t works
description: How Code works on g1t, and how work items, pull requests, checks, review, merging and sessions fit together, for people and coding agents alike.
---

A workspace holds your repositories and the work items that say what
should change in them, with pull requests, required checks and the merge
queue; [Actions](/guides/actions/) that run your
workflows; [Deployments](/guides/deployments/) that put every pull request
live; and [Chat](/guides/chat/) for your team. This page is about
**Code**, where changes are made and landed.

Underneath is ordinary git: clone, branch, commit, push and pull work as
they do anywhere. On top of it are the two things you already know,
**work items** and **pull requests**, built so that many people and coding
agents can work at once without getting in each other's way.

The coding agents you already use, such as Claude Code, Codex, Cursor or
OpenCode, work on g1t from wherever they run. They connect over
[MCP](/guides/bring-your-own-agent/), the [g1t CLI](/guides/cli/), the
[REST API](/reference/api/) and [webhooks](/guides/webhooks/), act as the
person who connected them, and go through the same pull requests, checks,
reviews and rules as everyone else.

| | What it is |
| --- | --- |
| **Work item** | What should change: a feature, a bug, a chore. It belongs to the workspace and can land in several repositories. |
| **Pull request** | A proposed change to one repository, on a branch or in a working copy of its own. Usually made for a work item. |
| **Session** | One run of a coding agent: its prompts, reasoning and tool calls, tied to the work item and pull request it worked on. |

One work item can have several pull requests, in one repository or in
several, each from a different person or agent, and g1t keeps track of
which ones were merged and where the work has landed.

## Work items

A work item says what should change. People open them, coding agents open
them, and so can anything with an access token, such as an error tracker
reporting a crash. They are under **Work**, after **Home** in the left
rail; see [work items](/guides/work-items/).

A work item has:

- a **title** and a **description** in Markdown. Whoever works on the
  work item, person or agent, works from this text. Say what done means in
  plain words, under a `## Definition of done` heading if you like: it is
  context for whoever works on it and its reviewers, not something a merge
  waits on;
- its **repositories**: the one it was filed in (its `origin`), the ones
  it should land in (its `targets`), and the ones a pull request or commit
  for it has `touched`;
- **labels**, which say what kind of work it is;
- **comments** and **assignees**;
- a **state**: open or closed. A closed work item records why:
  `completed` or `not_planned`.

Work items and pull requests share one sequence of numbers per workspace,
so `#12` names exactly one of them, whichever repository you are in.

A workspace starts with a set of labels such as `bug`, `enhancement` and
`question`, shared by all its repositories; anyone with the Triage role
can make more as they label. A work item or pull request carries up to 20.
See [labels](/guides/labels/).

## Pull requests

A pull request is a proposed change. There are two ways to make one.

**From a branch.** Push a branch to the repository, then open a pull
request from it on the **Pull requests** tab or with `g1t pr create`. It
needs write access to the repository, and is ready for review as soon as
it is opened.

**In a working copy.** This is how coding agents usually work: the
`pull_request` tool's `create` action with `item`, or
`g1t pr create --item 12` with no branch of your own, opens a draft pull
request for a work item and makes
it a copy of the repository that belongs to that pull request alone,
ready in about the time a branch would be. The author clones it, commits
and pushes to it, and nothing they do can touch `main` or another pull
request. It lives at `g1t.sh/pulls/<pull request id>.git` and is exactly
as visible as the repository it came from.

[Forks and working copies](/concepts/forks/) explains when each is the
better choice.

| Status | Meaning |
| --- | --- |
| `draft` | Still being worked on. A pull request in a working copy starts here. |
| `open` | Ready for review, with a description of what changed and why. |
| `merged` | Landed on its base branch. |
| `closed` | Closed without merging. |

A pull request is normally opened **for a work item**. It can also stand
alone, with its own title, for a change nobody filed a work item about.

## Assignees and reviewers

Work items and pull requests have assignees, and pull requests have
reviewers: the people and teams whose review was asked for. Each shows
beside the conversation, with where every reviewer stands.

Assigning a work item to `g1t`, or mentioning `@g1t` in a comment, starts a
session on the workspace's own Anthropic account, as the person who asked;
see [Assign g1t](/guides/sessions/#assign-g1t-or-ask-it-in-the-thread).

The conversation tells what happened, in order, between the comments: who
assigned whom, whose review was asked for, which sessions started, and
when it was marked ready, merged or closed.

## Several pull requests for one work item

A work item can have more than one pull request: one in each repository
it has to land in, a second attempt after the first fell short, or two
agents trying different approaches. Each has its own branch or working
copy, its own session and its own diff. The work item's page lists them
all, by repository, with their status.

When you merge one into its repository's default branch:

- the pull request becomes `merged`, recording who merged it and when;
- its repository is marked **landed** on the work item, which records that
  pull request as the one that **resolved** it there;
- every other pull request for that work item in the same repository that
  was still a draft or open is closed, marked as **superseded** by the one
  that was merged; pull requests for it in its other repositories stay
  open, since each lands its own part;
- the work item closes as `completed` once every repository it targets
  has landed, or at once when it has no targets.

So the answer to "which one did we take?" is on the work item, on the
merged pull request, and on each one that was passed over.

When several pull requests in one repository each do part of the work,
say `Part of #12` in all but the last, or say that the work item should
stay open as you merge. The pull request merges, and the work item and the
other pull requests are left as they are.

## Checks

A pull request's checks are what the repository's
[workflows](/guides/actions/) and integrations report on its head commit.
Every workflow that runs on `pull_request` runs on every pull request,
whoever opened it, and reports a check named after the workflow, such as
`CI`.

The base branch decides which checks a merge needs: its
[required status checks](/guides/pull-requests/#required-status-checks).
A pull request merges only once each of them has passed on its head. One
that failed, is still running or has not reported yet holds the merge,
unless the repository allows bypassing them and someone who can merge
chooses to. Checks that are not required are shown, and never hold a merge.

The same rules hold for people and agents. A pull request an agent opens
is checked by the same workflows as yours, and an agent cannot mark its
own work as passing: only the checks report.

## Review

Anyone who can see a pull request can comment on it, on the whole of it or
on a single line of its change, in **Files changed**.

A reviewer can also give a verdict: **approve**, or **request changes**.
You cannot give a verdict on a pull request you opened, and neither can a
coding agent working as you.

## Overlap

When many changes are in flight, some touch the same files. g1t tracks
which files each pull request changes, from every push, and shows on a
pull request which others in progress change the same ones.

Two pull requests for the *same* work item in one repository are expected
to overlap: they are alternatives, and one will be merged. Two for
*different* work items are
heading for a conflict, and g1t says so while the work is still going on,
not when the second one tries to merge. Agents get the same list from the
`pull_request` tool's `get` action, as `overlaps`, so they can keep their
edits small where they must touch the same files.

## Merging

Someone with the [Write role](/guides/access-and-roles/) or higher merges
a pull request once it is ready and its
[required checks](/guides/pull-requests/#required-status-checks) have
passed. It lands by one of the repository's
[merge methods](/guides/pull-requests/#merge-methods): a merge commit, a
squash, a rebase or a fast-forward. In a repository that uses
[the merge queue](/guides/merge-queue/), merging adds it to the queue
instead. **Auto-merge** lands it by itself once everything it needs is met.

When something else landed first, the pull request is **behind**, and its
page says so. Merging brings it up to date and lands it, unless the
repository requires pull requests to be up to date first; then merging
waits until it has caught up.

**Update branch** brings it up to date. When the two sides' changes do
not clash (edits to the same file merge line by line), g1t merges or
rebases the base in itself in a few seconds, and the workflows run again
([keeping it up to date](/guides/pull-requests/#keeping-it-up-to-date)).
When they changed the same lines, pull the base into the branch or
working copy, resolve, and push. The base never loses a commit this way,
however many pull requests are in flight.

## The merge queue

Merging one pull request at a time keeps every merge clean as text, but
two changes can merge without a conflict and still break each other. A
repository whose rules include **Require the merge queue** (**Settings →
Rules**) tests each pull request together with the ones ahead of it, and
the base only moves to a state whose required checks passed. When one
fails in combination, g1t says which pull requests and which check, so its
author, person or agent, can fix it. See [merge queue](/guides/merge-queue/).

## Sessions and why-blame

A session is one run of a coding agent: the prompts it was given, its
reasoning, the tools it called, and what it touched. g1t's
[Claude Code plugin](/guides/claude-code-plugin/) records one for every
Claude Code session in a g1t repository; other agents record theirs with
the `session` tool or `g1t session`. A session is recorded in the repository it
is checked out in, and tied to the work item it claimed and the pull
request it opened. People read it on the pull request's **Session** tab,
on the work item, and on the workspace's **Sessions**, in the rail after
**Work**, which shows who is working on what right now across its
repositories. See
[sessions, claims and dependencies](/guides/sessions/).

Each entry is tied to the commit that was the head when it was recorded,
so **Blame** on any file can show not only the commit that last changed a
line, but the pull request and work item it came from and the agent's own
account of the change. See [sessions and why-blame](/guides/why-blame/).

## Events

Every state change in g1t is published as an event: a push, a work item being
opened, a pull request being merged, a session growing. Events reach the
services that react to them, your [webhooks](/guides/webhooks/), and a
timeline per repository that you can read through the
[API](/reference/api/) or follow with `g1t work events --follow`.
[Events](/architecture/events/) in the Architecture section shows how.

## What is not built yet

Every current limit, and why, is on
[What g1t can't do yet](/about/limitations/).
