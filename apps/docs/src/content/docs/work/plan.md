---
title: The plan
description: What the workspace is doing now, what it takes next, and what can wait. Every open work item stands on one horizon (Triage, Now, Next, Later or Set aside), and within a horizon its place is its priority. People, coding agents and Home all read what to do next from it.
---

**Plan**, the first tab of Work at `g1t.sh/<workspace>/-/work`, is the
workspace's plan: what it is doing now, what it takes next and what can
wait. Every open work item stands on one **horizon**. Within Now, Next and
Later its place in the list is its priority, so there are no priority
levels to argue over: what is higher is taken first.

Each part of the plan is shown within a bound, so it never turns into a
list with no end: Now holds a handful, Next shows its top 10, Later is
grouped, and work nobody needs any more is set aside where only search
finds it.

## Horizons

| Horizon       | Holds                                                                                                                          | Shown                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **Triage**    | New work items nobody has placed yet: ones people file, ones coding agents file, and imports. Every new work item starts here. | On its own tab, newest first, with a count.     |
| **Now**       | What the workspace has chosen to do and is on.                                                                                 | In full, with a cap (6 unless you change it).   |
| **Next**      | What comes after, in order. The top is what anyone, or any agent, takes next.                                                  | The top 10, then **Show all**.                  |
| **Later**     | Work you want, not ranked against Next yet.                                                                                    | Grouped by repository, each group with a count. |
| **Set aside** | Work you've let go of. Nothing is deleted, and one move brings it back.                                                        | Only as a count, and in search.                 |

A closed work item keeps the horizon it had, so reopening it puts it
back where it was.

## Place work

On the Plan:

1. Drag a work item to where it belongs, within Now or Next, between
   them, or onto Later.
2. Or open its menu (**⋯**, which also works with a keyboard and on a
   phone) and choose **Move up**, **Move down**, **Move to top**, or
   **Move to** Now, Next, Later, Set aside or Triage.

On **Triage**, each row has **Now**, **Next**, **Later**, an appetite,
and **Close as not planned** for work that won't be done. A work item's
page has a **Plan** box in its sidebar with the same choices.

A work item moved to another horizon goes last there, unless you drop it
in a place. The move is noted in its conversation ("moved this from Next
to Now").

### Suggestions in Triage

When the workspace has an [AI provider](/guides/ai/) chosen for Ask, g1t
suggests where each new work item in Triage goes: a horizon (Now, Next or
Later), an appetite, an open work item it seems to repeat, and why, in a
sentence. g1t asks the workspace's own provider once for each new work
item, within a few minutes of it being filed. Nothing moves until someone
accepts:

- **Accept** moves it as suggested: last on that horizon, with that
  appetite.
- **Close as duplicate**, when it seems to repeat another, closes it as
  not planned with a comment naming the other.

A workspace with no provider gets no suggestions; Triage works the same
without them. When work items have waited in Triage more than a week,
Home tells those who can plan.

### Who can plan

| To                                                                    | You need                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Triage work items, and move them within Next, Later and Set aside     | The Triage role or higher on the work item                           |
| Move work into or out of Now, reorder Now, or mark a work item urgent | The right to manage labels and milestones (the Write role or higher) |
| Change Now's cap                                                      | The right to manage labels and milestones                            |

Anyone who can see the work items can read the plan. Someone who can't
plan sees it without the controls.

## Now's cap

Now is a commitment, so it is kept short. When it holds more than its
cap, the plan says so in a warning color. It never stops you adding
more: the cap is a nudge to finish before starting. The cap is 6 unless
the workspace sets another, from 1 to 50, with
[`configure_plan`](/reference/api/work-items/configure-plan/) or the
`workspace` tool's `configure_plan` action.

## Appetite and budget

A work item's **appetite** says how much the work is worth, not a guess
at how long it will take:

| Appetite      | Means                                                                |
| ------------- | -------------------------------------------------------------------- |
| **S**, small  | One session.                                                         |
| **M**, medium | A few sessions, about a week.                                        |
| **L**, large  | A phase. Break it into smaller work items before you move it to Now. |

A **budget**, in dollars, is what a coding agent working on it may
spend. Both are optional, and both show on the work item and in the plan.

## Urgent

**Urgent** is for fires. An urgent work item goes to the top of Now,
ahead of everything ranked there, and stays there until it closes.
Reopening a work item clears it.

## How work in Now stands

Nobody reports progress by hand. Each work item in Now shows where it is
on its **hill**, from what its record says:

| Stage               | When                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| **Figuring it out** | Nothing is decided yet: sessions on it, or nothing at all.                  |
| **Decided**         | A decision is recorded on it, so the approach is settled.                   |
| **Building**        | It has a draft pull request, or a session on it made commits.               |
| **Landing**         | A pull request for it is in review or merged, or it landed in some targets. |

Under its title, a sentence or two says **where it stands** and what comes
next. g1t drafts it from the work item's sessions, decisions and pull
requests with the workspace's AI provider, again whenever something new
happens on it. A work item with nothing happening on it for 5 days says
it has gone **quiet**.

**This week**, beside the plan, lists what landed from Now in the last 7
days and how many in Now have gone quiet.

## Letting go

Later is for work you want, not for everything anyone ever filed. A work
item in Later that nothing has happened to for 90 days is set aside, and
its conversation says so ("set this aside: nothing happened on it in
Later for 90 days"). It is not deleted: search finds it, and one move puts
it back. The plan says how many were set aside in the last 30 days.

## What to take next

The work item to take next is the first one in **Now** that nobody is
on, or else the top of **Next**. Work items that are blocked by open work
(see [dependencies](/work/claims-and-dependencies/#dependencies)), that
someone has claimed, or that are assigned to someone else are skipped.

- **Home**'s **Start here** shows it when nothing more pressing needs you.
  See [Home](/guides/home/).
- **On the command line**, `g1t work next` prints it, and
  `g1t work plan` prints Now and Next. See [the g1t CLI](/guides/cli/).
- **Coding agents** ask the `work_item` tool's `next` action, then
  [claim](/work/claims-and-dependencies/#claims) what it gives. See
  [working with agents](/work/agents/).

## The plan and the Board

The [Board](/work/board/) shows the work that is moving: what is in
progress, in review, landing and done, plus **Up next**, the top of Next.
Everything else stays in the plan, so the Board never grows without end.

## Milestones and the plan

[Milestones](/work/milestones/) carry dates: a launch, a release. The plan
carries order. Filter the plan's lists by milestone to see one goal's
work in the order it will be done.

## For integrations

| To                     | Call                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Read the plan          | [`get_plan`](/reference/api/work-items/get-plan/)                                                                                      |
| Move a work item       | [`plan_work_item`](/reference/api/work-items/plan-work-item/): `horizon`, `before`, `after`, `top`, `appetite`, `budget_usd`, `urgent` |
| Pick what to take next | [`next_work_item`](/reference/api/work-items/next-work-item/)                                                                          |
| List one horizon       | [`list_work_items`](/reference/api/work-items/list-work-items/) with `horizon`, in the plan's order                                    |
| Set Now's cap          | [`configure_plan`](/reference/api/work-items/configure-plan/)                                                                          |

`get_plan` also answers `progress` (each Now work item's `hill`,
`active_at`, `quiet` and drafted `standing`), `landed` (what closed from
Now in the last 7 days), `triage_waiting` and `set_aside_recent`. A work
item in Triage carries its `suggestion`.

Each move publishes `work_item.planned`, with the work item's `horizon`,
`fromHorizon` when it changed horizon, its `appetite` and whether it is
`urgent`. Setting aside after 90 days publishes it too, with no actor.
See [webhooks](/guides/webhooks/).
