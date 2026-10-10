---
title: Notifications
description: What needs you, and what you follow, as it happens. One thread per issue, pull request, workflow or deployment, with why you were told. Choose what you hear of with subscriptions, watching and email settings.
---

**Notifications** tell you when something needs you, or when something
happens to work you answer for or follow: an agent is waiting on you,
someone asked you to review a pull request, checks failed on your pull
request, a deployment failed, someone mentioned you. You are never told
about what you did yourself.

Open them from **Notifications** in the dock, or from the bottom bar on a
phone. The number on it is what is unread. The bell at the right of the
page's header opens the same notifications in a panel beside the page; its
number is amber while something is waiting on you, red while a failure is
unread, and lavender otherwise.

## Threads

Notifications hold one **thread** for each thing you were told about:

- an issue
- a pull request
- a workflow on one branch
- a deployment: a project's production, or one pull request's preview
- a workflow run waiting for your review to deploy to an environment

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
| `agent` | agent waiting | An agent is waiting on you: it asked a question, or it stopped until a person steps in. |
| `review_requested` | review requested | Someone asked you, or a team you are in, to review a pull request; it changes files you own; or you are one of its reviewers. Also a workflow run waiting for you, as one of an [environment's reviewers](/guides/actions/#environments), to approve its deployment, and, for a workspace's owners, a member's token made for the workspace waiting for [approval](/guides/authentication/#a-workspaces-rules-for-tokens) (in Notifications only, never emailed). |
| `assign` | assigned | You were assigned, or you are an assignee. |
| `mention` | mentioned | Someone mentioned you with `@username`, or you were mentioned on it before. |
| `team_mention` | team mentioned | Someone mentioned a [team](/guides/teams/#mentions) you are in with `@workspace/team`, or a team you are in was mentioned on it before. |
| `ci_activity` | CI activity | A check, workflow or deployment on your work finished badly, or recovered. |
| `security_alert` | security alert | A new secret, code scanning or vulnerability alert on a repository you look after, a push of yours that push protection blocked, or a [bypass request](/guides/security/secret-protection/#delegated-bypass) to review or its answer. The workspace's owners hear of new alerts; watchers who chose **Security alerts** do too, if they can see findings. |
| `state_change` | state changed | It was closed, reopened or merged. |
| `author` | your work | You opened it, or you asked g1t for it. Also an owner's answer to your [token made for a workspace](/guides/authentication/#create-a-token) waiting for approval, or its revocation. |
| `comment` | commented | You commented on it. |
| `manual` | subscribed | You subscribed to it yourself. |
| `subscribed` | watching | You watch its repository. |

## What lands there

Each item comes from something that happened on g1t. Who is told depends on
what it was:

| What happened | Who is told | Reason | Shown as |
| --- | --- | --- | --- |
| An agent asked a question of the agent on a pull request, or handed it work | The person the pull request belongs to, and its issue's author and assignees | `agent` | Needs you |
| g1t stopped on a pull request until a person steps in | The same people | `agent` | Needs you |
| Someone asked for reviews on a pull request, or opened one with reviewers | The reviewers asked | `review_requested` | Needs you |
| Someone asked a team to review a pull request | Everyone in the team and its child teams, or, with [review assignment](/guides/teams/#review-assignment), the people picked | `review_requested` | Needs you |
| A workflow run's jobs wait for an [environment's reviewers](/guides/actions/#environments) | Each reviewer, and everyone in a reviewing team ("Deploy is waiting for your review to deploy to production in acme/api"), but not whoever started the run when it may not approve it | `review_requested` | Needs you |
| A pull request changes files a [CODEOWNERS file](/guides/codeowners/) gives you or your team | The owners asked: "acme/api#42 changes files you own" | `review_requested` | Needs you |
| Someone assigned people to an issue or pull request, or opened one with assignees | The people newly assigned | `assign` | Info |
| Checks failed, or could not run, on a pull request | The person the pull request belongs to | `ci_activity` | Error |
| A workflow failed on a pull request | The person the pull request belongs to | `ci_activity` | Error |
| A workflow failed on a branch | Whoever pushed the commit it ran on | `ci_activity` | Error |
| A preview of a pull request failed to deploy | The person the pull request belongs to, and people watching deployments | `ci_activity`, or `subscribed` for watchers | Error |
| Production failed to deploy | Whoever pushed or started it, and people watching deployments | `ci_activity`, or `subscribed` for watchers | Error |
| A deployment went live | People watching deployments; after a failure, also whoever was told of the failure | `ci_activity`, or `subscribed` for watchers | Success |
| g1t finished a change and marked it ready for review | The person who asked g1t for it | `author` | Success |
| g1t reviewed a pull request | The person the pull request belongs to | `author` | Success when approved, Info when it asks for changes |
| A pull request was merged | Everyone subscribed to it, and people watching pull requests | `state_change`, or `subscribed` for watchers | Success |
| An issue or pull request was closed, or an issue was reopened | Everyone subscribed to it, and people watching its kind | `state_change`, or `subscribed` for watchers | Info |
| Someone mentioned you with `@username` in a comment | You | `mention` | Info |
| Someone mentioned a team with `@workspace/team` in a comment, or in an issue or pull request they opened | Everyone in the team and its child teams, when the team's notifications are on and the writer can see the team | `team_mention` | Info |
| Someone commented on an issue or pull request | Everyone subscribed to it, and people watching its kind | Why each is subscribed, or `subscribed` for watchers | Info, or Success for an approval |
| One of your workspace's agents commented on or reviewed an issue or pull request, as itself | The same people, and the person the pull request belongs to for a review; shown as from "Margo (agent)", with "(advisory)" on a review. See [agent reviews](/guides/pull-requests/#agent-reviews) | Why each is subscribed, or `author` for a review | Info, or Success for an approval |
| An issue or pull request was opened | People watching its kind | `subscribed` | Info |

"The person a pull request belongs to" is its author, or, for a change g1t
made, the person who asked for it. An approval or a request for changes
always reaches that person. g1t itself is never told. A mention in code or
in a quoted line does not count.

Some threads close themselves once they no longer need you:

- When an agent was waiting on you, the thread moves to Done as soon as the
  agent picks back up: it resumes, its pull request changes, a merge is
  asked for, or the pull request is merged or closed.
- When a review request to you is removed, that thread moves to Done.

New activity brings either back, as with any thread.

You only see items about repositories you can read. If you lose access to a
repository, its items leave your notifications the next time you open them.

## Subscriptions

You are **subscribed** to an issue or pull request, and hear of what
happens on it, without doing anything when you:

- opened it, or asked g1t for it
- are assigned to it
- are one of its reviewers
- commented on it
- were mentioned in it, by name or through a team

You can also subscribe to any issue or pull request yourself, or
unsubscribe from one.

| You are | You hear of |
| --- | --- |
| Subscribed | Everything in [What lands there](#what-lands-there) that goes to everyone subscribed: comments, closes, reopens and merges. |
| Unsubscribed | Only what is asked of you or is about your own work: an agent waiting on you, a review request, an assignment, a mention of you or your team, and failed checks, workflows and deployments. Commenting on it, or being mentioned in it, subscribes you again. |
| Ignoring it | Nothing on it at all, not even a mention. Only you can undo this. |

To subscribe to an issue or pull request, or unsubscribe:

1. Open the issue or pull request.
2. In the sidebar, under **Notifications**, select **Subscribe** or
   **Unsubscribe**.

The line under the button says where you stand, such as "You're subscribed
because you were assigned.", "You're not subscribed. You'll still hear if
you're mentioned or asked to review." or "You ignore this thread."

To ignore an issue or pull request, use the API:
`PUT /repos/{owner}/{name}/issues/{number}/subscription` with
`"ignored": true`, or the `notifications` tool's `subscribe` action with
`ignored`. See [from the API and agents](#from-the-api-and-agents). While
you ignore one, its button reads **Stop ignoring**, which puts you back to
the default: subscribed only while you take part.

## Watching a repository

How you **watch** a repository decides what you hear of on it beyond what
you take part in.

| Level | You hear of |
| --- | --- |
| **Participating and @mentions** | Only what you take part in or are mentioned in. The default. |
| **All activity** | Also every issue and pull request opened, commented on, closed, reopened or merged, and every deployment. |
| **Ignore** | Nothing on the repository at all, not even a mention or a review request. |
| **Custom** | What you take part in, and the kinds you choose: **Issues**, **Pull requests**, **Deployments** and **Security alerts**. Security alerts reach only those with Write on the repository, who can see its findings. |

To change how you watch a repository:

1. Open the repository.
2. In the header, open the **Watch** menu.
3. Select a level. For **Custom**, tick the kinds you want. Unticking
   every kind puts you back on **Participating and @mentions**.

A repository you create is watched the way you choose in
[your settings](#settings): **All activity** unless you change it.

## Email

You can also be emailed when you are told of something. By default, g1t
emails you for three reasons: **agent waiting**, **review requested** and
**mentioned**. Each time you are told of something for a reason you chose,
g1t sends one email with what happened and a link to it.

An email is sent only when:

- your account's email address is confirmed, and
- you can still read the repository it is about.

The foot of each email says why you got it, and links to
[g1t.sh/settings/notifications](https://g1t.sh/settings/notifications).

## Settings

**Settings → Notifications**, at
[g1t.sh/settings/notifications](https://g1t.sh/settings/notifications),
holds your choices:

| Setting | What it does | Default |
| --- | --- | --- |
| **Email** | One checkbox per reason: you are also emailed when you are told of something for it. | agent waiting, review requested, mentioned |
| **Repositories you create** | How you watch a new repository you create: **Participating and @mentions** or **All activity**. | All activity |
| **Watched repositories** | Every repository you watch other than the default way, with how. | |

## Tabs

| Tab | Shows |
| --- | --- |
| **All** | Everything, with what is waiting on you first |
| **Needs you** | What is waiting on you: an agent, or a review asked of you |
| **Errors** | Failed checks, workflows and deployments |
| **Success** | Merges, approvals, finished agent work, and deployments that went live |
| **Info** | Mentions, comments, assignments, and what you watch |

The count beside each tab is what is unread under it.

## The Notifications page

**Notifications** in the dock opens
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

## From the API and agents

Everything here is also in the REST API and the MCP server, for a personal
access token or an OAuth sign-in. A workspace's token cannot use it, and
neither can g1t's own agents: they act as `g1t`, which has no notifications.
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
| [`PUT /repos/{owner}/{name}/issues/{number}/subscription`](/reference/api/notifications/set-issue-subscription/) | `subscribe` | Subscribe to an issue or pull request, unsubscribe, or ignore it. `GET` reads it and `DELETE` unsubscribes. The same works at `/notifications/threads/{id}/subscription`. |
| [`PUT /repos/{owner}/{name}/subscription`](/reference/api/notifications/set-repo-subscription/) | `watch` | Watch a repository at a `level`. `GET` reads it and `DELETE` goes back to the default. |
| [`GET /user/subscriptions`](/reference/api/notifications/list-watched-repos/) | `watched` | The repositories you watch other than the default way. |

`GET /repos/{owner}/{name}/notifications` and
`PUT /repos/{owner}/{name}/notifications` list and mark one repository's
threads. Every action of the `notifications` tool is in
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
