---
title: Notifications
description: What needs you, and what you follow, as it happens. One thread per work item, pull request, workflow or deployment, with why you were told. Choose what you hear of with subscriptions, watching and email settings.
---

**Notifications** tell you when something needs you, or when something
happens to work you answer for or follow: someone asked you to review a
pull request, checks failed on your pull
request, a deployment failed, someone mentioned you. You are never told
about what you did yourself.

Open them from the bell in the top bar, or from the bottom bar on a
phone. The number on it is what is unread. The bell at the right of the
page's header opens the same notifications in a panel beside the page; its
number is amber while something is waiting on you, red while a failure is
unread, and lavender otherwise.

## Threads

Notifications hold one **thread** for each thing you were told about:

- a [work item](/work/work-items/)
- a pull request
- a workflow on one branch
- a deployment: a project's production, or one pull request's preview
- a workflow run waiting for your review to deploy to an environment
- a repository's security alerts of one kind: its secrets, its code
  scanning alerts, or its vulnerable dependencies (see [Security](#security))
- your security digest for a workspace

When something new happens on a thread, it comes back to the top of your
notifications, unread, even if you had marked it done. It is not added a second
time. A thread that is snoozed stays snoozed until its time.

Each card shows the latest activity's title, why you were told (see
[reasons](#reasons)), and, when more than one thing has happened, how many,
such as **3 updates**. g1t keeps the last 10 activities of each thread.

While a thread is unread it keeps the most urgent of what happened since
you last read it. A failure followed by a comment still shows as a failure
until you read it.

## Reasons

Every thread says why you were told of its latest activity. When you are
told of one thing for more than one reason, the first that applies in this
table is shown.

| Reason | Shown as | Why you were told |
| --- | --- | --- |
| `review_requested` | review requested | Someone asked you, or a team you are in, to review a pull request; it changes files you own; or you are one of its reviewers. Also a workflow run waiting for you, as one of an [environment's reviewers](/guides/actions/#environments), to approve its deployment, and, for a workspace's owners, a member's token made for the workspace waiting for [approval](/guides/authentication/#a-workspaces-rules-for-tokens) (in Notifications only, never emailed). |
| `assign` | assigned | You were assigned, or you are an assignee. |
| `mention` | mentioned | Someone mentioned you with `@username`, or you were mentioned on it before. |
| `team_mention` | team mentioned | Someone mentioned a [team](/guides/teams/#mentions) you are in with `@workspace/team`, or a team you are in was mentioned on it before. |
| `ci_activity` | CI activity | A check, workflow or deployment on your work finished badly. |
| `security_alert` | security alert | A scan found new secrets, code scanning alerts or vulnerable dependencies on a repository you look after (one thread per repository and kind; see [Security](#security)), a push of yours that push protection refused, a [vulnerability report](/guides/security/advisories/#private-vulnerability-reporting) sent to a repository you look after, a [bypass request](/guides/security/secret-protection/#delegated-bypass) to review or its answer, or your security digest. The workspace's owners and security managers hear of these; watchers who chose **Security alerts** do too, if they can see findings. |
| `state_change` | state changed | It was closed, reopened or merged, or auto-merge you turned on was turned off. |
| `author` | your work | You opened it. Also an owner's answer to your [token made for a workspace](/guides/authentication/#create-a-token) waiting for approval, or its revocation. |
| `comment` | commented | You commented on it. |
| `manual` | subscribed | You subscribed to it yourself. |
| `subscribed` | watching | You watch its repository. |

## What lands there

Each item comes from something that happened on g1t. Who is told depends on
what it was:

| What happened | Who is told | Reason | Shown as |
| --- | --- | --- | --- |
| Someone asked for reviews on a pull request, or opened one with reviewers | The reviewers asked | `review_requested` | Needs you |
| Someone asked a team to review a pull request | Everyone in the team and its child teams, or, with [review assignment](/guides/teams/#review-assignment), the people picked | `review_requested` | Needs you |
| A workflow run's jobs wait for an [environment's reviewers](/guides/actions/#environments) | Each reviewer, and everyone in a reviewing team ("Deploy is waiting for your review to deploy to production in acme/api"), but not whoever started the run when it may not approve it | `review_requested` | Needs you |
| A pull request changes files a [CODEOWNERS file](/guides/codeowners/) gives you or your team | The owners asked: "acme/api#42 changes files you own" | `review_requested` | Needs you |
| Someone assigned people to a work item or pull request, or opened one with assignees | The people newly assigned | `assign` | Info |
| Checks failed, or could not run, on a pull request | The person the pull request belongs to | `ci_activity` | Error |
| A workflow failed on a pull request | The person the pull request belongs to | `ci_activity` | Error |
| A workflow failed on a branch | Whoever pushed the commit it ran on | `ci_activity` | Error |
| A preview of a pull request failed to deploy | The person the pull request belongs to, and people watching deployments | `ci_activity`, or `subscribed` for watchers | Error |
| Production failed to deploy | Whoever pushed or started it, and people watching deployments | `ci_activity`, or `subscribed` for watchers | Error |
| A deployment went live | People watching deployments. It also [settles](#threads-that-settle-themselves) the failure before it | `subscribed` | Success |
| [Auto-merge](/guides/pull-requests/#auto-merge) was turned off by someone else, or by g1t because the pull request can no longer merge on its own | Whoever turned it on. Not when g1t handed the pull request to the merge queue, which lands it | `state_change` | Needs you |
| A pull request was merged, or a work item or pull request was closed | Its thread's history, for everyone subscribed to it and people watching its kind; the thread [settles](#threads-that-settle-themselves) at once, so it is neither unread nor pushed to you | `state_change`, or `subscribed` for watchers | Success for a merge, else Info |
| A work item was reopened | Everyone subscribed to it, and people watching work items in a repository linked to it | `state_change`, or `subscribed` for watchers | Info |
| Someone mentioned you with `@username` in a comment | You | `mention` | Info |
| Someone mentioned a team with `@workspace/team` in a comment, or in a work item or pull request they opened | Everyone in the team and its child teams, when the team's notifications are on and the writer can see the team | `team_mention` | Info |
| Someone commented on a work item or pull request | Everyone subscribed to it, and people watching its kind | Why each is subscribed, or `subscribed` for watchers | Info, or Success for an approval |
| A work item or pull request was opened | People watching its kind | `subscribed` | Info |

"The person a pull request belongs to" is its author. An approval or a
request for changes always reaches that person. A mention in code or in a
quoted line does not count.

You only see items about repositories and work items you can read. If you
lose access to a repository, its items leave your notifications the next
time you open them.

## Threads that settle themselves

A thread that leaves you nothing to do moves to Done by itself, read, the
moment what it told you of is over: a later run passes, the pull request
merges, the review is no longer asked of you. It leaves your unread count,
the bell, [Home](/guides/home/#where-youre-needed)'s **Where you're
needed** and `g1t status`, and
stays under **Done** with its history. New activity brings it back, as with
any thread.

| A thread about | Settles when |
| --- | --- |
| Anything on a work item or pull request | The pull request is merged or closed, or the work item is closed. A pull request's previews settle with it |
| Your own thread on a work item or pull request | You comment on it or review it |
| A review asked of you | The request to you, or to your team, is removed |
| Checks that failed on your pull request | Its checks pass on its latest commit |
| A workflow that failed on a branch | That workflow passes on that branch |
| A deployment that failed | That project's production, or that preview, deploys |
| A deployment waiting for your review | Its workflow run ends, however it ended |
| A push protection bypass to review | Someone decides it |
| A member's token waiting for your approval | An owner approves, denies or revokes it |
| A workspace invitation | It is accepted, declined or revoked |
| A repository's security alerts | A scan finds none of that kind open |
| g1t stopping on a change it made for you | It picks back up, its head moves, a merge is asked for, or it is merged or closed |

A thread that settled by itself says why under its title in **Done**, in
a few words, and who did it when someone did: **CI passed in run 330**,
**Merged by @ana**, **Production of site deployed at 8e30fb4**,
**Review no longer asked of you**. A thread you marked done yourself says
nothing there. [Home](/guides/home/#settled-for-you) lists what
settled for you since your last visit.

A notification that settled is no longer shown again: tabs you open later
do not replay it, and tabs already open drop it from their recent list.

What g1t does itself and leaves nothing for you to do is never a
notification: what landed and what deployed is on [Home](/guides/home/).

## Subscriptions

You are **subscribed** to a work item or pull request, and hear of what
happens on it, without doing anything when you:

- opened it, or asked g1t for it
- are assigned to it
- are one of its reviewers
- commented on it
- were mentioned in it, by name or through a team

You can also subscribe to any work item or pull request yourself, or
unsubscribe from one.

| You are | You hear of |
| --- | --- |
| Subscribed | Everything in [What lands there](#what-lands-there) that goes to everyone subscribed: comments, closes, reopens and merges. |
| Unsubscribed | Only what is asked of you or is about your own work: a review request, an assignment, a mention of you or your team, and failed checks, workflows and deployments. Commenting on it, or being mentioned in it, subscribes you again. |
| Ignoring it | Nothing on it at all, not even a mention. Only you can undo this. |

To subscribe to a work item or pull request, or unsubscribe:

1. Open the work item or pull request.
2. In the sidebar, under **Notifications**, select **Subscribe** or
   **Unsubscribe**.

The line under the button says where you stand, such as "You're subscribed
because you were assigned.", "You're not subscribed. You'll still hear if
you're mentioned or asked to review." or "You ignore this thread."

To ignore a work item or pull request, use the API:
`PUT /notifications/threads/{id}/subscription`, or for a work item
`PUT /workspaces/{workspace}/work/{number}/subscription`, with
`"ignored": true`, or the `notifications` tool's `subscribe` action with
`ignored`. See [from the API](#from-the-api). While
you ignore one, its button reads **Stop ignoring**, which puts you back to
the default: subscribed only while you take part.

## Watching a repository

How you **watch** a repository decides what you hear of on it beyond what
you take part in.

| Level | You hear of |
| --- | --- |
| **Participating and @mentions** | Only what you take part in or are mentioned in. The default. |
| **All activity** | Also every work item linked to it and every pull request opened, commented on, closed, reopened or merged, and every deployment. |
| **Ignore** | Nothing on the repository at all, not even a mention or a review request. |
| **Custom** | What you take part in, and the kinds you choose: **Work items** (those linked to the repository), **Pull requests**, **Deployments** and **Security alerts**. Security alerts reach only those with Write on the repository, who can see its findings. |

To change how you watch a repository:

1. Open the repository.
2. In the header, open the **Watch** menu.
3. Select a level. For **Custom**, tick the kinds you want. Unticking
   every kind puts you back on **Participating and @mentions**.

A repository you create is watched the way you choose in
[your settings](#settings): **All activity** unless you change it.

## Pages that update live

A repository's pages keep up with it while you are on them, without a
reload and whatever you watch: new commits, pull requests, checks, runs
and comments appear as they happen. So do a workspace's Work pages, for
its members.

| Page | Updates when |
| --- | --- |
| **Overview** and **Files** | A branch or tag is pushed, created or deleted, a check or run reports on a commit, a release is published, or a deployment moves. |
| **Commits** | Commits are pushed to the branch. They wait under a **3 new commits · Show** bar at the top instead of moving the list while you read; checks on the commits shown update in place. |
| **Branches** | A branch is pushed, created, renamed or deleted. |
| **Tags** | A tag is pushed or deleted, or a release is published. |
| **Pull requests** | One is opened, updated, reviewed, commented on, checked, merged or closed. |
| **Work**, filtered or not, and its **Board** | Any of the workspace's work items is opened, changed, labeled, linked, claimed, commented on, closed or reopened. |
| Work's **Sessions** | A session in one of the workspace's repositories starts, records or ends. |
| A **pull request** | Commits are pushed to it, its checks report, someone reviews or comments, or it is merged or closed. New items join its timeline where you are reading; if you are at the end of the page, it follows them down. |
| A **work item** | Someone comments on it or changes it, links a repository, claims it, or a pull request for it lands. If you are at the end of the page, it follows new items down. |
| **Actions** and a **run** | A run starts, one of its jobs starts or finishes, or the run finishes. A running job's log streams on its own. |
| **Security** | An alert is opened, fixed, dismissed or reopened. |
| Your workspace's **Home** | Something lands, runs, deploys or comes to need you in its projects (the first 25). See [Home](/guides/home/#while-the-page-is-open). |

A page refreshes a second after the last change it shows, so a burst of
them is one refresh. It never refreshes while you are typing in it or have
a dialog open: the change waits until you leave the field or close the
dialog. A tab you are not looking at refreshes at most once a minute, and
as soon as you come back to it.

How it works: each signed-in tab keeps one live connection to g1t (the
same one that brings notifications and chat counts). Opening a
repository's page asks to follow that repository, and g1t first checks you
can read it. From then on, every push, pull request, work item linked to it, comment,
review, check, run, release and security alert there sends that tab a
short note naming only what kind of thing changed and where: a branch, a
number, a commit. Never a title, a message or code. The page then reads
itself again, with your access as it is now. Following lasts fifteen
minutes and is renewed while the page stays open, so someone who loses
access stops hearing of the repository within that time.

A workspace's Work pages follow the workspace instead, since a work item
may link many repositories or none: opening one asks to follow the
workspace's work items, and g1t first checks you are a member. Each
change sends a note naming only what kind of thing changed and the work
item's number. The Work list reads itself again on any of them, a work
item's page on its own. Following lasts fifteen minutes and is renewed
the same way. Someone who is not a member, such as a reader of a public
repository's work items, gets the fallback below.

Signed out, on a public repository, or while the live connection is down,
pages fall back to checking for themselves: when you come back to the tab
(at most every 30 seconds), and once a minute while it is in view.

## Security

Security alerts are told the way they can be lived with. A scan that finds
forty vulnerabilities is one notification, not forty: each repository has
one thread per kind of alert (secrets, code scanning alerts, vulnerable
dependencies), titled by what the latest scan found, "3 new vulnerabilities
in acme/rocket: 1 critical, 2 high", with the worst new alert as its line.
The next scan brings the same thread back up to date rather than adding
another; a scan that only fixed or dismissed alerts refreshes it quietly,
"2 open vulnerabilities in acme/rocket: 2 high" with "1 fixed" in its
history, without waking you, and marks it done when nothing is left open.

What reaches you, and when, follows the alert's severity:

| Alert | Who | When |
| --- | --- | --- |
| Critical or high | The workspace's owners and security managers, and watchers who chose **Security alerts**. | At once, as an error, with a pop-up like a mention's. |
| A push of yours that push protection refused | You. | At once, whatever you chose. |
| A vulnerability report, a bypass request | The owners and security managers; the reviewers. | At once, as something waiting on you. |
| Medium or low | The same people. | In your **security digest**, once a day or once a week as you choose, or at once, or never. |
| A published advisory | Watchers who chose **Security alerts**. | At once, as information. |

The **security digest** is one notification and one email per workspace,
"Security digest for acme: 4 new medium vulnerabilities in 2 repositories,
1 new low secret in 1 repository", naming the newest alerts, sent in the
morning (UTC): every day, or on Mondays. Owners and security managers get
the urgent alerts whatever their settings say; those alerts are theirs to
act on. Everyone else can turn the urgent ones off too, and anyone can
choose how the rest arrive, in [Settings](#settings).

Fixes and dismissals never make a notification of their own. The findings
themselves are always on each repository's [Security page](/guides/security/).

## Email

You can also be emailed when you are told of something. By default, g1t
emails you for three reasons: **review requested**, **mentioned** and
**security alert**. Each time you are told of something
for a reason you chose, g1t sends one email with what happened and a link
to it; a security digest is one email.

An email is sent only when:

- your account's email address is confirmed, and
- you can still read the repository it is about.

The foot of each email says why you got it, and links to
[g1t.sh/settings/notifications](https://g1t.sh/settings/notifications).

## On your phone

[The phone app](/guides/mobile/) gets the same notifications as
[browser notifications](/guides/chat/#notifications), under the same
rules:

- only what you chose under **Notify me about**, for each workspace;
- never while **Do not disturb** is on;
- nothing from a conversation you [muted](/guides/chat/#star-and-mute),
  but a direct message or a mention of you;
- nothing while a g1t tab, or the app itself, is in front of you: it tells you there.

Your phone is registered when you allow notifications in the app.
**Send a test notification**, here or in the app under **More**, reaches it too. Signing out of the app stops
them on that phone. g1t pushes to your 10 most recent phones, and stops
on its own for a phone the app was removed from. Phones are reached
through Expo's push service, which hands each notification to Google
(Android) or Apple (iOS); a [self-hosted g1t](/guides/self-hosting/#the-phone-app)
can turn that off.

## Settings

**Settings → Notifications**, at
[g1t.sh/settings/notifications](https://g1t.sh/settings/notifications),
holds your choices:

| Setting | What it does | Default |
| --- | --- | --- |
| **Sounds**, **Sound set**, **Volume**, one switch per sound | What chat sounds like; see [Sounds and do not disturb](/guides/chat/#sounds-and-do-not-disturb). | On, Soft, 60, all but Sent |
| **Do not disturb** | Silences sounds, pop-ups, and browser and phone notifications until a time you choose. | Off |
| **Desktop notifications** | A system notification from an open tab for a message to you while the window is behind another. In [the desktop app](/guides/desktop/) it is on, and the app shows them itself. | Off |
| **Notify me about**, **Browser notifications** | What pops up and is pushed; see [chat notifications](/guides/chat/#notifications). | DMs and mentions; off |
| **Email** | One checkbox per reason: you are also emailed when you are told of something for it. | review requested, mentioned, security alert |
| **Security: Critical and high alerts at once** | Whether urgent alerts on repositories you watch for security reach you at once. The workspaces you own or manage security for tell you whatever this says. | On |
| **Security: Medium and low alerts** | In a daily digest, in a weekly digest, at once, or not at all. | Daily digest |
| **Repositories you create** | How you watch a new repository you create: **Participating and @mentions** or **All activity**. | All activity |
| **Watched repositories** | Every repository you watch other than the default way, with how. | |

## Tabs

| Tab | Shows |
| --- | --- |
| **All** | Everything, with what is waiting on you first |
| **Needs you** | What is waiting on you, such as a review asked of you |
| **Errors** | Failed checks, workflows and deployments |
| **Success** | Merges, approvals, and deployments that went live |
| **Info** | Mentions, comments, assignments, and what you watch |

The count beside each tab is what is unread under it.

## The Notifications page

The bell in the top bar opens
[g1t.sh/notifications](https://g1t.sh/notifications): every thread, a page
at a time, under the same tabs. Its sidebar chooses what you look at:

| In the sidebar | Shows |
| --- | --- |
| **Everything** | Threads you have not marked done, with how many are unread |
| **Saved** | Threads you saved, done or not |
| **Done** | Threads you marked done. Select ↶ on one to move it back |
| **Why you were told** | Only threads told for one [reason](#reasons), or **Any reason** |

The reason is kept in the address as `?reason=`, such as
[g1t.sh/notifications?reason=review_requested](https://g1t.sh/notifications?reason=review_requested),
so you can bookmark it. On a phone, and on a narrow window, where the
sidebar is a drawer, the page shows the views as tabs and the reason as a
menu above the list.

## Work through it

1. Open the Notifications page, or select the bell in the page's header to
   work through them in a panel beside the page.
2. Select an item to open what it is about. It is marked read, and the
   panel closes.
3. Point at an item (on a phone, the buttons are always there) to act on it
   without opening it:

| Action | What it does |
| --- | --- |
| **Done** (✓) | Moves the thread out of Everything and into Done, until something new happens on it |
| **Mark as read** / **Mark as unread** | Changes whether it counts as unread |
| **Save** | Keeps it under Saved, even after it is done |
| **Snooze until** | Hides it for 3 hours, until tomorrow, or for a week, then brings it back |

**Mark all read** marks everything under the tab you are on as read.
**Open Notifications**, at the foot of the panel, goes to the page.

[Home](/guides/home/) shows the unread warnings and failures waiting on you,
with what else needs you across the workspace.

## From the API

Everything here is also in the REST API and the MCP server, for a personal
access token or an OAuth sign-in, so a coding agent you connect can work
through your notifications as you. A workspace's token cannot use it.
Reading needs the `notifications:read` scope, and changing anything
`notifications:write`; the Agent [preset](/guides/authentication/#presets)
has both.

| Route | MCP action | What it does |
| --- | --- | --- |
| [`GET /notifications`](/reference/api/notifications/list-notifications/) | `list` | Your unread threads, latest first. Filter by `reason`, `severity`, `participating`, `since` and `before`; `all` adds read ones; `view` lists `saved` or `done`. |
| [`PUT /notifications`](/reference/api/notifications/mark-notifications-read/) | `mark_all_read` | Mark everything read up to `last_read_at`. |
| [`GET /notifications/threads/{id}`](/reference/api/notifications/get-notification-thread/) | `get` | One thread, its last 10 activities, and your subscription. |
| [`PATCH /notifications/threads/{id}`](/reference/api/notifications/mark-thread-read/) | `mark_read` | Mark a thread read, or unread. |
| [`DELETE /notifications/threads/{id}`](/reference/api/notifications/mark-thread-done/) | `done` | Mark a thread done. |
| [`PUT /notifications/threads/{id}/saved`](/reference/api/notifications/save-thread/) | `save` | Save a thread; `DELETE` unsaves it. |
| [`PUT /notifications/threads/{id}/snooze`](/reference/api/notifications/snooze-thread/) | `snooze` | Snooze a thread until `until`; `DELETE` brings it back. |
| [`PUT /workspaces/{workspace}/work/{number}/subscription`](/reference/api/notifications/set-work-item-subscription/) | `subscribe` | Subscribe to a work item, unsubscribe, or ignore it. `GET` reads it and `DELETE` unsubscribes. The same works at `/notifications/threads/{id}/subscription`, for a work item or a pull request. |
| [`PUT /repos/{owner}/{name}/subscription`](/reference/api/notifications/set-repo-subscription/) | `watch` | Watch a repository at a `level`. `GET` reads it and `DELETE` goes back to the default. |
| [`GET /user/subscriptions`](/reference/api/notifications/list-watched-repos/) | `watched` | The repositories you watch other than the default way. |

`GET /repos/{owner}/{name}/notifications` and
`PUT /repos/{owner}/{name}/notifications` list and mark one repository's
threads. A thread's `subject` is what it is about: `item` for a work
item, `pull`, `run` or `deploy`. A work item's thread id is `item:` and the work
item's id. Watching a repository at **Custom** takes the kinds
`work_items`, `pulls`, `deployments` and `security`. Every action of the `notifications` tool is in
[MCP tools](/reference/mcp/#notifications).

For example, to list the reviews waiting on you:

```sh
curl "https://api.g1t.sh/notifications?reason=review_requested" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

## How long items are kept

Threads you mark done are removed 30 days after you mark them. Any other
thread is removed once nothing has happened on it for 180 days. Saved
threads are kept until you unsave them.
