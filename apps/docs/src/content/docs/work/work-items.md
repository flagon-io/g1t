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
  waits on;
- its **repositories**, each with a role: where it was filed, where it
  should land, and where work for it happened (see
  [below](#repositories-and-their-roles));
- **labels** and a **milestone**, both the workspace's: see
  [labels](/work/labels/) and [milestones](/work/milestones/);
- **comments**, **reactions** and up to 10 **assignees**, `g1t` among
  them if you like (see [assign g1t](/guides/sessions/#assign-g1t-or-ask-it-in-the-thread));
- what it is **blocked by**: other work items that must land first (see
  [dependencies](/work/claims-and-dependencies/#dependencies));
- a **state**: open or closed. A closed work item records why:
  `completed` or `not_planned`. One closed by what landed records each
  **resolution**: the repository, and the pull request or commit that
  landed it (see [closing work items](/work/closing/)).

## File a work item

On [Work](/work/), choose **New work item**:

1. Give it a **title** (up to 200 characters) and a **description**.
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

| You write | It names |
| --- | --- |
| `#12`, in a repository | That repository's pull request #12, else the work item that was its issue #12, else the workspace's work item #12, else pull request #12 in another of the workspace's repositories, if it was opened after work items came |
| `#12`, outside a repository | The workspace's work item #12, else its pull request #12 opened after work items came |
| `owner/name#12` | `#12` as it reads in repository `owner/name` |
| `workspace#12` | Work item or pull request #12 of another workspace |

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

| To | You need |
| --- | --- |
| Comment and react | To be signed in and see it |
| Edit its title and description, change its labels, assignees and what it is blocked by, close and reopen it | To be its owner, or the Triage role. Its owner is its author, or, for one g1t filed for someone, that person. |
| Put it in a milestone | The Triage role |
| Link and unlink repositories | The Triage role |
| Make a new label as you label it | The Write role |

A work item carries at most 20 labels and 10 assignees.

## Repositories and their roles

A work item links any number of the workspace's repositories, each in one
role:

| Role | Means |
| --- | --- |
| `origin` | The repository it was filed in. A work item filed from a repository has one; one filed on **Work** itself has none. It never changes. |
| `target` | A repository the work is meant to land in. It closes once every target has landed. |
| `touched` | A repository where a pull request or commit for it landed or is in progress. |

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

Besides its description, conversation and repositories, a work item's
page has:

- a banner for each repository it **landed in**, by which pull request or
  commit;
- its [decision records](/guides/why-blame/#decision-records), and the
  latest combination that failed in the merge queue, if any;
- in its sidebar, the **Work** panel: who has claimed it, the sessions on
  it, what it is blocked by and what it blocks (see
  [claims and dependencies](/work/claims-and-dependencies/));
- **Start a session**, where the workspace has an Anthropic AI provider
  (see [start a session on your Anthropic account](/guides/sessions/#start-a-session-on-your-anthropic-account));
- its assignees, with **Assign yourself** and **Assign to g1t**;
- **Bring your own agent**, while nobody has a pull request open for it:
  its reference to give your agent (`acme#12`), or a draft pull request to
  open yourself;
- its labels, milestone and whether you get notifications about it.

Every change to a work item is an event, sent to
[webhooks](/guides/webhooks/): `work_item.opened`, `work_item.updated`,
`work_item.assigned`, `work_item.labeled`, `work_item.milestoned`,
`work_item.landed`, `work_item.closed`, `work_item.reopened` and the
rest. A repository's webhooks get those of the work items linked to it,
a workspace's get all of them.
