---
title: g1t agents
description: Have g1t's own agents work on an issue.
---

g1t can do the work itself. Assign an open issue to the g1t agent and it
opens a pull request for the issue, works in a sandbox and a fork of its
own, and reports back as it goes. There is nothing to configure: you do not
say how many agents or which model. Scale comes from assigning many issues,
each to its own agent, all working at once.

g1t agents are paid for by the workspace they work for, so they need a
paid workspace or the free trial; see [who can run agents](#who-can-run-agents)
and [usage and billing](/guides/usage-and-billing/). Everyone can also
[bring their own agent](/guides/bring-your-own-agent/), which costs
nothing on g1t.

To hand over a whole outcome rather than one issue at a time, have an agent
plan it first: see [hand off an outcome](/guides/outcomes/).

## Put an agent on it in one step

When the work is not written down yet, open the issue and hand it to the
agent at once:

1. On Mission control, choose **Put an agent on it**.
2. Pick the project, give a title, and say what you want done in plain
   words, with what done means if you know it.
3. Choose **Put an agent on it**.

You land on the new issue with the agent already at work on its pull
request. The same choice is on a project's **New issue** page, as **Assign
g1t-agent now**, and in the ⌘K palette as **Put an agent on …** followed by
a project's name.

Putting an agent to work needs the Write role on the project. Without it,
nothing is opened. With it, the issue is always opened, even when the
agent cannot start:

| What happened | What you see |
| --- | --- |
| The agent started | The issue, with its draft pull request under **Assignees**. |
| Every agent slot of the workspace is busy | The issue, queued for g1t-agent. It starts by itself when a slot frees up. |
| The workspace's plan or limits refused it | The issue is opened, and the composer says why and links to the fix: start the plan or the trial (`not_paid`, `trial_used`), raise the monthly limit (`limit`) or the cap per issue (`issue_cap`), or connect a model (`no_model`). A workspace g1t `paused` says to contact support. |

From the API or an agent of your own, it is one call:

```sh
curl -X POST https://api.g1t.sh/repos/<workspace>/<repo>/issues/delegate \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Retry webhooks with exponential backoff", "body": "Deliveries that fail are dropped today. Retry them up to six times."}'
```

The answer holds the `issue`, the `pull` request the agent opened (or
`null`), and `agent`: its `status` (`started`, `queued` or `not_started`),
and when it did not start, a `code`, a `message` and a `fix_url`. On the MCP
server it is the `agent` tool's `delegate` action. See
[put an agent on it](/reference/api/issues/delegate/).

The `checks` field this call and `create_issue` used to take is
deprecated. It is still accepted: its commands are added to the issue's
body under `## Definition of done`, one line each (`` - `npm test` passes. ``),
and the answer carries a `deprecation` string saying so. What has to pass
before the pull request merges is the default branch's
[required status checks](/guides/pull-requests/#required-status-checks).

## Assigning agents

One issue:

1. Open an issue on a repository.
2. In **Assign to g1t agent**, optionally add guidance for this run, on top
   of the issue's description.
3. Choose **Assign**.

Many issues:

1. Open the repository's **Issues** tab.
2. Tick the issues to hand over, up to ten at a time.
3. Choose **Assign to g1t agent**.

From the API, an agent of your own, or a script:

```sh
curl -X POST https://api.g1t.sh/repos/<workspace>/<repo>/issues/12/assign \
  -H "Authorization: Bearer $G1T_TOKEN"
```

The same thing is the `agent` tool's `assign` action on the MCP server, so an agent
planning work can hand issues to g1t agents itself.

In a comment: write `@g1t-agent take this` on the issue. See
[mentioning g1t-agent](#mentioning-g1t-agent).

By label: a project can hand every issue given a label to the agent. See
[the label rule](#the-label-rule).

Each agent appears as a draft pull request on its issue within a few
seconds. The pages update on their own while they work.

An issue can still have more than one pull request: assign it again, or
have your own agent open one alongside. That is for when you want a second
attempt, not the normal way of working.

## What an agent does

1. Clones its pull request's fork.
2. Is told what else is in progress: every other open pull request in the
   repository, what it is for and which files it changes. Its session
   starts with a note of what it was told.
3. Reads the code and makes the change the issue asks for, keeping clear of
   the other work where it can.
4. Commits its work.
5. Pushes to the fork and marks the pull request ready for review, with a
   summary as its description.

Everything it reads, runs and decides is recorded in the pull request's
**Session** as it happens; see [sessions and why-blame](/guides/why-blame/).
The **Files changed** tab shows the resulting diff.

If an agent fails, or finishes without changing anything, its pull request
is closed and its session says why.

## Repository instructions

Every g1t agent run reads the repository's own instructions for agents
and is told them, labelled as the repository's, before it starts: making a
change, revising it, reviewing, catching up, answering, and planning.

| File | Read by |
| --- | --- |
| `AGENTS.md` and `CLAUDE.md` at the root | Every run. |
| `AGENTS.md` and `CLAUDE.md` in a subdirectory | Runs whose task touches files under it: the nearest one above each file. Where it disagrees with the root's, it wins for the files under it. |
| `.g1t/review.md` | Reviews: what to check, house rules, paths that need extra care. |

Write them for an agent that knows nothing about the project: how to build
and test, how things are named, what never to touch. For example:

```md
# AGENTS.md
- Run `npm test` and `npm run typecheck` before you finish.
- API handlers return a Result; they never throw.
- Never edit files under `vendor/`.
```

Which directories a task touches comes from the pull request's changed
files, and for new work from the paths the issue names, so naming the
files in an issue helps the right instructions reach the agent.

**Where they are read from.** The default branch, as it is when the run
starts. A pull request from one of the repository's own branches is read at
its head instead, since only people who can push to the repository can
change it. A pull request from a fork, which includes every change a g1t
agent makes, is never followed: the agent keeps the default branch's
instructions, and if the fork changes them, it is shown the changed text as
part of the change, marked as not instructions. That way nobody can steer
an agent, or the review of their own change, by editing these files in a
pull request. Treat what a fork's head says as untrusted, as you would its
code.

**Limits.** Each file is cut at 8,000 characters and all of them together
at 24,000; what is left out is named in the prompt. Files are read once per
commit and reused.

The project's **Agents** page lists the files its runs read, what they say
and when each last changed, with a link to each in the code. Each run's
session starts with a note of which files it read. To change them, change
the files and merge to the default branch.

## Seeing it through

Making the change is the first step. g1t takes the rest itself, and you
get the pull request back ready to merge:

1. **Checks.** Every push the agent makes runs the repository's
   [workflows](/guides/actions/) on the pull request, as for anyone's pull
   request. g1t waits for them to finish. Only the workflow runs report, so
   the agent has no say in the result.
2. **Review.** A different agent reads the change and posts comments on
   lines, a summary and a verdict.
3. **Revision.** If a check fails or the review asks for changes, the
   author is sent back with exactly what was found. For a failed check,
   that is the end of the log of each failed job, up to three jobs and
   about 3,000 characters each; it can read more with `get_workflow_run`
   and `get_job_logs`. Steps 1 and 2 run again on the result. This happens
   at most twice, or as often as the repository's **Revisions before asking
   you** allows.
4. **Ready to merge.** The required checks passed and it is approved.
   Merging is yours, unless the repository says otherwise (below).

Agents are told to run the same tests and linters the workflows run before
they finish, so most failures are caught in the sandbox. What "done" means
for the issue, if its description says so, is context for the agent and
its reviewer; what decides the merge is the default branch's
[required status checks](/guides/pull-requests/#required-status-checks).
A repository with no workflows has nothing to prove a change works; **Add
CI** gives it one ([add CI](/guides/actions/#add-ci)).

If `main` has moved in the meantime, that does not hold the pull request
up. Merging it brings it up to date first: g1t merges `main` in, an agent
resolves any conflict, and it lands. A repository that wants every pull
request caught up and checked again before it may merge turns on **Require
pull requests to be up to date before merging** in its settings; catching
up is then a step of its own, before "ready".

g1t also works out ahead of time whether each pull request still merges
cleanly, every time it or `main` moves
([how](/guides/pull-requests/#conflicts)). When one of an agent's pull
requests is found to conflict, g1t does not wait for a merge to trip over
it: the agent is sent to merge `main` in and resolve the conflicts, told
which files conflict, and the checks run again on the result.

The pull request's page shows which step it is at. While a required check
has not reported on its latest commit, it says so: "Waiting for the
required check CI to report on its latest commit." If g1t cannot finish,
because a required check still fails after the agent revised as often as
the repository allows ("The required check CI still fails after the agent
revised twice."), a review could not be written, or a conflict could not
be resolved while bringing it up to date, it stops and the page says
**Needs you**, with the reason. A check that is not required and still
fails after the last revision does not hold it. Pushing to the pull
request yourself starts it moving again.

### What a repository can ask for

Under a project's **Settings → Branches and merging**, someone with the
Maintain [role](/guides/access-and-roles/) or higher sets the rules its pull
requests follow. **Branch protection** holds the rules for every pull
request, a person's or an agent's; they are described in
[required status checks](/guides/pull-requests/#required-status-checks):

| Setting | Default | What it does |
| --- | --- | --- |
| Require a pull request to change the default branch | Off | Refuses pushes to the default branch. |
| Required status checks | None | The checks that must pass on a pull request's head before it merges. |
| Required approvals | None | How many reviewers must approve before a merge. A reviewer who asked for changes blocks it. |
| A g1t agent's approval counts | On | Off means approvals have to come from people. |
| Require branches to be up to date before merging | Off | On means catching up is a step of its own and the checks run again. |
| Merge through a queue | Off | Merging tests a pull request together with those ahead of it; the default branch only moves to a combination that passed. See [merge queue](/guides/merge-queue/). |
| Allow bypassing required checks | On | Lets someone who may merge merge without the required checks passing. Off means nobody can. |

**g1t agents** holds what g1t does with its own agents' pull requests:

| Setting | Default | What it does |
| --- | --- | --- |
| Review by a second agent | On | Off leaves review to people. |
| Revisions before asking you | 2 | How often an agent is sent back before g1t stops. |
| Merge automatically when ready | Off | Lands a g1t agent's pull request once every rule is met. |
| Ask a person before merging low-confidence changes | On | A g1t agent's change [rated low](#how-sure-the-agent-is) waits for a person's approval instead of merging by itself or joining the queue. |

A g1t agent's pull request follows the same rules as anyone's. If the
repository wants approvals from people, it waits for them, and shows
**Needs you** until they arrive.

### Talking to an agent

While a g1t agent works, you can steer it with **Message the agent** on its
pull request; it reads the message at its next step, without starting
over. Once it is done, a review with **Request changes** sends it back to
make them, and the checks and review run again. g1t agents working at the
same time can also ask each other questions and hand each other work. See
[talk to agents](/guides/talking-to-agents/).

### Merging automatically

A repository can land a g1t agent's pull request by itself once it is
ready. Someone with the Maintain role or higher turns this on under the repository's
**Settings → Branches and merging**; it is off to begin with. The merge is recorded as made by
`g1t`, the issue closes naming the pull request, and nothing short of
ready is ever merged this way: every required check has passed on its
head. One that is behind `main` is brought up to
date as part of the merge. Pull requests from people and from other
agents always wait for a person to merge them.

Every step is recorded: revisions and catch-ups in the pull request's
**Session**, reviews in its conversation.

This applies to pull requests made by g1t agents. One you or your own
agent opened is yours to drive; the same workflows run on it, and you can ask
for a review or a catch-up from its page.

### How sure the agent is

Once a g1t agent has finished a change, g1t records how sure it is that the
change is right: **high**, **medium** or **low**, with a few words saying
why, such as "Low — tests not added, 3 revisions". It shows on the pull
request, under the agent, and on Mission control. It is worked out again as
the change moves through checks, review and revision, and kept with each
run, so a run's page says how the change stood when that run left it.

Confidence comes from what g1t can observe, not from how the agent sounds.
Each signal below that tells against the change adds points, or makes it
low on its own. No points is high, one or two is medium, and three or more
is low.

| Signal | Effect |
| --- | --- |
| Required checks fail | Low |
| It failed in the [merge queue](/guides/merge-queue/) | Low |
| The reviewer agent asks for changes | Low |
| A run was stopped at its cost or time cap | Low |
| Sent back to revise | 1 point per revision, at most 3 |
| Required checks have not finished, or have not run on its head | 1 point |
| Checks passed only on a retry | 1 point |
| The default branch has no required checks | 1 point |
| No review yet, or the repository has no reviewer agent | 1 point |
| The reviewer approved but left three or more comments on lines | 1 point |
| Code changed and no test was added or changed | 1 point |
| More than 400 lines changed; more than 1,000 | 1 point; 2 points |
| More than 30 files changed | 1 point |
| Files changed outside the area its [plan](/guides/outcomes/) expected; four or more | 1 point; 2 points |
| Touches CI workflows, repository automation, secrets, infrastructure or `CODEOWNERS` | 2 points |
| Its latest run used 80% or more of its cost or time cap | 1 point each |
| Steps refused by [guardrails](/guides/guardrails/); three or more | 1 point; 2 points |
| A question or handoff it sent another agent is unanswered | 2 points |
| The agent said it was unsure about something | 1 point |

At the end of every run that makes or revises a change, the agent is also
asked how sure it is, and what it could not verify. g1t takes the lower of
the two: what it observes can lower the agent's own word, never raise it.
When the agent's word is lower, the reasons start with "agent says low",
and the pull request lists what it was unsure about.

For high confidence, the reasons say what it rests on: required checks pass,
approved on the first review, tests added, a small change.

The pull request's `confidence` in the
[API](/reference/api/pull-requests/get-pull-request/) has the `level`,
`reasons`, `self_reported`, `uncertain_about`, the `run_id` it was worked out
after, and `assessed_at`. [Webhooks](/guides/webhooks/) for pull requests
carry it too.

### Low-confidence changes wait for a person

With **Ask a person before merging low-confidence changes** on, which it is
unless someone turns it off, a g1t agent's change rated low is not merged
by itself and does not join the merge queue, even with **Merge
automatically when ready** on. Once everything else the repository asks
for is met, it stops at **Needs you**, saying why, and Mission control
lists it under **Needs you** with a **Low confidence** chip, the reasons in
**What the agent already knows**, and the reasons again in **Why this
needs you**.

To let it land, approve it: a person's approval since the agent last
revised lifts the hold, and it merges as the repository's rules say. To
send it back, request changes. Merging it yourself works as usual. The
setting is under **Settings → Branches and merging**, in **g1t agents**,
and is `hold_low_confidence` in
[`update_repo_settings`](/reference/api/repositories/update-repo-settings/).

## Choosing between pull requests

Each pull request on the issue's page shows whether its checks passed. Open
the ones that did, read their descriptions and changes, and merge the one
you want. Merging lands it on `main` and closes the issue, which records
that pull request as the one that resolved it. The other pull requests for
the issue close as superseded. See
[merging](/concepts/overview/#merging) for what happens when `main` has moved.

## Other things g1t agents do

- **Review.** On a pull request that is ready, **Request review from g1t agent**
  has an agent read the change and post comments on lines, a summary and a
  verdict.
- **Catch up.** When `main` has moved under a pull request, **Catch up with
  main** merges it in. When the two changed different files g1t does that
  itself in seconds, with no agent; otherwise an agent merges it in a
  sandbox and resolves any conflict
  ([catching up](/guides/pull-requests/#catching-up)).
- **Finish a security update.** g1t raises a vulnerable dependency to its
  fixed version itself, with no agent. When raising the version is not
  enough (the bump fails, or the pull request's required checks fail
  because code must change), g1t opens an issue and puts g1t-agent on it.
  That session shows as **started by g1t** on the project's **Agents** page.
  See [security updates](/guides/security/#security-updates).

Each runs in a sandbox of its own.

## Mentioning g1t-agent

Write `@g1t-agent` in a comment on an issue or a pull request, with what
you want, and it does it. The comment box offers to complete the name as
you type `@`.

| Where | You write | What happens |
| --- | --- | --- |
| An issue | A request: `@g1t-agent take this`, `@g1t-agent fix the empty case` | The issue is assigned to the agent, which opens a pull request, as if you had chosen **Assign**. |
| An issue | A question: `@g1t-agent why does search time out?` | The agent reads the code on the default branch and answers in the thread. It changes nothing. |
| A pull request g1t-agent made | A request: `@g1t-agent also handle the empty list` | The agent is sent back to make the change, with your comment as what to address, and the checks and review run again. If it is still working, it gets your comment as a message at its next step. |
| Any pull request | `@g1t-agent review` | A review by a g1t agent, as with **Request review from g1t agent**. |
| Any pull request | A question | The agent reads the change at its head and answers in the thread. On someone else's pull request, which it cannot push to, a request is answered too: it says what it would change. |

A request is a comment whose words after the mention start with what to
do (`take`, `fix`, `add`, `please rename`, `can you update`); a question
starts with a question word or ends with a question mark. `review` near the
start asks for a review.

g1t-agent always replies in the thread, saying what it started or why it
did not. Every run a mention starts shows on the project's **Agents** page
as started by whoever mentioned it, and a mention that started nothing
shows there as a failed run with the reason.

**What does not count.** Mentions in code (`` `@g1t-agent` `` or a code
block), in quoted lines (`> @g1t-agent …`), in email addresses
(`ops@g1t-agent.dev`) and in longer names (`@g1t-agents`) are ignored.
Matching ignores case. Agents mentioning `@g1t-agent` start nothing, so
agents cannot set each other to work this way.

**Who can.** People with the Write [role](/guides/access-and-roles/) or higher on the
repository, members or not. Anyone else who mentions it gets a short reply
saying that putting g1t-agent to work needs the Write role on the
repository, and nothing starts. When
the workspace's plan does not let the agent start (a free workspace with no
trial left, a paused workspace, an issue at its spending cap), g1t-agent
replies with why and where to fix it. When every agent slot is busy, it
replies that the run is waiting for a free slot, and starts it when one
finishes.

Each comment starts one run at most; to ask again, write a new comment.

## The label rule

Under a project's **Settings → Agents**, someone with the Maintain role or
higher sets a label, such as `agent`. From then on, when someone with the
Write role or higher gives an open issue that label, either
when opening it or later, g1t-agent takes it: the issue is queued for an
agent, the conversation says so, and the agent starts as soon as the
project has room and nothing the issue depends on is still open, exactly as
for a [plan's](/guides/outcomes/) issues. An issue that already had the
label is not affected; removing and adding it again counts. **Turn off**
removes the rule.

## Which model runs

You do not pick one. You assign the work to `g1t-agent`, the way you would
assign an issue to a colleague, and g1t routes it. On g1t's hosted models,
each piece of work goes to the least costly of two tiers that can do it:

| Tier | Model today |
| --- | --- |
| Small | Claude Haiku 4.5 |
| Large | Claude Sonnet 5.5 |

The work decides the tier:

| Work | Tier |
| --- | --- |
| Making a change for an issue, revising it, and answering a mention | Large |
| Reviewing a pull request that changes at most 10 files and 200 lines, touches no sensitive path, and is not for an issue labelled `security` | Small |
| Reviewing any other pull request, or one whose changed files g1t does not know yet | Large |
| Catching up with `main` and resolving conflicts | Small |
| Planning an outcome | Small |
| Any of these again, after the last attempt at the same work failed or stopped at a guardrail cap | Large |

Sensitive paths are the ones that run, configure or guard things: CI
workflows, `.g1t/` and `.github/`, `CODEOWNERS`, secrets such as `.env`
and `.pem` files, and infrastructure such as Dockerfiles, Terraform and
`wrangler.*` files. They are the same paths that lower a change's
[confidence](#how-sure-the-agent-is).

The agent's own small background steps run on the small tier.

Every session opens with a note naming the model that ran, and an agent's
review says which model wrote it, so what you got is always on the record.
When a better model for a tier appears, g1t changes the route and nothing
you have set up needs to change.

A workspace that routes its work to [its own provider](/guides/models/)
is not routed by tier: its work runs on the model its route names.

A pull request made by a g1t agent carries the label `g1t-agent`, and its
commits are authored by `g1t agent`.

## How model traffic is routed

g1t agents send model requests to g1t's model proxy at
`https://models.g1t.sh`, with a token for their run in place of a key; see
[your keys never reach a sandbox](/guides/models/#your-keys-never-reach-a-sandbox).
Requests for g1t's hosted models go on through
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/),
which holds g1t's key. Each of those requests is tagged with the kind of
work, the tier, the repository and the pull request, so spend can be read
per tier and per pull request. Requests for a workspace's own provider go to that provider.

If you run your own copy of g1t, these settings control it:

| Setting | Where | What it does |
| --- | --- | --- |
| `AGENT_ROUTING` | Runner | JSON. `tiers`: the model behind `small` and `large`, each `{ "modelName", "model" }`. `tasks`: the tier of `implement`, `review`, `update` and `plan`, or `change` to decide by the change. `smallChange`: the most `files` and `lines` a `change` review runs on the small tier with. `largeLabels`: issue labels that keep a review on the large tier. Anything left out takes the defaults above. |
| `MODELS_URL` | Runner | Where sandboxes send model requests: the model proxy. |
| `AI_GATEWAY_ID` | Model proxy | The gateway hosted requests go through. Empty sends them to the provider directly. |
| `AI_GATEWAY_TOKEN` | Model proxy | Secret. Authenticates to the gateway. |
| `ANTHROPIC_API_KEY` | Model proxy | Secret. The provider's key, if the gateway does not hold it. |

## What it costs

A workspace pays for the g1t agents that work on its repositories, after
they run: each run is charged its sandbox by the second, at cost plus 20%,
and, on g1t's hosted models, what AI Gateway priced its model requests at,
plus 20%. A workspace's [own provider](/guides/models/) bills it for the
model directly. See
[Usage and billing](/guides/usage-and-billing/) for how prices are set and
the limits on usage not yet paid for.
The workspace's **Usage** page shows what its agents have cost, by day,
kind of work, repository, model and pull request. See
[usage and billing](/guides/usage-and-billing/).

## What a sandbox has

Git, common shell tools, and toolchains for Node.js, Python, Go and Rust, so
an agent can build and test most projects. If your project needs something
else, the agent will say in its summary what it could not run.

A workspace (or a project) can send its agents' work to
[its own runners](/guides/self-hosted-runners/#agents-on-your-runners)
instead, so agents build and test with what those machines have. The agent
works the same way there, with the same short-lived credentials, and its
model calls still go through g1t; the machine time is free. g1t's network
guardrails cannot be enforced on your machines, and the run says so.

## Who can run agents

Putting an agent to work (assigning it, mentioning it, asking it for a
review, planning, sending it back to revise) needs the Write
[role](/guides/access-and-roles/) or higher on the repository. That
includes an [outside collaborator](/guides/access-and-roles/#outside-collaborators)
with Write: their runs are charged to the repository's workspace, as a
member's are, and count against its plan, caps and agent slots. They see
what their agents do, but not which model ran or what a run cost; those
are for members of the workspace. A run for an outside collaborator is
told the project's memory, never the workspace's.

Agents cost g1t real money, so they run for paid workspaces. A free
workspace has the whole forge, and two ways to try agents:

- **The trial.** $5 of usage, once per workspace, after a card check.
- **The open-source pool.** Workflows and the merge queue on public
  repositories, after the same card check. It does not pay for agents.

This holds whether the agent uses g1t's hosted models or
[the workspace's own model provider](/guides/models/): the sandbox an agent
works in is g1t's either way. Before anyone assigns, asks for a review or
plans, a free workspace's pages say "Agents need a paid workspace or the
free trial", with a link to its **Billing** page.

Every agent run, of every kind (making a change, revising, reviewing,
catching up, planning, answering a mention), asks billing before it
starts. Billing reserves what the run is expected to cost: its model's
recent average (about $0.10 to make a change or plan, $0.07 to review)
plus its sandbox for its whole time cap. When the run ends, what it really
cost is settled against that. If billing refuses, nothing starts, and you
see why where you started it:

| Where you started it | Where the refusal shows |
| --- | --- |
| **Assign to g1t agent**, **Request review**, **Plan it**, catching up | Under the button |
| A mention or the label rule | A comment from g1t-agent on the issue or pull request |
| A step g1t takes by itself (a review, a revision, a catch-up) | The pull request's status, which then waits for you |

Each refusal says what to do: start the plan or the trial, raise the spend
limit, or wait for next month's open-source pool, with the page to do it
on.

### Caps on a plan

A workspace's plan sets caps on its agents. A new paid workspace in its
first month, and a workspace on the trial, has tighter ones. The amounts
are on [usage and billing](/guides/usage-and-billing/#caps).

| Cap | What happens at it |
| --- | --- |
| Agents at once | A run over the cap waits for a free slot instead of being refused. An assigned issue goes back in the queue; a review, catch-up, plan or answer someone asked for waits its turn; a step g1t takes by itself is tried again at its next sweep, within five minutes. Each says "Waiting for a free slot". |
| Time per run | The lower of the project's [guardrails](/guides/guardrails/) time cap for that kind of run and the plan's. |
| Cost per run | The lower of the guardrails' cost cap and the plan's. The agent is stopped when it reaches it, as with any cost cap. |
| Cost per issue | What every agent run on an issue and its pull requests has cost in all. Past it, g1t-agent does not start on that issue again and says so on it; an owner can raise the cap on the **Billing** page. |

When the workspace's compute is paused (a spend spike waiting for an owner,
or a hold by g1t), nothing new starts, and the refusal gives the reason.

### When billing cannot be reached

g1t's own billing service could be briefly unreachable. Then:

- A paid workspace's runs go ahead, and the miss is logged. A billing blip
  never stops a paying customer's work.
- A free workspace's runs do not start: they would be paid for by nobody.
  Try again in a minute.

g1t decides which a workspace is from its plan, or from the last plan it
saw for it in the past day.

### Other limits

- A run has two hours. After that its credentials expire and it can no
  longer push or report.
- Agents do not run on an [archived](/guides/managing-repositories/#archive-a-repository)
  or deleted repository: nothing new starts, whether from an assignment,
  a mention or the label rule, and a run under way cannot push or merge.
  What was refused does not start by itself when the repository is
  unarchived or restored; assign the work again.

## Credentials

Every sandbox run gets credentials of its own, made when it starts and
revoked the moment it stops. They are not your access tokens, and they are
not listed with them.

Each credential carries a composite identity: the agent, acting on behalf
of the person who started the work. A run you started by assigning an issue
is `g1t-agent on behalf of you`, and that is how it appears in the
[audit log](/guides/audit-log/), on the run's page and in the pull
request's **Agent** panel.

What it may do is the intersection of two things:

- **The run's scope.** The credential is bound to the run, its repository,
  and what that kind of run needs. It expires no later than the run's
  timeout.
- **What you may do now.** It works only in the repository's workspace,
  with your [role](/guides/access-and-roles/) on the repository as it is now, and never
  more than Write: an owner's agent has Write, not Admin. If you leave the
  workspace or lose your role, every agent working on your behalf there
  loses it too. It can never change who has access.

A sandbox holds two credentials. One is for g1t's runner, which clones,
pushes the result and records the session; downstream it acts as you, so
what it pushes is yours, within the run's scope. The other is for the
agent's own tools over MCP, and acts as the agent; it cannot be used with
git at all.

| Kind of run | Git | API and MCP tools |
| --- | --- | --- |
| Implement | Reads the repository; pushes to its pull request's fork only | Records the session and marks its own pull request ready; tools to read issues, pull requests, the merge queue, workflow runs and memory, to [search all of g1t](/guides/search/) and the workspace's context hub, open issues, comment, remember, and message other agents |
| Revise, answer | Reads the repository; pushes to the pull request's fork, or to its branch only when the change is a branch of the repository | Records the session of its own pull request; the same tools as implement |
| Catch up | Reads the repository; pushes to the pull request's fork or branch only | Records the session of its own pull request |
| Review | Reads the change and the repository; pushes nothing | Reports its review through its own run |
| Plan | Reads the repository; pushes nothing | Reports its plan through its own run, for a person to apply; it can create issues in its repository only |
| Merge check | Reads the change; pushes nothing | None |
| Merge queue | Reads each queued change; pushes the queue's own branch only | None |
| Deploy | Reads the commit it builds; pushes nothing | None |

Nothing an agent's credential holds can reach another repository, or a
workspace's settings, members, access tokens, billing, integrations,
webhooks, secrets and variables, or workflows' controls. It cannot merge a
pull request or put more agents to work. It cannot change its repository's
details or default branch, rename it or its branches, make it public or
private, archive, transfer, delete, restore or purge it; see
[managing a repository](/guides/managing-repositories/). A call that would is refused, and
the refusal is recorded with the rule that refused it:

| Rule | Refused because |
| --- | --- |
| `never` | No agent's credential may ever do this. |
| `scope:operation` | The run's kind does not include this operation. |
| `scope:repository` | It names a repository other than the run's. |
| `scope:pull` | The runner tried to change a pull request other than its own. |
| `on-behalf-of:membership` | The person the agent works for is no longer a member of the workspace, and has no role on its repositories. |
| `git:read`, `git:push`, `git:ref` | The run has no grant to clone that repository, push to it, or move that branch or tag. |
| `git:not-a-run` | An agent's tools credential was used with git. |

Personal and workspace access tokens are unchanged by any of this.

## What a sandbox can reach

A sandbox holds one fork and its run's credentials, which expire when the
run's time is up and are revoked as soon as it stops. Those credentials,
and the model key the agent runs on, are removed from anything recorded in
the session.

## Guardrails

A workspace decides what its agents may do in their sandboxes, and each
project can override it: which hosts a sandbox can reach (g1t, the package
registries the project needs, and domains you list; enforced outside the
sandbox), which commands the harness refuses (force-pushing, rewriting the
default branch, reading outside the project, printing the environment,
sudo, and your own patterns), and how much one run may cost and how long it
may take. A run that is refused something shows it as a step; one that
reaches a cap is stopped and its pull request waits for you. A run on a
fork's head loads none of the fork's `CLAUDE.md`, `.claude` settings,
hooks, MCP servers or commands. See [guardrails](/guides/guardrails/) for
every rule and exactly how each is enforced.
