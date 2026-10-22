---
title: Home
description: Your workspace's front page. A box that asks g1t, your move (everything waiting on you, and the one item to start with), the agents, runs and builds going now, this week's work day by day with what is worth a look, and what happened since you were last here in plain English. How every number is worked out.
---

**Home** is the first page of your workspace. On a computer it is where
**Chat** opens, at `/<workspace>/-/chat`, with your conversations and
sessions beside it; on a phone it is the **Home** tab, at
`/<workspace>/-/home`.
It reads top to bottom, from what you can do now to what already happened:

1. **What are we building today?**: a box that [asks g1t](#ask-from-home)
   anything about your work, with questions to start with.
2. **[Your move](#your-move)**: everything waiting on you, however long ago
   it started, with the action beside each item. Its first row is
   [Start here](#start-here), the one item to do first, and why. Beside it,
   **[Live](#live)**: the agents at work, workflow runs and builds going
   now, each agent session with what it has cost so far.
3. **[This week](#this-week)**: the week in a sentence and four figures,
   the last two weeks day by day (what agents and people landed), and what
   is [worth a look](#worth-a-look), each finding with its evidence and
   pinned to the day it happened where it happened on one.
4. **Since you were last here**: one card for the span. It shows what people
   did, what changed in plain English when you ask for it, and what landed,
   each change with whether it is live yet. Beside it, kept in view as you
   scroll: **[Spent](#spent)**, what the span cost and the month so far,
   and **[Settled for you](#settled-for-you)**, what finished by itself.

On a phone it is one column, in the same order.

For a workspace's owners, Home also opens
[Getting started](/guides/workspaces/#getting-started), the setup guide,
until they finish or close it. The **Getting started** button at the top
of Home opens it again at any time, as `?setup=1` does.

Every number on the page comes from what g1t has recorded. Nothing is
estimated, and nothing compares your workspace or its teams with anyone
else's: each figure is set against your own last weeks. When a part of g1t does not answer, the section it feeds says
so, and the rest of the page still shows. Only what you ask g1t is written
by a model: [What changed](#what-changed) and the answers in Ask.

## This week

A sentence for what landed in the last seven UTC days and how much of it
was agents', then four figures. Each shows how it moved since the seven
days before (green when that is good news, red when it is not); point at
one for what it counts, and it opens the page behind it.

Under them are the last fourteen UTC days as columns: what agents landed
(their merged pull requests and the commits their sessions pushed
directly) in the accent, what people merged above it, last week's days
faded. Point at a day, or focus it, to read it in full: what landed, by
whom, and the sessions started. A finding that happened on one day, such
as a milestone that closed, is pinned over it with the number it has in
[Worth a look](#worth-a-look).

| Figure                    | What it counts                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Landed by agents**      | Pull requests that merged in the week and were an [agent's](#whose-work-is-an-agents), and the commits agent sessions pushed outside any pull request (to the default branch, most of all), each once. A workspace that pushes straight to main lands most of its work the second way.                                                       |
| **Cost per agent change** | The week's agent [usage](/guides/usage-and-billing/#the-usage-page) at price, plus what the [sessions](/guides/sessions/) started in it cost (estimated at list price from their token usage), divided by the agent changes that landed in it: an average, not what any one cost. A dash when usage can't be read or no agent change landed. |
| **Gone quiet**            | Pull requests open at the end of each week (now, for this one), opened three days or more before, with nothing in the three days before: no push, comment, review, timeline event, check or session. Drafts count.                                                                                                                           |
| **Sent back**             | Of the agent pull requests that merged in the week (direct commits get no review, so they're not counted here), the share a person asked for changes on before they merged.                                                                                                                                                                  |

### Whose work is an agent's

A pull request is an agent's when g1t's agent opened it, it was opened as
an agent's, or a [session](/guides/sessions/) is tied to it: linked to it,
started for it, or pushing its branch. Its owner is the person who asked
for it, else its author, so an agent's work counts toward the person it
was for.

### Worth a look

Under the days, what the work says is worth a look, most important first.
Each finding is a sentence with its evidence after it, a link to where you
can see it, and **Ask g1t**, which asks [Ask](/guides/ask/) to look into
it. A finding with a trend has its line beside it. When nothing stands
out against the workspace's last weeks, it says so. None of it is about
what needs you: that is [Your move](#your-move).

| Finding                                   | When it shows                                                                                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One unreviewed change holding up work** | An open pull request no one has reviewed is for a work item that other open work items are blocked by. The one holding up the most leads.                                                                                                          |
| **Agent drafts waiting for review**       | This week's first reviews waited at least four times as long as agents took to open the pull requests (from their session starting), and at least four hours. Without that gap: first reviews took half as long again as the weeks before.         |
| **A milestone closed**                    | A milestone closed in the last seven days, against its due date, with its weeks in build, its merged pull requests and its repositories.                                                                                                           |
| **Where agent spend is going**            | More than a third of the quarter's agent spend by pull request went into one milestone (else one work item, else one repository). Spend is g1t's usage on each pull request and its share of its sessions' cost.                                   |
| **More changes gone quiet**               | At least three more stalled changes than last week, and a quarter more.                                                                                                                                                                            |
| **Agent rework moving**                   | People asked for changes on agents' merged work at least 8 points more, or less, often than over the four weeks before (with five agent merges or more).                                                                                           |
| **A practice catching on**                | Two or more people started using a harness (Claude Code, Codex, Cursor and so on) this month, at least two weeks after the first person did.                                                                                                       |
| **Who works where**                       | In a workspace where three people or more merged lately, someone started merging to a repository one person has carried (three quarters of its last 90 days' merges); or merged to a repository for the first time this week after work elsewhere. |

Findings are ordered by how much they hold up: blocked work first, then
waits, then what closed and where spend went. Up to four show, and the
rest are one click away. What the work says is read again at most every
five minutes for each person, so a figure can be up to five minutes
behind. The same reads, at more length, are on the
[workspace overview](/guides/workspaces/#the-workspace-overview).

## Ask from Home

The box at the top of Home asks g1t anything about your work. Type a question and
press **Enter** (**Shift+Enter** starts a new line): it is asked in your
direct message with g1t ([Ask](/guides/ask/)), which opens in Chat, and the
answer streams in there. Under the box are questions to start with:

| Starter                                          | What it does                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Summarize what changed since I was last here** | Writes a summary of the span into [What changed](#what-changed), further down the page, and brings it into view. Over another span it says so, such as **Summarize what changed in the last 7 days** |
| **What needs me first?**                         | Asks which things need you, most urgent first, one line each on what to do                                                                                                                           |
| **What shipped today?**                          | Asks what shipped today: what is live, what is still deploying, and what failed                                                                                                                      |
| **Who's working on what?**                       | Asks who is working on what right now, and whether anything is stuck                                                                                                                                 |

Everything you ask from Home goes to your
[direct message with @g1t](/guides/ask/#one-conversation-in-ask-and-in-chat),
as a question asked in Ask does, and opens it in Chat, where the answer
streams. It answers with your workspace's own AI provider, so an owner has to
[set Ask up](/guides/ask/#set-it-up) first; until then g1t replies with where
to set it up. If the question can't be sent, Chat's New opens with it
in its box, so nothing you typed is lost.

## Your move

This list has no time window: something that started waiting a week ago
is here until you deal with it. Each row says what it is, what is at
stake, how long it has waited, and has its action beside it.

| Source        | Rows                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code          | A failed production build; your open pull request that can't land until you act (it conflicts, a required check fails, someone asked for changes, approvals are missing); your pull request that meets everything its branch asks for, ready for you to merge; a review asked of you by name; an invitation to a repository; a job waiting for a self-hosted runner |
| Notifications | An unread notification in this workspace that is a warning (someone or something is waiting) or a failure. One whose cause is over, such as a workflow that has passed since or a pull request that merged, has [settled](/guides/notifications/#threads-that-settle-themselves) and is not here                                                                    |
| Chat          | A conversation that mentions you, or a direct message you haven't read. Muted conversations are left out                                                                                                                                                                                                                                                            |
| Work          | A work item in [the plan](/work/plan/)'s Now that is assigned to you or that you claimed, in Now's order; for those who can plan, work items that have waited in Triage more than a week                                                                                                                                                                            |

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
7. Your work items in Now.

The list shows the first eight rows; **Show more** opens the rest. The
line under its heading says how many things need you.

## Start here

**Start here** is the first row of Your move, set apart at the
top: the most pressing tier, and within it the row that has waited
longest. g1t picks it with that rule, so the same rows always give the
same pick. It says why, such as "Everything it needs is met; it lands when
you merge it." When others in its tier are waiting too, it adds that this
one has waited longest. Beside its button are what is at stake, how long
it has waited, and who is on it.

Its title links to what it picked: the pull request, work item or build. The
button opens the same place. For a pull request (one ready to
merge, a review asked of you, or yours that is stuck) it says **Open pull
request**; you merge or review there. For anything else it names the
action, such as **See the build** or **Respond**.

When nothing needs you, Start here shows the work item to take next from
[the plan](/work/plan/#what-to-take-next): the first in Now that nobody
is on, or the top of Next, with why ("Top of the plan's Next, ready and
unclaimed") and **Open work item**.

## Since you were last here

Home remembers when you were last on it, for each workspace, with your
account, so it is the same on your laptop and your phone. The span's card
covers what happened since then, and its heading says the span
in words, such as **Since Tuesday evening · 2 days** or **Since 40
minutes ago**.

| Switch               | What it covers                                       |
| -------------------- | ---------------------------------------------------- |
| **Since last visit** | From the end of your last visit to now. The default. |
| **Last 24 hours**    | The 24 hours up to now.                              |
| **Last 7 days**      | The 7 days up to now.                                |

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

The sentence under the card's heading sums it up, for example:

> Since Tuesday evening, 3 people pushed 41 commits and merged 5
> changes, and 12 changes landed.

It says what people did first (the commits they pushed and the changes
they merged; if neither, the messages they sent), then everything that
[landed](#landed). When nothing at
all was counted, it says so plainly:

> Quiet since Tuesday evening: nothing pushed, merged, deployed or said.

When Code and Chat both failed to answer, the sentence ends with "what
people did couldn't be read" rather than reading as quiet.

### What changed

**What changed**, at the top of the span's card, has g1t tell you what happened in the
span in plain English: what changed, why, and what is live. It is not
written until you ask, since each summary is a call to your workspace's
AI provider:

1. Choose **Summarize** on the card, or the
   [starter](#ask-from-home) **Summarize what changed since I was last
   here** at the top of the page.
2. g1t's summary streams into the card as it is written. It reads g1t as
   you, as [Ask](/guides/ask/#what-it-can-read) does, so it covers only
   what you can see.
   Once it is finished, with the card in view, it counts as read, so it
   is not left unread in your direct message and makes no pop-up or
   sound (see
   [One conversation, in Ask and in Chat](/guides/ask/#one-conversation-in-ask-and-in-chat)).
3. When it is finished:
   - **Ask a follow-up** opens the same
     conversation in Chat, so you can ask about anything in the summary.
   - **Summarize again** writes a new one.
   - **In your direct message with g1t** opens the conversation in Chat,
     where the summary is kept.

The question g1t is sent reads as you would ask it, with the span's start
in your time zone: "Summarize what changed since I was last here (2:12
PM) in plain English." Choosing another span with the switch starts it
over. When Ask is not set up, the card says so: owners get a link to
connect a provider and choose it for Ask, and members are told to ask an
owner.

### People

Under What changed, **People** shows what people did in the span, one line
per kind of thing with its count, and each line opens the place that lists
them: a repository's Activity tab for pushes, its pull requests, **Work** for
work items, Artifacts, Chat. Beside the heading are the faces of the five most active,
and how many more there were.

| Line                                                         | What counts                                                                                                                                                                                                                                                                                                                                        | From   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| _3 people pushed 41 commits to 4 repositories_               | Every push to a branch of one of the workspace's repositories (`git.push`; tags are not pushes). The commits are the ones each push brought to its branch, along the branch's first-parent line from where it is now back to where it was, at most 50, and one for a new branch. A push recorded before commits were counted counts as one commit. | Events |
| _opened 2 pull requests, merged 5, closed 1 without merging_ | `pull.opened`, `pull.merged`, `pull.closed`                                                                                                                                                                                                                                                                                                        | Events |
| _reviewed 3 pull requests_                                   | A review is a comment with a verdict                                                                                                                                                                                                                                                                                                               | Events |
| _opened 4 work items, closed 6_                              | `work_item.opened`, `work_item.closed`                                                                                                                                                                                                                                                                                                             | Events |
| _left 9 comments_                                            | `comment.created` without a verdict                                                                                                                                                                                                                                                                                                                | Events |
| _2 deploys went out, 1 failed_                               | `deployment.succeeded` and `deployment.failed`, by who set the build off                                                                                                                                                                                                                                                                           | Events |
| _published 1 release_, _published 2 package versions_        | `release.published`, `package.published`                                                                                                                                                                                                                                                                                                           | Events |
| _created 1 doc, edited 7 docs_                               | Artifacts made (`folio.created`), and artifacts whose content changed (`folio.updated`): each artifact once, and everyone whose changes a version holds edited it. "Docs" when every one is a doc, else "artifacts". Counts only: Home never shows an artifact's title here.                                                                       | Events |
| _sent 120 messages in 5 conversations_                       | Text messages and thread replies that were not deleted, in the conversations you can read: every public channel, and the private channels and direct messages you are in. Conversations are those with at least one message.                                                                                                                       | Chat   |

A push an import made names nobody, so it is counted without a face.

It says when it has nothing to show, and names the part that didn't
answer (Code or Chat) so an empty list never reads as a quiet day.

### Landed

The rest of the span's card is everything that landed in the span,
newest first:

| Row                         | What it is                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pull request merged       | With who wrote it, and who merged it when that was someone else                                                                                                                                                                                                                                                 |
| A push to a default branch  | One row per push a person made straight to a default branch: its commit's first line when it brought one, else how many commits, and who pushed. For the ten repositories pushed to most in the span; past those, one row per repository with how many commits and pushes                                       |
| A production build          | Only one that no merge or push on the list already speaks for: a redeploy, a rollback, a build of a repository whose pushes weren't read, or one that failed. A build that shipped a merge is that merge's [live label](#live-after-merge), not a row of its own. Previews stay on the repository's Deployments |
| A release published         | Its tag and name, and who released it                                                                                                                                                                                                                                                                           |
| A package version published | Its name and version, and who published it                                                                                                                                                                                                                                                                      |

Its line counts them by kind, and how many of the merges and pushes are
live, deploying, waiting to deploy, or failed to deploy. The first five
show; **Show more** opens the rest. Over **Last 7 days** the rows are
grouped by day (**Today**, **Yesterday**, **Sun, Oct 11**), five of each
day showing.

#### Explain a change

Every row has an **Explain** button (the sparkle beside its time,
"Explain this change in plain English"). It opens the top bar's
[Ask](/guides/ask/) and asks g1t about that one change:

| Row                            | What g1t is asked                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| A merge or a push              | "Explain pull request #47 in acme/web in plain English: what changed, why, and is it live?" (or the commit, for a push) |
| A production build             | What went out in that deployment                                                                                        |
| A release or a package version | What's new in it                                                                                                        |

The answer is kept in your direct message with @g1t, like everything you
[ask from Home](#ask-from-home).

#### Live after merge

Each merge and push says whether it is live yet, for a repository that
deploys to production. Landing on `main` is not shipping: a change is
shipped once a production deployment that contains it succeeds.

| Label                      | When                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live 9 min after merge** | A production deployment that succeeded shipped it, this long after it landed. The label opens that deployment, or the workflow run that deployed it |
| **Deploying**              | A production deployment after it is under way                                                                                                       |
| **Deploy failed**          | The production deployment after it failed, and none has shipped it since                                                                            |
| **Waiting to deploy**      | Nothing has deployed it yet                                                                                                                         |

How g1t knows: when a production deployment succeeds, a
[g1t.page build](/guides/deployments/) or one a workflow or the API
reported, g1t reads its commit's history back and writes down each
commit no production deployment shipped before as shipped by this one.
So a commit's first production deployment is the one that took it live,
and a rollback to an older commit ships nothing new. Home reads only what
was written down, so this costs nothing when the page loads. A change
that landed before g1t began writing this down for its repository goes live
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

## Live

Beside Your move, what is going right now. First the agents at work: each
live [session](/guides/sessions/) of a harness (Claude Code, Codex and so
on) or a hosted agent, with what it is on, who runs it, how long it has
gone, its subagents, and what it has cost so far, estimated at list price
from its token usage. Then workflow runs and builds, longest-going first,
each with its state and how long it has gone:

| Kind         | What it is                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow run | A [workflow](/guides/actions/) run that is queued, waiting, running, or waiting for approval, in the ten repositories pushed to most in the span (their newest 20 runs each) |
| Build        | A repository's newest build, queued or building                                                                                                                              |

## Spent

Beside the span: what the workspace spent over it, from its
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

## Settled for you

Under Spent: your notifications in this workspace
that [settled themselves](/guides/notifications/#threads-that-settle-themselves)
in the span, newest first, each with why, such as **CI passed in run 330**
or **Merged by @ana**: a later run passed, the pull request merged, the
deployment went out. One you marked done yourself is not counted. **Done**
opens the notifications that are done.

## While the page is open

Home keeps up with the workspace without a reload. What lands, starts
running, finishes or comes to need you while you are on the page joins its
list, sliding in at its place and lit for a moment; counts and the
lines update with it. Sessions that end and runs that finish leave Live.

| Home updates when                                                                                                     | From                                        |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Commits are pushed to a repository's default branch, or a tag is pushed                                               | The workspace's repositories (the first 25) |
| A pull request is opened, reviewed, merged or closed, a comment changes, or a work item linked to one of them changes | The same repositories                       |
| A workflow run or a job in it starts or finishes, a build or deployment moves, or a release or package is published   | The same repositories                       |
| A [session](/work/sessions/) starts or ends                                                                           | The same repositories                       |
| Something comes to need you, or you deal with it elsewhere                                                            | Your notifications                          |

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

- This week is not shown.
- People shows what was said and the artifacts edited; nothing from
  repositories.
- Your move has no rows from Code, and no notifications about a
  repository.
- Landed is not shown, and Live has no sessions, runs or builds.
- Spent is the same for every member.

## When something doesn't answer

Each section reads its own part of g1t and shows as soon as it has it.
When one does not answer:

- Your move and Live name the parts that didn't answer,
  so an empty list never reads as nothing waiting.
- People counts what could be read, and names the part that is missing
  (Code or Chat). If nothing could be read, the card says so, and the
  sentence under the card's heading says what people did couldn't be read.
- Landed and Spent each say their part didn't answer. When
  deployments or sessions can't be read, Landed shows its rows without
  their live labels or agent markers.
- Settled for you says when your notifications can't be read.
- This week says when the work couldn't be read. When some repositories
  didn't answer, it says the week leaves them out.
- What changed says when Ask can't be reached or isn't set up, or when
  the question could not be sent.
- If your last visit can't be read, the span is the last 24 hours and the
  page says why.

When a list g1t reads is longer than it reads at once (100 pull requests
per repository and state, 50 repositories, builds
of 20 repositories, 5,000 events of the span), the page says that some work
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
to it and `last_at`), `pulls` (`opened`, `merged`, `closed`), `work_items`
(`opened`, `closed`, for the work items linked to it), `reviews`, `comments`, `deployments` (`succeeded`,
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

**`workspace_signals`** on the work service takes `workspace`,
`repo_ids` (at most 100), `viewer`, `until` (a UTC day), `weeks` (1 to
13), `days` (1 to 28) and `since` (a UTC day, at most 400 days before
`until`). For the repositories the viewer can read, it returns:

- `weeks`: per repository and week of seven days ending with `until`,
  `merged`, `agent_merged`, `agent_reworked`, `agent_drafted` and
  `agent_draft_seconds`, `reviewed` and `review_seconds`, and `stalled`.
- `days`: per repository and day, `opened`, `merged`, `agent_merged`,
  `reworked`, `reviews` and `sessions`.
- `waiting`: open pull requests with no first review, oldest first, at
  most 50, each with its work item and the open work items it `blocks`.
- `pulls`: those opened or merged since `since`, at most 3,000 newest
  first, each with its owner, work item and milestone; `pulls_capped`
  when there were more.
- `authors`: per repository and owner, their merges over its history and
  in the last 90 days.
- The `items` and `milestones` those name.

Rows are per repository, so a caller asking in batches adds them up.
