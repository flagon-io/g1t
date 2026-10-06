---
title: Sessions and why-blame
description: How g1t records the way a change was made, and how to find out why any line is the way it is.
---

Blame tells you who last changed a line. On g1t it also tells you why: the pull request the line arrived in, the issue that asked
for it, and, when an agent wrote it, the agent's own account of what it did.
That comes from **sessions**, the record of how each pull request was made.

## Sessions

A session belongs to a pull request. It records how the change was made,
entry by entry, as it happens:

| Kind | What it holds |
| --- | --- |
| `prompt` | What the agent was asked to do, and messages people sent it while it worked. |
| `message` | The agent's own reasoning and explanation. |
| `tool_call` | A tool the agent ran, and with what input. |
| `tool_result` | What the tool returned. |
| `note` | Anything else worth keeping, such as what the agent was told about other work in progress. |

Each entry is stored with the head commit of the pull request at the time
it was recorded. That link is what lets g1t show the reasoning behind a
commit rather than only the commit.

Read a session on the pull request's **Session** tab, with the
`pull_request` tool's `read_session` action,
or with `GET /repos/{owner}/{name}/pulls/{number}/session?after=`. A session
is as visible as the repository, so do not put secrets in one.

### From g1t agents

A [g1t agent](/guides/g1t-agents/) records its whole session itself:

- it opens with a note naming the model that ran, and a note of the other
  pull requests in progress it was told about;
- then everything it reads, runs and decides, as it happens;
- messages people and other agents sent it while it worked;
- its revisions and catch-ups;
- and at the end, what its run cost before the margin.

Its credential and the model key are removed from anything recorded.

### From your own agent

An agent you run yourself records its session in one of two ways.

**With the hook installer**, for Claude Code. Every session is recorded
without the agent having to remember:

```sh
curl -fsSL https://g1t.sh/install/claude.sh | sh
```

See [recording sessions automatically](/guides/bring-your-own-agent/#recording-sessions-automatically)
for what it installs and how to remove it.

**With the `pull_request` tool's `record_session` action**, from any agent. It takes a list of entries, each
with a `kind` from the table above and `text`, and `tool` for tool entries.
The same is `POST /repos/{owner}/{name}/pulls/{number}/session`, with up to
200 entries per request:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/pulls/14/session \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entries": [
        {"kind": "prompt", "text": "Make the greeting name the caller."},
        {"kind": "tool_call", "tool": "Edit", "text": "src/main.rs"},
        {"kind": "message", "text": "Took the name from the first argument, falling back to world."}
      ]}'
```

Record as you work, not only at the end: an entry is tied to the commit
that was the head when it was recorded, so recording before each push is
what lets why-blame find the reasoning behind each commit.

## Why a line is the way it is

Every file can be shown with **Blame**: beside each run of lines, the commit
that last changed it.

1. Open a file in the repository's **Code** tab.
2. Choose **Blame**.
3. Pick a line.

g1t then shows why the line is the way it is:

- the commit that last changed it;
- the pull request it arrived in, and who or what wrote it and merged it;
- the issue that asked for it, with its description;
- when an agent wrote it, the agent's own account of the change and the
  commands it ran, taken from its session. The steps shown are from the
  work that produced that commit: the agent's messages, and the tool calls
  that touched the file.

Blame follows every parent of a merge, so a line that came into a pull
request when it caught up with `main` is credited to whoever wrote it on
`main`, not to the merge.

## Commit pages

Every commit has a page of its own, `g1t.sh/<workspace>/<repo>/commit/<hash>`,
with its diff, its parents and the pull request it arrived in. The
repository's **Commits** tab lists them.
