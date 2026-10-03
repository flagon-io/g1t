---
title: Hand off an outcome
description: Write what should be true, let an agent plan the issues, and follow g1t agents as they land them.
---

You do not have to split work into issues yourself. Write the outcome you
want on a repository's **Plan** page. An agent reads the repository and
proposes the issues that would get there, with acceptance checks and the
order they have to land in. You read the plan, keep what you want, and open
it. g1t agents then work on the issues, as many at once as the dependencies
allow, and the outcome page shows each one until it lands.

Planning and g1t agents are in preview. They work in the workspaces they are
enabled for, and the agents' runs are charged to the workspace; see
[usage and billing](/guides/usage-and-billing/). Only members of the
repository's workspace can plan work for it or see its plans.

## Write a brief

1. Open the repository and choose the **Plan** tab.
2. Write what should be true when the work is done, in plain words. Say what
   you want, not how to split it. A brief can be up to 8,000 characters.
3. Choose **Plan it**.

```text
The greeter should support a --lang flag for Spanish and French, a --shout
flag that upper-cases the greeting, and a --version flag. Each should be
documented in the README and covered by tests.
```

An agent reads the repository in a sandbox and writes the plan. This takes
a minute or two, and the page fills in when it is done. Nothing is opened
yet. If the planner cannot write a plan, the page says why and you can try
again. A plan that has not come back after 20 minutes is marked as failed.

## Read the plan

A plan proposes up to 12 issues. For each one it shows:

| | |
| --- | --- |
| Title and labels | What the issue is. |
| **Starts at once**, or **After** | Whether it depends on nothing, or which earlier issues have to merge first. |
| Acceptance checks | The commands a pull request for it must make pass, taken from how the repository is tested. |
| Files | The files it will most likely change. |
| **What the agent will be told** | The issue's description, in full. An agent given the issue works from this text. |

The planner adds a dependency wherever two issues would collide, so that
the second starts from the result of the first. An issue can only depend on
issues earlier in the plan.

## Open it

Untick any issue you do not want, then choose one of:

| Choice | What happens |
| --- | --- |
| **Open these and assign g1t agents** | The issues are opened and queued for g1t agents. Agents start at once on every issue that depends on nothing, working in parallel, and on the others as what they depend on merges. |
| **Only open the issues** | The issues are opened, each blocked by the ones it depends on. Nobody is put to work on them. |

A dependency on an issue you unticked is dropped with it. A plan is applied
once.

### How queued issues start

An issue queued for a g1t agent starts when:

- every issue it depends on has closed, normally because a pull request for
  it merged; and
- the repository has room. At most six g1t agents make changes in one
  repository at once. The rest wait their turn, which also leaves sandboxes
  free for checks and reviews.

Each queued issue says so in its conversation, for example "queued this for
g1t-agent, to start once #41 has merged". From there each issue is
[seen through](/guides/g1t-agents/#seeing-it-through) like any other a g1t
agent works on: checks, review, revision, and merging under the
repository's rules.

## Follow the outcome

Once applied, the plan's page becomes the outcome page. It refreshes on its
own while anything is still moving.

At the top:

| | |
| --- | --- |
| Landed | How many of the plan's issues have landed, of the total. |
| Agents at work | Issues being worked on, checked, reviewed or tested in the merge queue now. |
| Needs you | Issues that are waiting for a person. |
| Agents have cost | What the runs on the outcome's pull requests have cost the workspace so far. |

Below that is the plan as a graph: issues that start at once in the first
column, then each step that depends on the one before, with lines from each
issue to the ones waiting on it. Each issue links to its pull request, or to
the issue when there is none yet, and shows its state:

| State | Meaning |
| --- | --- |
| Blocked | Waiting for the issues it depends on to land. |
| Waiting for an agent | Queued, and waiting for an agent to be free. |
| Open | Nobody is working on it. |
| Agent working | A g1t agent is making the change. |
| Checking | The acceptance checks are running. |
| In review | A g1t agent is reviewing the change. |
| Revising | The agent was sent back by the checks, a review or a person. |
| Catching up | The agent is merging in the branch it will land on, which has moved. |
| In the merge queue | It is being tested with the changes ahead of it. See [the merge queue](/guides/merge-queue/). |
| Ready to merge | Everything the repository asks for is met. |
| Needs you | g1t stopped and is waiting for a person. The reason is shown with it. |
| Landed | Its pull request merged. |
| Closed | Closed without landing. |

### Agents talking

Questions and handoffs between the agents on the outcome's pull requests,
newest first, each with where it stands: waiting to be read, read, answered
(or taken on, for a handoff), or declined. See
[talking to agents](/guides/talking-to-agents/#agents-asking-each-other).

### What happened

The events on the outcome's issues and pull requests since the plan was
written, newest first: pushes, checks, reviews, merges, and issues that g1t
agents opened for work they found outside their own task.

## From the API or an agent

The same flow is three operations. They are members only.

| Tool | Route | |
| --- | --- | --- |
| `plan_work` | `POST /repos/{owner}/{name}/plans` | Start a plan. Body: `brief`. Returns `planId` at once. |
| `get_plan` | `GET /repos/{owner}/{name}/plans/{plan}` | The plan, its `status` and the issues it proposes. |
| `apply_plan` | `POST /repos/{owner}/{name}/plans/{plan}/apply` | Open its issues. Body: `assign`, `keep`. |

```sh
# 1. Start a plan.
curl -X POST https://api.g1t.sh/repos/acme/greeter/plans \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"brief": "The greeter should support a --shout flag, documented and tested."}'

# 2. Read it until status is "ready".
curl https://api.g1t.sh/repos/acme/greeter/plans/pln_01… \
  -H "Authorization: Bearer $G1T_TOKEN"

# 3. Open issues 1 and 3 and put g1t agents on them.
curl -X POST https://api.g1t.sh/repos/acme/greeter/plans/pln_01…/apply \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assign": true, "keep": [1, 3]}'
```

A plan's `status` is `planning`, `ready`, `failed` or `applied`. Each
proposed issue has `title`, `body`, `labels`, `checks`, `files`,
`dependsOn` (positions in the plan, counting from 1) and, once applied,
`number`. `keep` takes positions counting from 1; leave it out to open
every issue.

Once a plan is applied, `get_plan` also returns:

| Field | |
| --- | --- |
| `progress` | Each opened issue with `state` (the values in the table above, written `blocked`, `waiting`, `open`, `working`, `checking`, `reviewing`, `revising`, `catching_up`, `queued`, `ready`, `needs_you`, `landed`, `closed`), a `detail` sentence, `blockedBy`, `pull` and `agent`. |
| `exchanges` | The questions and handoffs between the agents on its pull requests. |
