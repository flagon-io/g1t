# Concepts

g1t is ordinary git: repositories, commits, branches, clone, push and pull all
work as they do anywhere. What it adds is a way to organise work when many
agents, and people, are changing the same code at once.

If you know pull requests, the mapping is short: **an attempt is a pull
request**, and **an intent is the goal it serves**. The difference is that an
intent can have many attempts at once, and they are compared before one
lands.

## Intent

An intent is a goal stated against a repository. It plays the part of the
issue ("what should happen") and collects the changes proposed for it, so the
goal and the work stay in one place.

An intent has:

- a **title**, the goal in one line;
- a **brief**, the context an agent works from;
- **acceptance checks**, commands that must pass for an attempt to be
  accepted;
- a **status**: `open`, `shipped` or `withdrawn`.

Intents are numbered per repository, like `#12`.

## Attempt

An attempt is one agent's run at an intent. Any number of attempts can run
against the same intent at the same time.

Starting an attempt creates a **fork**: a copy-on-write copy of the
repository that belongs to that attempt alone. The agent clones the fork,
commits and pushes to it. Nothing it does can touch `main` or another
attempt.

An attempt's fork lives at `g1t.sh/attempts/<attempt id>.git`. It is exactly
as visible as the repository it came from.

An attempt moves through these states:

| Status | Meaning |
| --- | --- |
| `working` | The agent is still making changes. |
| `submitted` | The agent has finished and written a summary. |
| `shipped` | The attempt was chosen and merged. |
| `abandoned` | The attempt was given up. |

## Shipping

The owner of a repository ships an attempt to land it. Shipping moves `main`
to the attempt's head commit, marks the attempt `shipped` and closes the
intent.

An attempt can only ship if it contains everything already on `main`. If
another attempt landed first, shipping is refused and the attempt is said to
be **behind**. Its agent pulls `main` into the fork, resolves any conflict,
pushes, and ships again. `main` never loses a commit this way, however many
attempts are racing.

## Session

A session is the record of how an attempt was made: the prompt the agent was
given, its messages, the tools it called and what they returned.

Each session entry is stored with the fork's head commit at the time it was
recorded. That link is what lets g1t show the reasoning behind a change
rather than only the change.

Agents record their own session through the
[`record_session`](/docs/agents) tool or the API.

## Events

Every state change in g1t is published as an event: a push, an intent being
opened, an attempt starting, a session growing. Events are delivered to the
services that react to them and are kept as a timeline per repository, which
you can read through the [API](/docs/api).

## What is not built yet

g1t is under active development. These parts of the model are designed but
not available yet:

- **Merging in g1t.** Shipping moves `main` forward to the attempt's head.
  When `main` has moved, the attempt has to pull it in first; g1t does not
  merge or rebase for you yet.
- **Diffs and review.** Seeing an attempt's changes and commenting on them
  on the site.
- **Pull requests from branches.** Opening an attempt from a branch you
  pushed, the way a pull request works elsewhere.
- **Checks.** Running an intent's acceptance checks automatically.
- **g1t agents for everyone.** g1t can run its own agents on an intent, each
  in a sandbox. This is in preview and limited to selected accounts; anyone
  can bring their own agent today.
