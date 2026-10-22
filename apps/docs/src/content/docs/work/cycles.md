---
title: Cycles
description: Run a workspace in one- or two-week time boxes. While cycles are on, the plan's Now is the current cycle, unfinished work carries into the next by itself, and each cycle ends with a report.
---

A cycle is a time box: one or two weeks in which the workspace takes on a
set of work and does it. While cycles are on, the plan's **Now is the
current cycle**. There are not two lists of what the workspace is on:
putting a work item in the cycle puts it in Now, and taking it out of Now
takes it out of the cycle. **Next** is the pool the next cycle is drawn
from, and its order is still the only priority.

When a cycle's last day is over, g1t closes it and opens the next. Work
still open in it stays in Now and carries into the next cycle, and the
cycle's report says what it finished, what it carried and what it took on
after it started. Nobody moves anything by hand.

Cycles are the workspace's, one sequence for everyone in it, numbered from

1. With cycles off, Work runs on Now, Next and Later alone, as it always
   has.

## Turn cycles on

1. Open **Workspace** in the left rail, then **Work** under
   **Code, planning, and automation**, at `g1t.sh/<workspace>/-/settings/work`.
2. Turn on **Run the workspace in cycles**.
3. Choose the **length**, the day cycles **start on** and the
   **cooldown**, or keep the defaults.
4. Choose **Save**.

The first cycle opens at once. It starts on the latest start day on or
before today, so a workspace that turns cycles on on a Wednesday is in a
cycle that started on Monday, and everything already in Now is in it from
its first day.

| Setting       | Is                                                                        | Default   |
| ------------- | ------------------------------------------------------------------------- | --------- |
| **Length**    | One week or two weeks.                                                    | Two weeks |
| **Starts on** | The day of the week each cycle begins, in UTC.                            | Monday    |
| **Cooldown**  | Days between one cycle's last day and the next one's first, from 0 to 14. | None      |

A new length, start day or cooldown applies from the next cycle: the
current one keeps its days. Turning cycles off closes the current cycle at
once without carrying anything, and the plan works as it did before.
Turning them on again opens a new cycle, numbered after the last.

Every member can read the settings. Changing them needs the right to
manage labels and milestones (the Write role or higher), as the plan's own
settings do.

## The cycle page

**Cycle 14**, in Work's sidebar under **Plan** while cycles are on, opens
the current cycle at `g1t.sh/<workspace>/-/work/cycle`. The row says how
many days are left and how much is done: `Cycle 14 · 4 days left · 9/14`.

| Part                | Shows                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The header          | Its days and how many are left, counting today: "Last day" on its last.                                                                      |
| **Scope**           | Every work item it took on, and how many were added after its first day.                                                                     |
| **Done**            | How many are closed as completed, and what share of its scope that is.                                                                       |
| **Carried in**      | How many the cycle before carried into it.                                                                                                   |
| **Burn-up**         | Day by day, what it had taken on and what of it was done. Point at a day, or move along with the arrow keys; **Show as a table** lists them. |
| **Where it stands** | How many of its work items are at each stage, from **Up next** to **Done**, read from the record as the [board](/work/board/)'s are.         |
| **Work items**      | Its work items under their stage, each marked **Carried in** or **Added mid-cycle** where it was.                                            |
| **By person**       | Each assignee's work in it, done of total, and the work nobody is assigned.                                                                  |
| **By agent**        | Each coding agent's, by the agent behind the work item's newest pull request.                                                                |
| The coming cycle    | Its days and what is planned into it so far, with **Plan Cycle 15**.                                                                         |
| **Past cycles**     | The cycles before, each with how much it did and carried.                                                                                    |

A work item closed as not planned leaves the cycle's scope. The page
follows what changes as it happens, without reloading.

During a cooldown, the next cycle is open but has not started: the page
says when it starts, and work moved into Now joins it.

## Put work in a cycle

Moving a work item into Now puts it in the current cycle, from the
[plan](/work/plan/), from Triage, or from its page. On a work item's page,
the **Cycle** property (<kbd>Y</kbd>) has:

| Choice       | Does                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------- |
| **Cycle 14** | Puts it in the current cycle, which is Now.                                                     |
| **Cycle 15** | Plans it into the coming cycle: it waits in Next, in its rank, and moves into Now when 14 ends. |
| **No cycle** | Takes it out of either, back to Next.                                                           |

<kbd>Shift</kbd> <kbd>Y</kbd> on a work item's page moves it straight to
the next cycle. From Now it goes to the top of Next, planned into the
coming cycle.

Deciding what a cycle holds needs what deciding what is in Now needs: the
right to manage labels and milestones. Coding agents never commit a cycle.
A work item an agent files waits in Triage for a person to place, and an
agent's move into the current or the coming cycle is refused.

### Plan the next cycle

**Plan Cycle 15**, on the cycle page, opens `-/work/cycle/plan`: Next, in
rank order, beside what is planned into the coming cycle.

1. Choose **Pull in** on a work item in Next, or move to it with
   <kbd>J</kbd> and <kbd>K</kbd> and press <kbd>Y</kbd>.
2. To take one back out, choose **Take out**, or press <kbd>Y</kbd> on it
   in the coming cycle's list. <kbd>H</kbd> and <kbd>L</kbd> switch
   between the two lists.

What is planned keeps its rank in Next. When the current cycle ends, it
moves into Now after what was there, with whatever the ending cycle carried.

## When a cycle ends

The work service's cron runs every five minutes. Once a cycle's last day
is over (in UTC), it:

1. Records each work item still open in the cycle as carried.
2. Moves them into the next cycle. They stay in Now, in their places.
3. Moves what was planned into the next cycle from Next into Now.
4. Closes the cycle and opens the next one, from the first start day after
   its cooldown.

Each cycle closes once, in one step: running the step again, or two runs at
once, carry nothing twice. When the cron was stopped for a while, the
next run closes each cycle it missed in turn, so no cycle is skipped and
work carried through several shows in each one's report.

A work item reopened while in Now joins the current cycle.

## A cycle's report

Each past cycle has a page at `-/work/cycles/<number>`, from **Past
cycles** or the arrows beside a cycle's name. Its report has:

- **Finished**: the work items closed as completed in it.
- **Carried into Cycle 15**: those still open when it ended, as they are
  now.
- **Added mid-cycle**: those it took on after its first day.

with its burn-up and each person's and agent's share.

## The CLI, MCP and the API

| To                                              | CLI                                                                     | MCP                                  | API                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| Read the current cycle, or one by number        | `g1t cycle`, `g1t cycle view 13`                                        | `work_item` tool, `get_cycle`        | [`get_cycle`](/reference/api/cycles/get-cycle/)               |
| List the settings, the current and past cycles  | `g1t cycle list`, `g1t cycle settings`                                  | `work_item` tool, `list_cycles`      | [`list_cycles`](/reference/api/cycles/list-cycles/)           |
| Change the settings                             | `g1t cycle settings --on --length 14 --start-day monday`                | `workspace` tool, `configure_cycles` | [`configure_cycles`](/reference/api/cycles/configure-cycles/) |
| Move a work item into the current or next cycle | `g1t cycle add 318`, `g1t cycle add 320 --next`, `g1t cycle remove 318` | `work_item` tool, `cycle`            | [`cycle_work_item`](/reference/api/cycles/cycle-work-item/)   |

Every work item says the `cycle` it is in, and
[`list_work_items`](/reference/api/work-items/list-work-items/) takes
`cycle` to list one cycle's work items. The plan
([`get_plan`](/reference/api/work-items/get-plan/)) carries the current
`cycle` while cycles are on. A move into or out of a cycle is a
`work_item.planned` event, as any move in the plan is.
