---
title: Home
description: Your workspace's front page. Ask g1t what to do, where you're needed now, what happened since you were last here in plain English, what is running, and the one item to start with. How every number is worked out.
---

**Home** is the first page of your workspace, at `/<workspace>/-/home`.
It opens with **What are we building today?** and a box that
[asks g1t](#ask-from-home), then answers three questions, in this order:

1. **Where you're needed**: everything waiting on you, however long ago
   it started, with the action beside each item.
2. **What happened while you were away**: what changed, in plain
   English when you ask for it; what settled by itself and what went
   live; what people did; what landed; deploys and spend, since you were
   last here.
3. **What is running now**: workflow runs and builds still going.

**Start here** picks the one item to do first.

For a workspace's owners, Home also opens
[Getting started](/guides/workspaces/#getting-started), the setup guide,
until they finish or close it; `?setup=1` opens it again.

Every number on the page comes from what g1t has recorded. Nothing is
estimated. When a part of g1t does not answer, the section it feeds says
so, and the rest of the page still shows. Only what you ask g1t is written
by a model: [What changed](#what-changed) and the answers in Ask.

## Ask from Home

The box at the top asks g1t anything about your work. Type a question and
press **Enter** (**Shift+Enter** starts a new line): the top bar's
[Ask](/guides/ask/) panel opens and sends it, and the answer streams in
there. Under the box are questions to start with:

| Starter | What it does |
| --- | --- |
| **Summarize what changed since I was last here** | Writes a summary of the span into [What changed](#what-changed), further down the page, and brings it into view. Over another span it says so, such as **Summarize what changed in the last 7 days** |
| **What needs me first?** | Asks which things need you, most urgent first, one line each on what to do |
| **What shipped today?** | Asks what shipped today: what is live, what is still deploying, and what failed |
| **Who's working on what?** | Asks who is working on what right now, and whether anything is stuck |

Everything you ask from Home goes to your
[direct message with @g1t](/guides/ask/#one-conversation-in-ask-and-in-chat),
as a question asked in Ask does, so you can carry on from it in Ask or in
Chat. It answers with your workspace's own AI provider, so an owner has to
[set Ask up](/guides/ask/#set-it-up) first. Until then, or while g1t is
still answering an earlier question, the panel opens with your question
in its box rather than sending it, so nothing you typed is lost.

## Where you're needed

This list has no time window: something that started waiting a week ago
is here until you deal with it. Each row says what it is, what is at
stake, how long it has waited, and has its action beside it.

| Source | Rows |
| --- | --- |
| Code | A failed production build; your open pull request that can't land until you act (it conflicts, a required check fails, someone asked for changes, approvals are missing); your pull request that meets everything its branch asks for, ready for you to merge; a review asked of you by name; an invitation to a repository; a job waiting for a self-hosted runner |
| Notifications | An unread notification in this workspace that is a warning (someone or something is waiting) or a failure. One whose cause is over, such as a workflow that has passed since or a pull request that merged, has [settled](/guides/notifications/#threads-that-settle-themselves) and is not here |
| Chat | A conversation that mentions you, or a direct message you haven't read. Muted conversations are left out |

A notification about something already on the list, such as a pull
request whose row is there, is left out.

Each row's button takes you to the place where you act on it: **See the
build** for a failed production build, **Review** for a review asked of
you, **Respond** for an invitation, **Look** for a job waiting for a
runner or your pull request that can't land (**Review** when it waits
for a verdict), **Reply** for a message, and
**Open** for a notification. Your pull request that is ready to merge,
marked **Ready to merge**, says **Open** too: it opens the pull request,
where you merge it. Nothing on Home merges on the spot.

Rows are ordered most pressing first, by tier, then by how long each has
waited, longest first:

1. A failed production build.
2. Your pull request that can't land until you act on it.
3. Finished work that only waits for you: your pull request to merge, a
   review, an invitation.
4. Something that may be stuck: a job without a runner.
5. Unread warnings and failures in your notifications.
6. Mentions and direct messages.

The list shows the first eight rows; **Show more** opens the rest. The
sentence under the page's heading starts with how many things need you.

## Start here

**Start here** is the first row of Where you're needed: the most pressing
tier, and within it the row that has waited longest. g1t picks it with
that rule, so the same rows always give the same pick.
The card shows who is on it (**Owner**), the step it waits for (**Next**,
such as **Merge** or **Review**), how long it has waited (**Waiting**),
what is at stake (**At stake**), and **Why this one**, such as
"Everything it needs is met; it lands when you merge it." When others in
its tier are waiting too, it adds that this one has waited longest.

Its title links to what it picked: the pull request, issue or build. The
button under it opens the same place. For a pull request (one ready to
merge, a review asked of you, or yours that is stuck) it says **Open pull
request**; you merge or review there. For anything else it names the
action, such as **See the build** or **Respond**.

## Since you were last here

Home remembers when you were last on it, for each workspace, with your
account, so it is the same on your laptop and your phone. The second half
of the page covers what happened since then, and its heading says the span
in words, such as **Since Tuesday evening · 2 days** or **Since 40
minutes ago**.

| Switch | What it covers |
| --- | --- |
| **Since last visit** | From the end of your last visit to now. The default. |
| **Last 24 hours** | The 24 hours up to now. |
| **Last 7 days** | The 7 days up to now. |

The switch is part of the address (`?window=24h`, `?window=7d`), so you
can bookmark a span.

How a visit is counted:

- A visit counts once the page has been in view for five seconds. A quick
  refresh does not count, so it never wipes what you haven't looked at.
- What it records is when the page loaded, so anything that happens while
  you are reading shows next time.
- Visits less than 30 minutes apart are one visit. Going to a pull request
  and coming back, or refreshing, keeps the same span until you have been
  away for half an hour.
- With no visit on record, Home shows the last 24 hours and says so. After
  more than 14 days away, it shows the last 14 days.

The sentence under the heading sums it up, for example:

> 8 things need you. Since Tuesday evening, 3 people pushed 41 commits and
> merged 5 changes, and 12 changes landed.

It says what people did first (the commits they pushed and the changes
they merged; if neither, the messages they sent), then everything that
[landed](#landed). When nothing at
all was counted, it says so plainly:

> Quiet since Tuesday evening: nothing pushed, merged, deployed or said.

When Code and Chat both failed to answer, the sentence ends with "what
people did couldn't be read" rather than reading as quiet.

### What changed

The first card, **What changed**, has g1t tell you what happened in the
span in plain English: what changed, why, and what is live. It is not
written until you ask, since each summary is a call to your workspace's
AI provider:

1. Choose **Summarize** on the card, or the
   [starter](#ask-from-home) **Summarize what changed since I was last
   here** at the top of the page.
2. g1t's summary streams into the card as it is written. It reads g1t as
   you, as [Ask](/guides/ask/#what-it-can-read) does, so it covers only
   what you can see.
3. When it is finished:
   - **Ask a follow-up** opens the top bar's Ask on the same
     conversation, so you can ask about anything in the summary.
   - **Summarize again** writes a new one.
   - **In your direct message with g1t** opens the conversation in Chat,
     where the summary is kept.

The question g1t is sent reads as you would ask it, with the span's start
in your time zone: "Summarize what changed since I was last here (2:12
PM) in plain English." Choosing another span with the switch starts the
card over. When Ask is not set up, the card says so: owners get a link to
connect a provider and choose it for Ask, and members are told to ask an
owner.

### While you were away

The next card says what finished by itself in the span, and what is
live. (Over **Last 24 hours** and **Last 7 days** it is called **Settled
for you**.) Its first line counts:

| Count | What it is |
| --- | --- |
| *4 notifications settled* | Your notifications in this workspace that [settled themselves](/guides/notifications/#threads-that-settle-themselves) in the span: a later run passed, the pull request merged, the deployment went out. One you marked done yourself is not counted |
| *3 changes live*, *1 deploying*, *1 waiting to deploy*, *1 deploy failed* | The merges and pushes under [Landed](#landed), by whether each is [live](#live-after-merge) |
| *2 things still need you* | The rows of [Where you're needed](#where-youre-needed); it takes you there |

Under it, each notification that settled, newest first, with why it
settled and who did it, such as **CI passed in run 330** or **Merged by
@ana**. **Done** opens the notifications that are done.

### People

The second card, **People**, lists what people did in the span, one line
per kind of thing with its count, and each line opens the place that lists
them: a project's Activity tab for pushes, its pull requests or issues,
Artifacts, Chat. Beside the heading are the faces of the five most active,
and how many more there were.

| Line | What counts | From |
| --- | --- | --- |
| *3 people pushed 41 commits to 4 projects* | Every push to a branch of one of the workspace's repositories (`git.push`; tags are not pushes). The commits are the ones each push brought to its branch, along the branch's first-parent line from where it is now back to where it was, at most 50, and one for a new branch. A push recorded before commits were counted counts as one commit. | Events |
| *opened 2 pull requests, merged 5, closed 1 without merging* | `pull.opened`, `pull.merged`, `pull.closed` | Events |
| *reviewed 3 pull requests* | A review is a comment with a verdict | Events |
| *opened 4 issues, closed 6* | `issue.opened`, `issue.closed` | Events |
| *left 9 comments* | `comment.created` without a verdict | Events |
| *2 deploys went out, 1 failed* | `deployment.succeeded` and `deployment.failed`, by who set the build off | Events |
| *published 1 release*, *published 2 package versions* | `release.published`, `package.published` | Events |
| *created 1 doc, edited 7 docs* | Artifacts made (`folio.created`), and artifacts whose content changed (`folio.updated`): each artifact once, and everyone whose changes a version holds edited it. "Docs" when every one is a doc, else "artifacts". Counts only: Home never shows an artifact's title here. | Events |
| *sent 120 messages in 5 conversations* | Text messages and thread replies that were not deleted, in the conversations you can read: every public channel, and the private channels and direct messages you are in. Conversations are those with at least one message. | Chat |

A push an import made names nobody, so it is counted without a face.

The card says when it has nothing to show, and names the part that didn't
answer (Code or Chat) so an empty card never reads as a quiet day.

### Landed

Everything that landed in the span, newest first:

| Row | What it is |
| --- | --- |
| A pull request merged | With who wrote it, and who merged it when that was someone else |
| A push to a default branch | One row per push a person made straight to a default branch: its commit's first line when it brought one, else how many commits, and who pushed. For the ten projects pushed to most in the span; past those, one row per project with how many commits and pushes |
| A production build that went live | A project's production build that built and was served (previews stay under Deploys) |
| A release published | Its tag and name, and who released it |
| A package version published | Its name and version, and who published it |

The card's line counts them by kind. The first
five show; **Show more** opens the rest. Over **Last 7 days** the rows are
grouped by day (**Today**, **Yesterday**, **Sun, Oct 11**), five of each
day showing.

#### Explain a change

Every row has an **Explain** button (the sparkle beside its time,
"Explain this change in plain English"). It opens the top bar's
[Ask](/guides/ask/) and asks g1t about that one change:

| Row | What g1t is asked |
| --- | --- |
| A merge or a push | "Explain pull request #47 in acme/web in plain English: what changed, why, and is it live?" (or the commit, for a push) |
| A production build | What went out in that deployment |
| A release or a package version | What's new in it |

The answer is kept in your direct message with @g1t, like everything you
[ask from Home](#ask-from-home).

#### Live after merge

Each merge and push says whether it is live yet, for a project that
deploys to production. Landing on `main` is not shipping: a change is
shipped once a production deployment that contains it succeeds.

| Label | When |
| --- | --- |
| **Live 9 min after merge** | A production deployment that succeeded shipped it, this long after it landed. The label opens that deployment, or the workflow run that deployed it |
| **Deploying** | A production deployment after it is under way |
| **Deploy failed** | The production deployment after it failed, and none has shipped it since |
| **Waiting to deploy** | Nothing has deployed it yet |

How g1t knows: when a production deployment succeeds, a
[g1t.page build](/guides/deployments/) or one a workflow or the API
reported, g1t reads its commit's history back and writes down each
commit no production deployment shipped before as shipped by this one.
So a commit's first production deployment is the one that took it live,
and a rollback to an older commit ships nothing new. Home reads only what
was written down, so this costs nothing when the page loads. A change
that landed before g1t began writing this down for its project goes live
with the first production deployment that succeeded after it.

#### Made with an agent

A merge or push made in a harness session, such as Claude Code working
for you, carries the agent marker beside its title; it opens the
session. A pull request is marked when a session is tied to it (it
pushed the branch, named the pull request, or a commit on it carries a
`G1t-Session:` trailer); a push when one of its commits carries the
trailer. The change is still yours, and stays in the same list. When one of its sources (pull
requests, pushes and releases, deployments) didn't answer, the card says
so under the list.

### Deploys

Every build that finished in the span, production and previews: **Went
live** when it built and was served (it may have been replaced since), or
**Failed**. Skipped builds are left out. A workspace whose projects did not
build in the span has no Deploys card.

### Spent

What the workspace spent over the span, from its
[statement](/guides/usage-and-billing/), with each line at its price: what
was charged plus what your plan's included usage, a trial, a pool or a
discount paid of it. The lines are the statement's kinds of charge, such
as **Runner minutes, 2-core**, **Self-hosted runner time** and
**Deployments**, most first. Payments, credits, refunds and tax
are money in, not spend, and are left out. Under the total are the days
counted and the month so far, at price.

The statement keeps whole days, midnight to midnight UTC, so spend counts
from the start of the UTC day the span began: a span since 3 p.m. UTC
yesterday counts all of yesterday. Usage that g1t measures through the
month, such as hosting requests and storage, shows on the day it is added
to the statement.

## Running now

What is going right now, longest-going first:

| Kind | What it is |
| --- | --- |
| Workflow run | A [workflow](/guides/actions/) run that is queued, waiting, running, or waiting for approval, in the ten projects pushed to most in the span (their newest 20 runs each) |
| Build | A project's newest build, queued or building |

## While the page is open

Home keeps up with the workspace without a reload. What lands, starts
running, finishes or comes to need you while you are on the page joins its
list, sliding in at its place and lit for a moment; counts and the
sentence under the heading update with it. Runs that finish leave Running
now.

| Home updates when | From |
| --- | --- |
| Commits are pushed to a project's default branch, or a tag is pushed | The workspace's projects (the first 25) |
| A pull request is opened, reviewed, merged or closed, or an issue or comment changes | The same projects |
| A workflow run or a job in it starts or finishes, a build or deployment moves, or a release or package is published | The same projects |
| A [session](/guides/sessions/) starts or ends | The same projects |
| Something comes to need you, or you deal with it elsewhere | Your notifications |

A busy workspace sends changes all the time, so Home refreshes a second
after the last one and at most every five seconds. It works like the
[pages that update live](/guides/notifications/#pages-that-update-live):
never while you are typing in Ask or have a dialog open, and a tab out of
view catches up when you come back to it. Pushes to other branches and a
commit's checks don't refresh Home, because it doesn't show them. Spend
updates with the rest but changes only as usage is metered.

Refreshing in place keeps the same span: it is the same visit.

## Without Code access

A member whose membership does not include Code sees Home without anything
from Code:

- People shows what was said and the artifacts edited; nothing from
  repositories.
- Where you're needed has no rows from Code, and no notifications about a
  repository.
- Landed, Deploys and Running now are not shown.
- Spent is the same for every member.

## When something doesn't answer

Each section reads its own part of g1t and shows as soon as it has it.
When one does not answer:

- Where you're needed and Running now name the parts that didn't answer,
  so an empty list never reads as nothing waiting.
- People counts what could be read, and names the part that is missing
  (Code or Chat). If nothing could be read, the card says so, and the
  sentence under the heading says what people did couldn't be read.
- Landed, Deploys and Spent each say their part didn't answer. When
  deployments or sessions can't be read, Landed shows its rows without
  their live labels or agent markers.
- While you were away says when your notifications can't be read.
- What changed says when Ask can't be reached or isn't set up, or when
  the question could not be sent.
- If your last visit can't be read, the span is the last 24 hours and the
  page says why.

When a list g1t reads is longer than it reads at once (100 pull requests
per project and state, 50 projects, builds
of 20 projects, 5,000 events of the span), the page says that some work
may be missing or some counts are low.

## How it scales

Every event in g1t is in one log, and its ids sort by time, so a span is a
range of ids. Home asks the events service for one digest of the span: for
each of the workspace's repositories (the first 50) and each kind of event
it counts, that is one range scan of an index on repository, type and id,
and the workspace's artifact events are the same range under no
repository. A busy week of tens of repositories is a few thousand rows,
read in one round trip; chat's count is one query over the conversations
you can read. When a workspace has hundreds of repositories, the next step
is a daily rollup per workspace that the digest reads instead of the log.
It is not built yet.

## For services: activity_digest and activity

Home's counts come from two methods other services can call too.

**`activity_digest`** on the events service (`repo_ids`, `workspace`,
`from`, `until`; RFC 3339, `[from, until)`; the caller has checked the
viewer may read each repository) returns, per repository that had any
event: `pushes` (`count`, `commits`, `branches`, `by` with each actor's
pushes and commits, and `default_branch` with the same for pushes straight
to it and `last_at`), `pulls` (`opened`, `merged`, `closed`), `issues`
(`opened`, `closed`), `reviews`, `comments`, `deployments` (`succeeded`,
`failed`, `production`), `releases` and `packages` (newest first, at most
50 each); and for the workspace named, `folios` (`created`, `edited` with
each folio's authors, `edited_count`). Every count by actor is a list of
`{ actor, count }`, where `actor` is a member key: `user:<id>` for an
account (g1t is `user:usr_g1t_agent`), `agent:<id>` for an agent, or
empty for nobody. `complete` is
false when more than 5,000 events fell in the span, or more than 50
repositories were named.

**`activity`** on the chat service (`workspace`, `viewer`, `from`,
`until`) returns `messages`, `channels` (conversations with at least one)
and `authors` (`key`, `messages`; most first), over text messages and
thread replies not deleted in the conversations the viewer can read.
