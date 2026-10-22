---
title: Spend
description: What your agent sessions cost in a workspace, by day, work item, repository, harness and model, and how much of it went into work that landed. How each session's cost is estimated and shared out, who sees each person's spend, and the CLI, MCP and API.
---

**Spend**, at `/<workspace>/-/spend`, is what one person's agent sessions
cost in a workspace over a span of days, and how much of it went into work
that landed. It opens on your own: every member sees theirs, in full, from
**Spend** in the sidebar or **See your spend** on [Home](/guides/home/).

Spend is information about work, not a score for people. Per-person
figures are for budgets and for choosing the plan that fits, and the page
says so. Nothing on g1t lists or sorts people by what they spent.

## What the page shows

Choose the last **7**, **30** or **90** days; the span is in the address
(`?days=7`, or `?since=2026-09-01&until=2026-09-30` for any days up to 400).
Days are UTC days, and a session counts on the day it started.

|                                                                   |                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **What it cost**                                                  | Every session you started in the workspace's repositories in the span, subagents included, at list price.                |
| **Into work that landed**                                         | The part of it that went into work that [landed](#what-landed-means), and its share of the whole.                        |
| **Sessions**                                                      | How many sessions you started, and how many of them have [no known cost](#sessions-with-no-known-cost).                  |
| **By day**                                                        | A bar for each day, split into what landed and what didn't. The daily values are in a table under the chart.             |
| **By work item**, **By repository**, **By harness**, **By model** | Each with what it cost and what of it landed, the costliest first. Cost that went into no work item is **No work item**. |

Someone else's spend leaves out the names of repositories you can't read,
and their work items, though what was spent there still counts: it shows
as **Elsewhere**.

## Beside Anthropic's report

With Anthropic's cost report [connected](/guides/usage-and-billing/#provider-cost-reports),
Spend also says what Anthropic's own Claude Code usage report puts on the
person for the same days, and how much of it g1t's sessions saw:

> Anthropic reported $412.80 for your Claude Code in these days. g1t's
> sessions saw $338.50 of it (82%).

g1t's figure is the Claude Code rows of the page: **By harness**, **Claude
Code**. Anthropic's report is matched to the person only through an email
address they [verified on g1t](/guides/authentication/#email-addresses),
so a person with none verified there, or who uses Claude Code under
another address, has no line until they add and verify it under
**Account settings**, **Emails**. The line shows on your own spend,
and on someone else's to an owner or billing manager the workspace lets
see it. Owners who haven't connected Anthropic see a link to connect it.

**Why the figures differ.**

- g1t prices tokens at list price; Anthropic's figure is its own estimate,
  and can differ. When g1t's comes out higher, Spend says so plainly rather
  than as a share over 100%.
- Sessions that ran without the [g1t plugin](/guides/claude-code-plugin/),
  or outside the workspace's repositories, are in Anthropic's report but
  not in g1t's.
- Use on a Claude subscription plan rather than the organization's API
  isn't in Anthropic's report, though g1t's sessions count it at list
  price.
- Anthropic's figure arrives about an hour late and is revised for a week,
  so the last days may still change; Spend says so while they can.

OpenAI's report can't be split by person yet, so Codex has no line like it.

## How a session's cost is worked out

1. **The harness reports tokens.** As a session runs, its harness reports
   how many tokens it used, model by model, and g1t prices them at the
   provider's published list price ([what a session cost](/guides/sessions/#what-a-session-cost)).
   It is an estimate, not a bill: it is what the tokens cost at list
   price, whatever your plan or discounts.
2. **Subagents count with their session.** A subagent reports its own
   usage, so nothing is counted twice, and its cost goes where its root
   session's goes when it is tied to nothing of its own.
3. **The cost goes to the work.** A session's cost goes to the pull
   request it is tied to. A session with no pull request goes to the
   work item it claimed, landed with a push whose commit names it in a
   `G1t-Session` trailer, or said it works on. A session tied to several
   splits its cost evenly among them; one tied to none counts under its
   repository with no work item.

### What landed means

A share of a session landed when its pull request merged, or, for a
session with no pull request, when a push landed its work item with a
commit that names the session (or its root session) in a `G1t-Session`
trailer. What is still open, or was closed without merging, counts as not
landed.

### Sessions with no known cost

A session that reported no usage costs no known amount, so it isn't
counted in the dollars. Spend says how many there were ("3 with no known
cost") so a missing figure is never mistaken for zero. Usually it is an
older version of the [g1t plugin](/guides/claude-code-plugin/#what-a-session-cost),
or a harness that reports no usage.

Claude Code sessions report their usage through the
[Claude Code plugin](/guides/claude-code-plugin/), and Codex sessions
through the [Codex plugin](/guides/bring-your-own-agent/#what-the-codex-plugin-records),
priced at Anthropic's and OpenAI's list prices. A Codex session on a
ChatGPT plan isn't billed per token: its cost is what those tokens would
cost at list price, a measure of the work rather than a bill.

GitHub Copilot CLI and Gemini CLI sessions report theirs through g1t's
[plugins for them](/guides/bring-your-own-agent/#recording-other-harnesses),
priced at the model provider's list price; Copilot bills premium requests,
so its sessions' cost is likewise a measure of the work. Cursor's hooks
carry no token counts, so a Cursor session recorded by its plugin has no
known cost.

## Who sees each person's spend

Everyone always sees their own. Who else sees each person's is a
workspace setting, under **Settings**, **Work**, **Spend**
(`/-/settings/work`). Only owners change it; everyone else sees what it
is, so they know who sees theirs.

| Setting                                       | Who sees each person's spend                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Owners and billing managers** (the default) | The workspace's owners and [billing managers](/guides/workspaces/#roles-that-add-to-a-member). |
| **Every member**                              | Every member of the workspace.                                                                 |
| **Nobody**                                    | Nobody but each person.                                                                        |

Whoever the setting lets see it has a **People** section on Spend: each
person with sessions in the span, listed alphabetically by name, with
their sessions and what they cost. Choose a name to open that person's
spend (`?person=<username>`). Asking for someone's spend you may not see
says why, and leads back to your own.

### The 3-person rule

The workspace's total, **Everyone: $X across N people**, shows to members
who may see each person's spend, and to every other member once it covers
3 people or more. A total over fewer people would let anyone work out one
person's figure the setting keeps from them. A one-person workspace is all
your own, so this never hides anything there.

## The CLI, MCP and the API

`g1t spend` prints your spend over the last 30 days, grouped by work item:

```sh
g1t spend
g1t spend --since 7d --by harness
g1t spend --person USERNAME
```

| Flag                                     |                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--person <USERNAME>`                    | Whose spend; yours when left out. Someone else's only as the workspace's setting allows.                                                   |
| `--since <DAY\|Nd>`                      | The first day, `YYYY-MM-DD`, or a number of days such as `7d` (the last 7 days, today among them). 30 days before `--until` when left out. |
| `--until <DAY>`                          | The last day, `YYYY-MM-DD`; today when left out.                                                                                           |
| `--by <repo\|item\|harness\|model\|day>` | What to group the table by; `item` when left out.                                                                                          |
| `--workspace <SLUG>`                     | The workspace; the current repository's when left out.                                                                                     |

| To                                  | MCP                                                                                 | API                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Read a person's spend               | `workspace` tool, `spend` (`person`, `since`, `until`)                              | [`GET /workspaces/{workspace}/spend`](/reference/api/work-items/get-spend/)         |
| Change who sees each person's spend | `workspace` tool, `configure_spend` (`visibility`: `owners`, `members` or `nobody`) | [`PATCH /workspaces/{workspace}/spend`](/reference/api/work-items/configure-spend/) |

The API answers with the same figures the page shows: `cost_usd`,
`landed_usd`, `sessions` and `unknown_sessions`, the `rows` by day,
repository, work item, harness, model and landed, the `visibility`, and
`people` and `workspace_usd` as the setting and the 3-person rule allow.
