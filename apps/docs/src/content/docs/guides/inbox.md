---
title: Your inbox
description: What needs you, and what you follow, as it happens. An agent waiting on you comes first; failures, merges, mentions and comments follow. Mark items read or done, save them, or snooze them.
---

Your **inbox** tells you when something needs you, or when something
happens to work you answer for: an agent is waiting on you, checks failed
on your pull request, g1t finished a change you asked for, someone mentioned
you. You are never told about what you did yourself.

Open it from the bell in the top bar. The number on the bell is what is
unread. It is amber while an agent is waiting on you, red while a failure is
unread, and green otherwise.

## What lands there

Each item comes from something that happened on g1t. Who is told depends on
what it was:

| What happened | Who is told | Shown as |
| --- | --- | --- |
| Another agent asked a question of the agent on a pull request, or handed it work | The person the pull request belongs to, and the issue's author and assignees | Needs you |
| Checks failed, or could not run, on a pull request | The person the pull request belongs to | Error |
| A workflow failed on a pull request | The person the pull request belongs to | Error |
| A workflow failed on a branch | Whoever pushed the commit it ran on | Error |
| g1t finished a change and marked it ready for review | The person who asked g1t for it | Success |
| g1t reviewed a pull request | The person the pull request belongs to | Success when approved, Info when it asks for changes |
| A pull request was merged | The person the pull request belongs to | Success |
| Someone mentioned you with `@username` in a comment | You | Info |
| Someone commented on an issue or pull request you opened | You | Info, or Success for an approval |

"The person a pull request belongs to" is its author, or, for a change g1t
made, the person who asked for it. g1t itself is never told. A mention in
code or in a quoted line does not count.

You only see items about repositories you can read. If you lose access to a
repository, its items leave your inbox the next time you open it.

## Tabs

| Tab | Shows |
| --- | --- |
| **All** | Everything, with what an agent is waiting on first |
| **Needs you** | What an agent is waiting on you for |
| **Errors** | Failed checks and workflows |
| **Success** | Merges, approvals and finished agent work |
| **Info** | Mentions and comments |

The count beside each tab is what is unread under it.

## Work through it

1. Select the bell in the top bar. The inbox opens beside the page.
2. Select an item to open what it is about. It is marked read, and the inbox
   closes.
3. Point at an item (on a phone, the buttons are always there) to act on it
   without opening it:

| Action | What it does |
| --- | --- |
| **Done** (✓) | Moves the item out of the inbox and into Done |
| **Mark as read** / **Mark as unread** | Changes whether it counts as unread |
| **Save** | Keeps it under Saved, even after it is done |
| **Snooze until** | Hides it for 3 hours, until tomorrow, or for a week, then brings it back |

**Mark all read** marks everything under the tab you are on as read.

## The full inbox

**Open inbox**, at the foot of the panel, goes to
[g1t.sh/inbox](https://g1t.sh/inbox). It has the same tabs, every item a page
at a time, and two more views:

| View | Shows |
| --- | --- |
| **Saved** | Items you saved, done or not |
| **Done** | Items you marked done. Select ↶ on one to move it back |

Mission control shows a **Needs you** card with the newest unread items an
agent is waiting on, then failures. It is hidden when there are none.

## How long items are kept

Items you mark done are removed after 30 days. Any item is removed after 180
days. Saved items are kept until you unsave them.
