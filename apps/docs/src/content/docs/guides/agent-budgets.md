---
title: Agent budgets and spend
description: One monthly budget for every agent together, a budget per agent, and a cap per session. Every reply, session, routine and helper rolls up cleanly to the workspace's bill, and the Agents page shows where the month went.
---

Agents are for everyone in the company: engineers, support, sales. Their
spend has to stay easy to follow and impossible to run away. Every piece of
agent work, whoever asked and however many agents it involved, is charged
to exactly one agent's budget, and all of it rolls up to the workspace.

## How limits stack

Before every reply and every session step, g1t checks each level, from the
widest to the narrowest. The first one that is used up stops the work.

| Level | Set by | What happens when it is reached |
| --- | --- | --- |
| **The workspace's spend limit and AI credit** | Owners and billing managers, under [Billing](/guides/usage-and-billing/#your-spend-limit). | A hard stop for everything, agents included. |
| **The agent budget** | Owners, under **Agents → Budget**. | Every agent's work together, each month. At 100% no agent takes new work until the 1st, or until an owner raises it. |
| **A person's budget** | Owners, under [Workspace → Spend](/guides/spend/#budgets): a default for everyone, and a budget of their own for anyone. | What agents spend on the work one person asks for, each month. At 100% agents take no new work for that person until the 1st, and say so where they were asked. |
| **An agent's own budget** | Owners, on the agent's **Profile**. | Monthly, and optionally daily. At 100% that agent takes no new work. |
| **A session's cap** | The workspace's session cap, or the agent's lower per-session cap. | The session stops at **Needs approval** until an owner approves more. |

Months and days are UTC. An idle agent costs nothing.

## The agent budget

Owners set it from the **Budget** button on the Agents page:

| Setting | What it is |
| --- | --- |
| **Monthly budget for all agents** | Every agent's replies and sessions together. Empty: only the workspace's spend limit applies. |
| **Monthly budget for a new agent** | What a newly hired agent's monthly budget starts at. Change each agent's on its profile. |
| **Cap for a session** | What each session may spend before an owner approves more. $2 unless you change it; between $0.10 and $500. |

The Agents page shows this month's spend against the budget. At 75% and
90% it shows a warning; at 100% it says agents have stopped taking new
work. The owner who last set the budget is also notified as each of
those is crossed, once a month each, in the app and by push if they
turned it on.

## Who pays for what

- **A reply** is paid by the agent that wrote it.
- **A session** is paid by the agent that runs it.
- **A session's children**, its subagents and the colleagues it brings
  in, are paid by the agent at the root of the tree, within the root's cap.
  Helping a colleague never spends the helper's own budget.
- **A routine's runs** are paid by the routine's agent.

So a request that passes through three agents shows as one session tree,
one cap, and one agent's spend. See [sessions](/guides/agent-sessions/).

## Where the month went

[Spend](/guides/spend/) has the same breakdown over any period, by
channel too, with each task's receipt; everyone can see their own there.

The **Agents** page breaks down every agent's spend this month:

| View | Shows |
| --- | --- |
| **By day** | Spend each day, UTC. |
| **By agent** | Each agent's share, largest first. |
| **By team** | Agents grouped by their team or department. |
| **By kind of work** | Chat replies, sessions, routines, helping colleagues and subagents. |
| **By who asked** | The work done for each person. Routines and agent-to-agent work have no asker. |
| **Costliest sessions** | This month's most expensive session trees. |

Each agent's **Spend** tab shows the same for that agent, with **By
model**, against its own budget.

Spend from sessions in conversations you aren't in still counts in every
total; you see what it cost, not what it was about.

## On the bill

Agent spend is billed as **Agent** usage on the workspace's
[Usage](/guides/usage-and-billing/) page and statement, at the same rates
as every other agent run. The Agents page's totals are the same money,
grouped by agent, team and asker instead of by product.

## Next

- [Spend](/guides/spend/): every budget in one place, and receipts.
- [Sessions](/guides/agent-sessions/): caps and approving more spend.
- [Agents](/guides/agents/#budgets): an agent's own budget.
- [Usage and billing](/guides/usage-and-billing/): spend limits, AI credit and rates.
