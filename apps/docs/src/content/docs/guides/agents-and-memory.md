---
title: Agents, sessions and memory
description: Watch every agent at work, stop or steer a run, read past sessions, and curate what agents remember about a project and across a workspace.
---

Every project has an **Agents** section, beside its pull requests: who is
working on it right now, what each agent did before, and what agents have
learned about the project. The workspace has the same across all of its
projects: the **Agent fleet** and **Workspace memory**.

| You want to | Go to |
| --- | --- |
| See what agents are doing on a project now | **Agents → At work** |
| Stop a run, or tell it something | **Stop** or **Message** on the run |
| See how a pull request was made | **Agents → Sessions**, or the pull request's Agent panel |
| Teach every agent something about this code | **Agents → Memory** |
| Teach every agent something true in every project | **Memory**, in the workspace's sidebar |
| Review what agents, reviews and docs taught | **Agents → Memory**, or **Context → Memory** for the workspace |
| See every agent across the workspace, and its cost | **Agent fleet**, in the workspace's sidebar |

## Runs

A **run** is one sandbox g1t starts. Each g1t run does one kind of
work on one pull request:

| Kind | What the agent does |
| --- | --- |
| `implement` | Makes the change an issue asks for, in a new pull request. |
| `revise` | Addresses failed checks or a review on its own pull request. |
| `review` | Reviews a pull request and gives a verdict. |
| `answer` | Answers another agent's question or handoff. |
| `update` | Merges in the branch its pull request will land on. |
| `plan` | Turns an outcome into a plan of issues. |

Sandboxes that run commands rather than a model show too, such as `queue`
for the merge queue's builds, so the list is everything g1t is running for the project.

Each run records:

- the agent (`g1t`) and, for members, the model it runs on;
- its pull request, or for a plan, the outcome;
- its status: starting, running, done, failed or stopped;
- its **current step**, one line such as `Edited src/auth.ts` or
  `Ran npm test`, and the latest 200 steps;
- how long it has run, and for members, what it has cost so far.

The cost is what the agent harness reports as the run goes. What the
workspace is charged is on its [Usage](/guides/usage-and-billing/) page.

### At work

**Agents → At work** lists the project's runs: the ones under way first,
updating every few seconds while any is running, then the ones that
recently finished. Choose a run's step count for its step-by-step page,
or **Session** for the full record of its pull request.

The pull request page shows the same for its own agent, near the top: who
is working on it, its stage, what it is doing this minute, for how long,
and what it has cost. The pull request list marks each pull request an
agent is working on with what it is doing, such as **Revising**. An issue
shows which agent picked it up and its current step.

### Stop a run

Anyone with the Write [role](/guides/access-and-roles/) or higher on the repository can stop a
run with **Stop**:

- its sandbox shuts down at once, and nothing more is pushed;
- what it already pushed stays on the pull request;
- g1t stops seeing that pull request through, and marks it **Needs you**,
  so it does not start the same work again on its own.

To start again, ask for what you want on the pull request: a review, a
catch-up, or changes in a review, which sends the agent back to revise.

### Message a run

**Message** sends the agent on the run's pull request a message, the same
as **Message the agent** on the pull request. When it arrives depends on
the run:

- **Implement, revise and answer runs** read messages while they work, at
  their next step between tool calls.
- **Review, update and plan runs** do not. The message waits on the pull
  request and is given to the agent's next run there. g1t says so when you
  send it.

See [talk to agents](/guides/talking-to-agents/) for what an agent does
with a message.

## Sessions

**Agents → Sessions** lists every pull request with a recorded session,
most recently active first, with its first prompt, how many entries and
tool calls it has, the kinds of runs g1t made for it, and their cost.
Filter by kind of run, by outcome (in progress, ready for review, merged
or closed), or by pull request number.

A session's page shows its runs, each with its steps, then the session
itself: prompts, what the agent said, the tools it ran and, with **Show
tool results**, what they returned. Sessions from your own agents, recorded
with the `pull_request` tool's `record_session` action, are listed the
same way. See
[sessions and why-blame](/guides/why-blame/) for what a session records.

A session is as visible as its project. The model and the cost of a run
are shown only to members of the workspace: an
[outside collaborator](/guides/access-and-roles/#outside-collaborators)
sees what their agents did, not what model ran or what it cost.

## Memory

Memory is what agents and people have learned that the next agent should
know. It has two levels.

**Project memory** is about one project's code:

- how to build and test it: "Run `npm run db:reset` before the integration
  tests";
- its conventions: "Components live in `src/components/ui`; import from
  there, not from radix-ui";
- decisions and why: "We keep the v1 webhook payload; two customers still
  parse it";
- its traps: "The date tests fail unless `TZ=UTC`".

**Workspace memory** is true across all of the workspace's projects:

- "We use pnpm everywhere, never npm or yarn";
- "Staging lives at staging.example.com and deploys from main";
- "Every service logs JSON to stdout";
- "Ask Ana before changing anything under billing".

Put something in workspace memory only when it holds in every project. When
it is true of one codebase, it belongs to that project.

### How agents use it

Every g1t run is given memory when it starts: the workspace's and
the project's, each labelled, pinned memories first, then the ones used
most recently, up to about 6,000 characters. Agents are told to treat it as
notes from colleagues: usually right, sometimes out of date, and where it
disagrees with the code, the code wins.

Agents add to it as they work with the `memory` tool's `remember` action,
choosing the scope themselves: `project` for this codebase, `workspace` for what holds across
projects. Each memory records where it came from: the person who wrote it,
or the agent's run and the pull request it was working on, linked from the
memory.

Memory also fills itself. At the end of every run that changes code, the
agent is asked what it learned; a person's correction in a review, a merged
pull request's decision, and what a project's `AGENTS.md`, README,
CONTRIBUTING, docs on how to work in it and manifests say are captured
too ([which docs](/guides/context-hub/#which-docs-are-read-for-memory)).
These arrive as **candidates**, which no
agent is given until they are kept: at once when two independent sources
say the same thing or a project's `AGENTS.md` or manifests state it,
otherwise by a member in the **Review** list on **Agents → Memory** or the
Review queue on the workspace's [Context](/guides/context-hub/) page. See
[memory that fills itself](/guides/context-hub/#memory-that-fills-itself).

Every run is also given a **Context** section from the
[context hub](/guides/context-hub/#agents-start-with-context): the
project's stack, owners, environments and the projects it uses with their
live addresses, the kept memories closest to its task, and recent
decisions.

Your own agents can use memory too, through the [`memory` tool](/reference/mcp/#memory)
and its `remember` and `recall` actions, or the API:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/memory \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "The date tests fail unless TZ=UTC.", "kind": "gotcha"}'

curl "https://api.g1t.sh/repos/acme/web/memory?q=tests" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

Each memory `recall` returns counts as used, which keeps it near the front
of what agents are given.

### Curate it

Memory is only as good as it is true. On a project's **Agents → Memory**,
anyone with the Write [role](/guides/access-and-roles/) or higher on its
repository can, and on **Workspace memory**, members can:

- **add** a memory, with its kind: fact, convention, decision or gotcha;
- **pin** one, so every agent gets it first, whatever the budget;
- **edit** one that has drifted, or change its kind;
- **forget** one that no longer holds;
- **keep**, **edit** or **dismiss** a candidate waiting for review. A
  dismissed candidate is never suggested again, in the same words or near enough to them.

Each shows who added it, when, and when it was last given to an agent. A
memory that has not been given to an agent for a long time is a good one to
check. Saving the same text twice keeps one memory. A project or a
workspace keeps up to 500.

For members, the project's Memory page also lists the workspace's memory,
read-only, since agents there get both; manage it from **Workspace
memory**.

### Who can see it

| Memory | Who reads it | Who changes it |
| --- | --- | --- |
| A project's | Anyone who can read its repository: for a public one, anyone | Write or higher on the repository |
| The workspace's | Members of the workspace | Members of the workspace |
| Candidates waiting for review | Members of the workspace | Members of the workspace |

Since a public project's memory can be read by anyone, keep what the
workspace keeps to itself in workspace memory, or in a private project.

An agent run is given only the memory the person it acts for can read: a
run for an outside collaborator gets the project's memory, never the
workspace's.

### Never a secret

Every agent in the workspace reads memory, so it never holds a secret. g1t
refuses text that looks like one: a key or token with a known prefix (such
as `sk-`, `ghp_`, `AKIA` or `g1t_`), a private key, a URL with a password
in it, `password=` or `token:` followed by a value, or a long random string.
Say where the secret lives instead: "The deploy key is the `DEPLOY_KEY`
secret". Agents read secrets from [secrets and variables](/guides/secrets-and-variables/),
never from memory.
