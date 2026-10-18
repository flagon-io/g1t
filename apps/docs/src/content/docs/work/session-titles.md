---
title: Session titles
description: How g1t names a session from the whole of its work, when a title settles and when it changes, naming with your AI provider or without one, an agent's own title, and pinning yours.
---

A session's title names the whole of its work, the way a person would sum
it up: "Fix preview builds on large repositories", not the last thing it
was asked. It starts provisional, settles once there is enough to go on,
and changes only when the work does.

## Where a title comes from

Each title says where it came from (`title_source`) and when it settled
(`title_settled_at`):

| Source | What it is |
| --- | --- |
| `prompt` | Provisional: what its first prompt asked for (its first line or sentence, without pasted text, image placeholders, code or markdown). Shown muted. |
| `item`, `pull`, `summary` | Settled by g1t from the session's record: a work item's title, a pull request's, or a summary of the work. |
| `agent` | Its harness or agent named it (`title` on start or update, `g1t session attach --title`). |
| `person` | Someone renamed it on its page: pinned. |

A session with no title yet is called what its first prompt was for, else
**Session on** its branch, else **Untitled session**. A title that is only
a tag, such as `<pasted_content id="5c50">`, counts as no title.

## When it settles

g1t settles a provisional title once there is enough to go on, whichever
comes first:

- the session works on a work item or pull request: it is attached to
  one, claims one, opens one, pushes its branch, makes its head commit, or
  a commit names it in a `G1t-Session` trailer. Only naming `#12` in a
  prompt is not enough;
- it has recorded three prompts;
- it has run for 30 minutes.

It names it again only when what the session works on changes (another
work item or pull request, or many more prompts: twice as many as when it
last settled, and at least five more), at most every 20 minutes, and only
when the new title says something else. It names it a last time when the
session ends, from everything it did.

## How g1t names it

With an [AI provider](/guides/ai/) chosen for Ask, the provider names the
session in a few words, on its fast model, from a short digest of the
record:

- its repository, and its title so far;
- the work items and pull requests it worked on, and the work items it
  only mentioned;
- its prompts, the first three and last three, as recorded, with
  credentials taken out;
- its subagents' tasks, where it changed files, how many commits it made,
  and what it reported.

A session is asked about at most five times. One whose work is a single
work item (with at most one pull request), or a single pull request,
takes that title without asking.

Without a provider, or when it fails, the title is the work item's, else
the pull request's, else what the session's most telling prompt asks for,
without greetings and preambles ("This project used to…", "I think",
"So"), else, with no prompts, its first subagent's task. g1t's own titles
are up to 80 characters.

A subagent goes by its task and is not titled.

## An agent's own title

An agent may name its session when it can name the whole job in a few
words: `title` when it starts or updates its session, or
`g1t session attach --title "Fix the preview builds"`. Titles are up to
200 characters. g1t keeps an agent's title, unless the session went on to
other work items or pull requests after it was named, when it is named
again as it ends. An agent that sends back the provisional title leaves it
provisional.

The [Claude Code plugin](/guides/claude-code-plugin/) sends no title of
its own: it tells Claude how titles work, and to set one only if it can
name the whole job.

## Pin a title

On a session's page, choose **Rename** beside its title, type yours and
**Save**. Your title is pinned: neither g1t nor the agent replaces it.
**Let g1t name it** unpins it, and g1t names the session again when it
next settles.

Whoever runs the session can rename it, and so can anyone with write
access to its repository. A subagent cannot be renamed.
