---
title: Work items
description: Track any work, a feature, a bug or a chore, as a work item of your workspace. File it, number it once for the whole workspace, say who sees it, and link it to the repositories it starts in, lands in and touches.
---

A work item is anything your team means to do: a feature, a bug, a chore.
It belongs to the workspace, not to one repository, so work that spans a
service, its client and its docs is one item, with one number, one
conversation and one place that says what is done.

Work items are listed on [Work](/work/), at `g1t.sh/<workspace>/-/work`.
A work item's page is `g1t.sh/<workspace>/-/work/<number>`.

Work items used to be issues, one repository's each.
[Issues became work items](/work/from-issues/) says what changed for the
ones you had.

## What a work item has

- a **title** and a **description** in Markdown. Whoever works on it,
  person or agent, works from this text. Say what done means in plain
  words, under a `## Definition of done` heading if you like: it is
  context for whoever works on it and its reviewers, not something a merge
  waits on. A [task list](/work/task-lists/) (`- [ ]`) in it is a
  checklist whose boxes can be ticked on the page, from the CLI and over
  MCP;
- its **repositories**, each with a role: where it was filed, where it
  should land, and where work for it happened (see
  [below](#repositories-and-their-roles));
- **labels** and a **milestone**, both the workspace's: see
  [labels](/work/labels/) and [milestones](/work/milestones/);
- **comments**, **reactions** and up to 10 **assignees**, `g1t` among
  them if you like (see [assign g1t](/guides/sessions/#assign-g1t-or-ask-it-in-the-thread));
- what it is **blocked by**: other work items that must land first (see
  [dependencies](/work/claims-and-dependencies/#dependencies));
- a **parent** and **sub-items**: the work item it is part of, and the
  work items it was broken down into, with how many of them are done (see
  [sub-items](/work/sub-items/));
- a **state**: open or closed. A closed work item records why:
  `completed` or `not_planned`. One closed by what landed records each
  **resolution**: the repository, and the pull request or commit that
  landed it (see [closing work items](/work/closing/)).

## File a work item

On [Work](/work/), choose **New work item**:

1. Give it a **title** (up to 200 characters) and a **description**. Paste
   or drop images into the description, or select **Attach an image**
   under it; see [images](/guides/pull-requests/#images). Comments take
   them the same way.
2. Under **Where it lands**, tick the repositories it should land in, its
   targets: none, one or several. It closes once what closes it has landed
   in every one, or, with none, once anything does.
3. Tick its **labels**. With the Write role you can type new ones beside
   them, separated by commas.
4. With the Triage role, pick a **milestone**.
5. Choose **Open work item**.

Filed from Work filtered to a repository (`?repo=<name>`), that repository
is its **origin**, and starts ticked as a target too. Filed from Work
itself, it has no origin. A workspace with a tracker or Sentry connected
also offers to bring one in from there; see
[integrations](/guides/integrations/).

From the CLI, `g1t work new` files one in the current repository's
workspace, with the repository as its origin:

```sh
g1t work new --title "Sign-in times out on slow networks" --body "…"
g1t work new --title "Rename the flag" --target acme/api --target acme/docs
```

`--target` names a repository it should land in; repeat it for more.
`--workspace`, outside a repository of that workspace, files one with no
origin. In the [phone app](/guides/mobile/#work), **+ New** on Work does
the same. Agents file one with the `work_item` tool's `create`, or file
and claim one in a single step; see [working with agents](/work/agents/).

Who may file one:

- You need a confirmed email address.
- **With an origin**: anyone who may take part in the repository, which is
  anyone signed in for a public one. Work items must be turned on there
  (`has_work_items`, on unless the repository is a fork; see
  [managing a repository](/guides/managing-repositories/)), and the
  repository must not be archived. Naming targets as you file needs the
  Triage role.
- **With no origin**: members of the workspace.

Opening a work item is a `work_item.opened` event.

## One number for the workspace

Work items and pull requests share one sequence of numbers per workspace,
so `#12` names exactly one thing in it. Pull requests still live in their
repository, at `g1t.sh/<owner>/<repo>/pull/<number>`, but a new one takes
the workspace's next number. Pull requests opened before work items keep
the numbers they had.

Wherever Markdown shows, in a description, a comment, a commit message or
chat, a reference links to what it names:

| You write                   | It names                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#12`, in a repository      | That repository's pull request #12, else the work item that was its issue #12, else the workspace's work item #12, else pull request #12 in another of the workspace's repositories, if it was opened after work items came |
| `#12`, outside a repository | The workspace's work item #12, else its pull request #12 opened after work items came                                                                                                                                       |
| `owner/name#12`             | `#12` as it reads in repository `owner/name`                                                                                                                                                                                |
| `workspace#12`              | Work item or pull request #12 of another workspace                                                                                                                                                                          |

A pull request opened before work items is numbered in its repository
alone, so several may share a number: only a repository's own, or
`owner/name#12`, names one. What you may not see is passed over for the
next in line, and a repository you may not read reads as one that does
not exist. Text in code,
`` `#12` `` or a code block, is never a reference.

So old references keep working: `#12` written about an issue before work
items, `owner/repo#12`, and `Closes #12` in a commit, all reach the work
item that issue became.

## Who sees a work item

- The workspace's members see every work item.
- Anyone who can read a work item's origin repository sees it. Work items
  filed in a public repository are public.
- A work item with no origin is seen only by members.

## Who can do what

Your role on a work item is the higher of your
[role](/guides/access-and-roles/) in the workspace and your role in its
origin repository.

| To                                                                                                                                           | You need                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Comment and react                                                                                                                            | To be signed in and see it                                                                                    |
| Edit its title and description (and tick its task list's boxes), change its labels, assignees and what it is blocked by, close and reopen it | To be its owner, or the Triage role. Its owner is its author, or, for one g1t filed for someone, that person. |
| Put it in a milestone                                                                                                                        | The Triage role                                                                                               |
| Link and unlink repositories                                                                                                                 | The Triage role                                                                                               |
| Make a new label as you label it                                                                                                             | The Write role                                                                                                |

A work item carries at most 20 labels and 10 assignees.

## Repositories and their roles

A work item links any number of the workspace's repositories, each in one
role:

| Role      | Means                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `origin`  | The repository it was filed in. A work item filed from a repository has one; one filed on **Work** itself has none. It never changes. |
| `target`  | A repository the work is meant to land in. It closes once every target has landed.                                                    |
| `touched` | A repository where a pull request or commit for it landed or is in progress.                                                          |

g1t links `touched` repositories itself: when a pull request is opened
for the work item, when a pull request or commit lands it, and when one
says it is `Part of` it (see [closing work items](/work/closing/#part-of-and-refs)).
It never changes a link that is already there.

A work item's page lists its repositories, each with its role, the old
issue number it had there (**was #4**), its pull requests for the item
and how each stands, and **Landed** or, for a target that has not,
**Missing**. Above them it says how many targets are still to land.

With the Triage role:

- **Link a repository** adds one, as a **Target** or **Touched**. Linking
  a repository already linked changes its role.
- The cross beside a repository unlinks it. The origin cannot be unlinked.

Each is noted in the conversation (**added acme/api as a target**,
**unlinked acme/docs**), and is a `work_item.linked` or
`work_item.unlinked` event, with the `repo` and its `role`.

### Suggested targets

Work items often need more repositories than whoever filed them thought
of. While a work item is open, its page lists under **Suggested** up to
five other repositories of the workspace it may also need, each with why:

- work items with the same labels, or with words of their titles in
  common, landed there before;
- its title or description names the repository;
- sessions on the work item changed files there.

Choose **Add as target** to link one as a target (Triage role). Agents
get the same list, as `suggested_targets` in the work item's
[work context](/work/agents/#pick-up-a-work-item), and the phone app shows
it too.

## A work item's page

A work item's page reads top to bottom, with its properties in a panel at
the right:

- **The header**: where it is (its project, or Work, then the work item it
  is a sub-item of), its place in the list you opened it from with
  **Previous** and **Next**, **Start agent**, and the **⋯** menu.
- **The title and description.** Press <kbd>E</kbd>, or the pencil beside
  the title, to edit both in place; <kbd>Ctrl</kbd> <kbd>Enter</kbd>
  (<kbd>⌘</kbd> <kbd>Enter</kbd> on a Mac) saves and <kbd>Esc</kbd> puts
  them back. Its task list can be ticked where it is.
- **Sub-items**: how far along they are, and adding one (see
  [sub-items](/work/sub-items/)).
- **Work**: everything being done for it, in one place. A banner for each
  repository it **landed in**, a combination that failed in the merge
  queue if one still stands, then each repository in its role with its
  pull requests (state, checks, place in the merge queue) and whether the
  work landed there, the repositories it **may also need** with **Add as
  target**, who is **on it** (its claims, and those that ended lately),
  and its **sessions**, each linked to its page in Chat (see
  [claims and dependencies](/work/claims-and-dependencies/)).
- **Decisions**, folded under a line that says how many: its
  [decision records](/guides/why-blame/#decision-records).
- **Activity**: what people wrote and what happened, oldest first, in one
  stream: comments, its sessions where each started, claims and handoffs,
  and the notes g1t writes. **All**, **Comments** and **Events** filter
  it. The comment box is at the bottom; <kbd>Ctrl</kbd> <kbd>Enter</kbd>
  (<kbd>⌘</kbd> <kbd>Enter</kbd>) sends.

### Its properties

Each property in the panel opens a picker you can drive with the
keyboard alone: type to narrow it, <kbd>↑</kbd> <kbd>↓</kbd> to move,
<kbd>Enter</kbd> to choose. In a picker that takes several (assignees,
labels, blocked by), <kbd>Enter</kbd> ticks and <kbd>Esc</kbd> saves.

| Property       | Key          | What it holds                                                                                                                                                       |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stage**      |              | Where it stands, read from what is so, never set by hand, with why: "In review: #318 open in acme/web". The same stages as the [board](/work/board/).               |
| **Assignees**  | <kbd>A</kbd> | People, you first, anyone by username, and **g1t**, which takes it on in a session on the workspace's Claude where that is set up (Triage role).                    |
| **Agent**      | <kbd>D</kbd> | Who is working on it now: each live session and where it stands. <kbd>D</kbd> opens **Start an agent**.                                                             |
| **Project**    | <kbd>P</kbd> | The [project](/work/projects/) it is in, or none (Triage role).                                                                                                     |
| **Cycle**      | <kbd>Y</kbd> | While [cycles](/work/cycles/) are on: the current cycle (which is Now), the coming one, or none. <kbd>Shift</kbd> <kbd>Y</kbd> moves it to the next cycle.          |
| **Plan**       | <kbd>H</kbd> | Its horizon, appetite, urgent, and a budget: type a number of dollars, such as `5`. In Triage, g1t's suggestion with **Accept**; in Now, how it stands on the hill. |
| **Milestone**  | <kbd>M</kbd> | One of the workspace's open milestones, or none (Triage role).                                                                                                      |
| **Labels**     | <kbd>L</kbd> | Tick labels on and off, find one, or make one if you may manage labels.                                                                                             |
| **Blocked by** | <kbd>B</kbd> | The work items that have to land first: find one by its words, or type its number. What waits on it shows under it, as **Blocks**.                                  |
| **Repos**      |              | The repositories it is linked to, in their roles. Link another as a target or as touched, or unlink one (never its origin; Triage role).                            |
| **Links**      |              | Its sessions in Chat, its project, and what it is tied to outside g1t, such as a GitHub issue.                                                                      |

Under them, whether you get [notifications](/guides/notifications/) about
it. On a phone the panel folds under the title, with a line that sums it
up; tap it to open it, and every picker works by touch.

### Start agent and the ⋯ menu

**Start agent** opens **Start an agent**: on the workspace's Anthropic
account, where it has an Anthropic AI provider, or on your own machine as
the Claude Code command to run (see
[start a session on your Anthropic account](/guides/sessions/#start-a-session-on-your-anthropic-account)).
Its arrow picks where, copies the work item's reference (`acme#12`) for
your own agent, opens a draft pull request of your own with a fork to
push to, or opens one from a branch you already pushed.

The **⋯** menu claims it (<kbd>I</kbd>), renews, releases or hands off
your claim with a note on where it stands, makes it a sub-item of another
work item, closes it (<kbd>Shift</kbd> <kbd>C</kbd>, as completed or not
planned, saying what becomes of open sub-items) or reopens it, and copies
its link. A claim made here has no harness behind it, so it lapses after
30 minutes unless you renew it.

### Keys

None of these work while you type in a field.

| Key                                                                                        | Does                                                      |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| <kbd>E</kbd>                                                                               | Edit the title and description                            |
| <kbd>A</kbd> <kbd>P</kbd> <kbd>Y</kbd> <kbd>H</kbd> <kbd>M</kbd> <kbd>L</kbd> <kbd>B</kbd> | Open the property's picker                                |
| <kbd>Shift</kbd> <kbd>Y</kbd>                                                              | Move it to the next cycle, while cycles are on            |
| <kbd>D</kbd>                                                                               | Start an agent                                            |
| <kbd>I</kbd>                                                                               | Claim it                                                  |
| <kbd>Shift</kbd> <kbd>C</kbd>                                                              | Close it                                                  |
| <kbd>J</kbd> / <kbd>K</kbd>                                                                | The next and previous work item in the list you came from |
| <kbd>Ctrl</kbd> <kbd>Enter</kbd>                                                           | Send a comment, or save an edit                           |

<kbd>J</kbd> and <kbd>K</kbd> follow the list you opened it from: All
items, the plan, the board, Triage, or a project's home. Opened from
anywhere else, they follow the plan's order (Now, then Next) while it is
in either. The keyboard's shortcuts (<kbd>?</kbd>) list them too.

### Events

Every change to a work item is an event, sent to
[webhooks](/guides/webhooks/): `work_item.opened`, `work_item.updated`,
`work_item.assigned`, `work_item.labeled`, `work_item.milestoned`,
`work_item.landed`, `work_item.closed`, `work_item.reopened` and the
rest. A repository's webhooks get those of the work items linked to it,
a workspace's get all of them.
