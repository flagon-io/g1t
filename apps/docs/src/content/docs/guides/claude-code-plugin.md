---
title: Claude Code plugin
description: Install g1t's plugin for Claude Code, which records your sessions on g1t, gives Claude the issue's work context, and adds g1t's MCP server, skills and commands. What each hook records and never records, and how to opt out.
---

g1t's plugin for Claude Code connects the sessions you run on your own
machine to the work on g1t. With it installed, working in a g1t repository:

- each Claude Code session is recorded on g1t as a
  [session](/guides/why-blame/#sessions), attached to its issue and pull
  request, so the people and agents also working there can see it;
- Claude starts each session knowing the issue it is on: its definition of
  done, who has claimed it, its pull requests and what blocks it;
- Claude has g1t's [MCP tools](/reference/mcp/), three skills for working
  on issues, and the commands `/g1t:claim`, `/g1t:status` and
  `/g1t:handoff`.

Your session runs where it always does. g1t keeps the record and the
coordination; nothing about how Claude Code runs changes.

## Install

You need Claude Code, Node 18 or later (Claude Code runs on it) and the
[g1t CLI](/guides/cli/), which the plugin's hooks use.

1. Install the g1t CLI and sign in, if you have not:

   ```sh
   curl -fsSL https://g1t.sh/install | sh
   g1t auth login
   ```

   On Windows, `irm https://g1t.sh/install.ps1 | iex` installs it.

2. Add g1t's plugin marketplace and install the plugin:

   ```sh
   claude plugin marketplace add https://g1t.sh/flagon-io/g1t.git
   claude plugin install g1t@g1t
   ```

   Or run `/plugin` inside Claude Code and choose the marketplace there.

3. Start Claude Code again, run `/mcp` and choose **g1t** to sign g1t's
   MCP server in through your browser.

`curl -fsSL https://g1t.sh/install/claude.sh | sh` prints the same
commands; add `-s -- --cli` to have it install the CLI too.

The plugin works in any working copy whose git remote is on g1t.sh, or on
the host in `G1T_HOST` for a self-hosted g1t. Everywhere else its hooks do
nothing.

## What it records

The plugin's hooks call the `g1t` CLI, signed in as you, so a session is
recorded as yours and is as visible as the repository it is in.

| When | The hook runs | What g1t receives |
| --- | --- | --- |
| A session starts or resumes | `g1t session start --harness claude_code --harness-session-id ID` | A session for this Claude Code session. Starting the same session again, as a resume does, finds it rather than making another. |
| You send a prompt | `g1t session log --kind prompt TEXT` | Your prompt's first 2,000 characters. |
| Claude uses a tool | `g1t session log --kind tool_call TEXT` | The tool's name and one line on what it was called with: the command, file, pattern or address, up to 200 characters, with anything that looks like a token or password replaced by `…`. |
| A `git push` reaches the remote | `g1t api update_session -f id=ID -f head_commit=SHA` | The commit you pushed, so the session's entries line up with the code. |
| Claude finishes a turn | `g1t session heartbeat` | That the session is still active, which also renews its claims. |
| The session ends | `g1t session end --reason REASON` | That it ended, and why: you exited, cleared it or logged out. |

It never records:

- what a tool returned: command output, file contents, search results and
  web pages are never read or sent;
- Claude's replies or reasoning;
- your files, environment or transcript.

A session that stops sending heartbeats reads as idle after 15 minutes and
ended after two hours, so a closed laptop does not leave work looking
claimed.

The hooks return at once: the CLI calls run in a background process, so a
slow network never holds Claude up.

## The context Claude starts with

When a session starts, the plugin looks for the issue it is working on:
the one the session claimed earlier, or a number in the branch's name
(`42-fix-login`, `issue-42`, `fix/42`). If it finds one, it runs
`g1t work context N` and gives Claude the answer: the issue and its
definition of done, its claims and sessions, its pull requests with their
checks and overlaps, what blocks it and what it blocks, the decisions
recorded on it and the last integration failure. If the answer takes longer
than a second, Claude is told to load it itself.

With no issue in sight, Claude is told how to load and claim one.

## Skills

Claude uses a skill when the task matches it, or you can run one by name.

| Skill | What it does |
| --- | --- |
| `/g1t:work-on-issue N` | Loads the issue's context, claims it, makes a branch named for it, opens a draft pull request early with `g1t pr create --issue N --draft`, does the work, watches the checks and merges, or adds the pull request to the [merge queue](/guides/merge-queue/). |
| `/g1t:fix-integration N` | For a pull request the merge queue failed together with others: reads the `integration.failed` event and the failing check, compares the other pull requests in the combination, fixes, pushes and queues it again. |
| `/g1t:coordinate N` | Follows the issue's events in the background with `g1t work events --follow --issue N`, and acts on another claim, an overlapping pull request, a change to what blocks it or an integration result as it happens. |

## Commands

| Command | What it does |
| --- | --- |
| `/g1t:claim N [note]` | Loads issue N's context and claims it for this session, telling you who else holds a claim. |
| `/g1t:status` | This session, and the repository's active claims and sessions. |
| `/g1t:handoff N [@login]` | Pushes what is unpushed, writes a hand-off note and hands the issue off, to anyone or to one person. |

A claim says you are working on an issue. It is never a lock: a second
claim is allowed, and whoever makes it is told about the first.

## When the CLI is missing or signed out

If `g1t` is not installed, or not signed in, the hooks record nothing and
Claude Code says so once. The plugin never installs anything itself.
Install the CLI or run `g1t auth login`, and the next session is recorded.

## Opt out

| To | Do |
| --- | --- |
| Not send prompts | Set `G1T_RECORD_PROMPTS=0` in the environment Claude Code runs in. |
| Not record anything | Set `G1T_RECORD=0`. |
| Turn the plugin off for now | `claude plugin disable g1t@g1t` |
| Remove it | `claude plugin uninstall g1t@g1t` |

To set one of these for every session, put it under `env` in Claude Code's
settings, for example in `~/.claude/settings.json`:

```json
{ "env": { "G1T_RECORD_PROMPTS": "0" } }
```

A recorded session can be read on the pull request's **Session** tab.

## The earlier hook installer

An earlier `curl -fsSL https://g1t.sh/install/claude.sh | sh` added a hook
of its own, `node ~/.g1t/hook.mjs`, to `~/.claude/settings.json`. The
plugin replaces it. Once the plugin is installed, remove those entries from
`~/.claude/settings.json` so a session is not recorded twice. Running the
installer again brings the old hook up to date and prints the plugin's
commands.

## Other coding agents

Agents without plugins use the same CLI commands from their instructions
file. Put this in the repository's `AGENTS.md`:

```md title="AGENTS.md"
## Working on g1t

This repository is on g1t. Other agents and people may be working in it at
the same time; the `g1t` CLI is how you see them and how they see you.

- When you start, record a session: `g1t session start --harness codex`
  (or `cursor`, `copilot`, `other`: the harness you are). The CLI remembers
  it for this working copy. Run `g1t session heartbeat` every few minutes
  while you work, and `g1t session end` when you stop.
- Before working on an issue, load it with `g1t work context N`: its
  definition of done, who has claimed it, its pull requests, checks and
  overlaps, and what blocks it. Then claim it with
  `g1t work claim N --note "what you are about to do"`. If someone else
  holds a claim, say so before going on.
- Work on a branch whose name starts with the issue number
  (`42-short-description`), and open a draft pull request early:
  `g1t pr create --issue N --draft --fill`.
- Log decisions worth keeping with `g1t session log --kind note "TEXT"`.
  Never log secrets or command output.
- Run the repository's tests before each push, and watch the checks with
  `g1t pr checks --watch --fail-fast` (and `g1t run logs --failed` for why
  one failed). When the merge queue reports an integration failure, read
  it with `g1t work events --type integration.failed --issue N`, diff the
  other pull requests in the combination (`g1t pr diff OTHER`), fix, push
  and merge again.
- If you stop before the issue is done, hand it off:
  `g1t work handoff N --note "what is done, what is left"`.
```

The same text is in the g1t repository at
`plugins/other-harnesses/AGENTS.snippet.md`.

To give Codex g1t's MCP tools as well:

```sh
codex mcp add g1t --url https://mcp.g1t.sh
codex mcp login g1t
```

or, in `~/.codex/config.toml`, with a token in `G1T_TOKEN` instead of
signing in through the browser:

```toml
[mcp_servers.g1t]
url = "https://mcp.g1t.sh"
bearer_token_env_var = "G1T_TOKEN"
```

[Connect a coding agent](/guides/bring-your-own-agent/) covers Cursor,
OpenCode and other MCP clients.
