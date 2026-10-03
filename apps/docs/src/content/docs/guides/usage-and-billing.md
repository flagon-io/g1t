---
title: Usage and billing
description: What g1t agents cost, how a workspace pays for them, and what is free.
---

Hosting repositories, issues, pull requests, review and your own agent cost
nothing on g1t. What costs money is g1t's own agents: each run uses a
model, and a workspace pays for the runs on its repositories from credit it
buys in advance. There is no subscription and no seat price.

## What is charged

| | Charged |
| --- | --- |
| Making a change for an issue | Yes |
| Revising a change after checks, a review or a person | Yes |
| A review by a g1t agent | Yes |
| Catching up with `main` | Yes, when it needed an agent |
| Planning an [outcome](/guides/outcomes/) | Yes |
| Acceptance checks | No |
| The [merge queue](/guides/merge-queue/) | No |
| Repositories, git, issues, pull requests, the API and MCP | No |

Each run is charged when it finishes: what the model provider charged for
it, plus 20%. A small change costs a few cents.

Work a workspace routes to [its own model providers](/guides/models/) is
paid for at those providers instead, and each such run here is a flat $0.10
for the sandbox and orchestration.

The charge goes to the workspace that owns the repository, whoever
assigned the issue. That is why only members of a workspace can put g1t
agents to work on its repositories.

## Add credit

Only an owner of the workspace can add credit.

1. Open the workspace's **Settings → Billing**, `g1t.sh/<workspace>/-/billing`.
2. Under **Add credit by card**, choose an amount: $10, $25, $50 or $100.
3. Pay on the card page you are sent to.

You come back to the Billing page, and the credit is there once the payment
has gone through. The amount credited is what the card processor says was
paid.

While payments on g1t are in test mode, no real card is charged. Use the
test card `4242 4242 4242 4242` with any future date and any code. The
Billing page says when payments are in test mode.

## When credit runs out

With no credit, g1t agents do not start. Assigning an issue, planning, or
asking for a review is refused with `402` and a message saying the
workspace has no agent credit:

```json
{
  "error": {
    "code": "payment_required",
    "message": "The acme workspace has no agent credit. An owner can add some under Billing on the workspace's page."
  }
}
```

A step g1t would take by itself, such as a revision or a review, stops
instead, and the pull request says **Needs you** with the reason. Runs
already under way finish, so a balance can dip slightly below zero.

## The Usage page

A workspace's **Usage** page, `g1t.sh/<workspace>/-/usage`, shows what its
agents have cost. Every member can see it. The sidebar shows this month's
spend.

Pick a period: **This month**, **Last 7 days**, **Last 30 days** or **Last
90 days**. The page then shows:

| | |
| --- | --- |
| Spent | What the period cost, and how much of it was the model provider's. |
| Agent runs | How many runs there were. |
| Average run | What a run cost on average. |
| Credit left | The balance, and about how many days it lasts at the period's rate. |
| Spend per day | A chart of each day, split by kind of work. |
| By kind of work | Making changes, reviews, catching up and planning. A revision counts as making a change. |
| By repository | Each repository's share. |
| Pull requests that cost most | The ten that cost most, each linked. Planning appears as the repository, linked to its plans. |
| By model | Each model's share. |

## The statement

The **Billing** page lists the workspace's balance and its statement:
every payment and every run, newest first, up to the latest 100. Each run names its kind of work
and links to the pull request it was for. Every member can see it.

Each pull request's session also ends with what its run cost before the
margin.

## The preview

g1t is in preview.

- **Open to everyone:** accounts, workspaces, repositories, git, issues,
  pull requests, review, the API, and your own agent through MCP.
- **g1t's agents, for any workspace with its own model provider:** connect
  an Anthropic key or endpoint under [Integrations](/guides/models/) and the
  workspace's agents, acceptance checks and merge queue work at once. Your
  provider bills you for the models; g1t charges $0.10 a run.
- **g1t's hosted models, for selected workspaces:** while payments are in
  test mode, g1t's own models are open only to workspaces it has opened
  them to. When payments go live, every workspace can use them, paid from
  its credit.

Each workspace decides where its model spend goes. A workspace that can use
neither sees a message saying so, with the way to connect its own provider.
