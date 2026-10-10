---
title: Spend
description: What the workspace spent and where it went, by agent, person, channel, model and product; the budgets from the workspace down to one task, and what happens at each; a receipt for every task; and how it is priced.
---

**Spend** is the front of the workspace's money:
`g1t.sh/<workspace>/-/spend`, first under **Money** in the Workspace
sidebar. It says what was spent over a period, where it went, the budgets
that hold it, and what each task cost. Every figure on it comes from the
workspace's usage and agent records; nothing is estimated.

**Usage** has every meter in detail, and **Billing and plans** has the
plan, the spend limit, payments and the statement. Spend links to both.

## Whose spend

| View | Who sees it | What it counts |
| --- | --- | --- |
| **Workspace** | Owners and [billing managers](/guides/workspaces/#roles-that-add-to-a-member) | Everything the workspace used, every product, and every agent's work. |
| **You** | Everyone | What agents spent working for you: your chats with agents and the sessions you started. |

Owners and billing managers switch between them with **Workspace** and
**You** at the top of the page. Everyone else sees **You**.

## The period

Choose **This month**, **Last month**, **30 days** or **7 days**. Days are
UTC. Budgets are always this month's, whatever the period.

## The figures at the top

| View | Figures |
| --- | --- |
| **Workspace** | **Spent**: usage at price over the period, every product, the same figure as [Usage](/guides/usage-and-billing/#the-usage-page). **Agents**: every agent's replies and sessions. **Charged**: what the workspace was charged this month, against its spend limit when it has one. |
| **You** | **Agents for you** over the period. **Your budget** this month, and what is spent against it. **Your chats with agents**: the replies agents wrote you. |

**By day** shows the period one day at a time. Hover or focus a day for
its amount.

## Where it went

Slice the period's spend with the tabs:

| Slice | Shows |
| --- | --- |
| **Agents** | Each agent's share. A session's helpers and subagents count on the agent that started it. Open one for its own Spend tab. |
| **People** | Who asked. Routines and agent-to-agent work have no asker. Workspace view only. |
| **Channels** | Where it was asked: each channel, direct messages together, and channels you aren't in together, without their names. |
| **Models** | Each model's share. |
| **Kind of work** | Chat replies, sessions, routines, helping colleagues and subagents. |
| **Products** | Every product at price, from Usage: Agent, Sandboxes, AI Gateway, Deployments, Git & storage, Packages, Security & quality and Search. Workspace view only. |
| **Extensions** | Coming: what each installed extension runs, once extensions can be installed. |

A slice is part of the page's address (`?by=channel`), so you can share it.

## Budgets

Budgets nest, from the widest to the narrowest. Before every agent reply
and session step, g1t checks each level, and the first one that is used
up stops the work. Each row on Spend shows the budget, what is spent
against it this month, and what happens at 100%.

| Level | Set by | At 100% |
| --- | --- | --- |
| **The workspace** | Owners and billing managers, under [Billing → Your spend limit](/guides/usage-and-billing/#your-spend-limit). | New work stops until the month turns or an owner raises it: agents, workflows, builds and deploys. With **Pause usage at 100%** off, owners are alerted and work goes on. |
| **All agents together** | Owners, here or under **Agents → Budget**. | No agent takes new work until the 1st, or until an owner raises it. |
| **Each person** | Owners, here. A default for everyone, and a budget of their own for anyone. | Agents take no new work for that person until the 1st, and say so where they were asked. |
| **Each agent** | Owners, on the agent's **Profile**. A new agent starts with the default set here. | That agent takes no new work until the 1st, or the next day for a daily cap. |
| **Each task** | Owners, here: the cap a session starts with. The plan's caps on one run and one issue are under [Billing → Caps](/guides/usage-and-billing/#caps). | The session stops at **Needs approval**, and an owner decides whether it goes on. |

Work already running finishes, so spend can go slightly past a budget.

### A person's budget

A person's budget counts what agents spend on work that person asks for:
the replies agents write them and the sessions they start, with
everything those sessions bring in. Each person can see their own on
**You**, and in the top bar.

To set budgets, as an owner:

1. Open **Spend** and find **Budgets**.
2. Choose **Change** on **All agents together**, **Each person** or
   **Each task**, fill in the amounts in dollars, and choose **Save
   budgets**. An empty budget means none.
3. To give one person their own budget, choose **Set** on their row, or
   **Give someone their own budget**, and enter it. `0` means no budget at
   all for them; empty puts them back on the default.

## Receipts

**Costliest tasks** lists the period's most expensive sessions. Open one
for its receipt, at `g1t.sh/<workspace>/-/spend/receipts/<session>`:

- Each session of its tree: the agent's own, and every helper and subagent
  it brought in, with their tokens, the model at the provider's price, and
  what each was charged.
- **Models, at the provider's price**: every session's model answers
  together.
- **g1t's agent rate**: the rest, at the rate in the price book.
- **Total, as budgets count it**.

On your own model key, your provider bills the model and only the agent
rate is charged; the receipt says so. A session from a conversation you
aren't in shows what it cost, not what it was about.

## How it's priced

The page's last section reads the [price book](/guides/usage-and-billing/#how-prices-are-set):

| | Price |
| --- | --- |
| **Models** | What the model provider charges, with no markup. |
| **Agent rate** | Per million tokens an agent's run uses, for context, memory, routing and orchestration. |
| **Everything g1t runs** | Sandboxes, builds, hosting, storage and search, at cost plus 20%. |
| **Your own model keys** | Your provider bills the model; only the agent rate is charged. Local models the same. |
| **Your own runners** | $0. |
| **People** | No seats. |

## In the top bar

Your spend this month sits in the page's header, beside **Ask g1t**: what
agents did for you against your budget. Choose it for where it went, by
kind of work and by agent, and a link to Spend. Owners and billing
managers can switch it to **Workspace**: what the workspace was charged
this month against its spend limit, and its agents' spend. The choice is
remembered on this browser. On a phone, open **Spend** from the Workspace
sidebar instead.

## Next

- [Agent budgets and spend](/guides/agent-budgets/): who pays for a session tree.
- [Usage and billing](/guides/usage-and-billing/): the spend limit, caps, AI credit and rates.
- [Sessions](/guides/agent-sessions/): caps and approving more spend.
