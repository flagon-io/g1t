---
title: Recording sessions
description: How a harness records its sessions on g1t, with the API, MCP or the CLI. Start, heartbeat, record and end a session, record subagents, report what a session cost, work before there is a work item, and have g1t start sessions on your Anthropic account.
---

A [session](/work/sessions/) is one run of your harness on a repository:
a Claude Code session, a Codex run. This page is for whoever wires a
harness up to g1t: how a session is started, kept alive, recorded and
ended, and how its subagents are recorded. The
[Claude Code plugin](/guides/claude-code-plugin/) does all of it for
Claude Code; other harnesses call the same API.

What sessions are for, and how the team sees them, is under Work:
[Sessions](/work/sessions/), [session titles](/work/session-titles/), and
[claims and dependencies](/work/claims-and-dependencies/), which keep
sessions out of each other's way.

## Record a session

Start a session when the harness starts, keep it alive while it works, and
end it when it stops.

1. **Start** it with `session` `start`, `g1t session start`, or
   [`POST /repos/{owner}/{name}/sessions`](/reference/api/sessions/start-session/),
   naming the `harness` (`claude_code`, `codex`, `cursor`, `copilot` or
   `other`) and the harness's own id for the session as
   `harness_session_id`. Starting again with the same id returns the
   session already started, so a hook can call it every time without
   checking first. Give `item` (the work item's number in the
   repository's workspace), `pull` and `branch` when you know them, and a
   `title` only if you can name the whole job in a few words (up to 200
   characters): otherwise g1t names it (see
   [session titles](/work/session-titles/)).
2. **Heartbeat** with `session` `update`, `g1t session heartbeat`, or
   [`PATCH /repos/{owner}/{name}/sessions/{id}`](/reference/api/sessions/update-session/)
   with an empty body. The same call attaches the session to a work item
   or pull request (`g1t session attach --item 12`), records the
   `head_commit` it pushed, or names it (`title`; a title a person pinned
   stays). A heartbeat also renews the session's claims.
3. **Record** what happens with `session` `record`, or
   [`POST /repos/{owner}/{name}/sessions/{id}/entries`](/reference/api/sessions/record-session-entries/):
   prompts, reasoning, tool calls, notes and the skills it used (`skill`,
   the skill's name only), up to 200 a request, and in `touched` what it
   touched (see [what a session records](/work/sessions/#what-a-session-records)).
   Give each entry a `key`, and recording it again does nothing.
4. **End** it with `session` `end`, `g1t session end`, or
   [`POST /repos/{owner}/{name}/sessions/{id}/end`](/reference/api/sessions/end-session/),
   with its `result` when it has one: what it reported when it finished.

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/sessions \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"harness": "claude_code", "harness_session_id": "5b0c1f9e-3d2a-4e8b-9f61-0c7d2a9e4b13", "item": 12}'
```

Every update and every batch of entries counts as a heartbeat. A session
not heard from for 15 minutes is idle, and after 30 minutes it ends as
timed out, until a heartbeat brings it back; see
[states](/work/sessions/#states). A session g1t runs on the workspace's
Anthropic account is recorded as harness `claude_managed_agents`.

Entries of a session attached to a pull request show in that pull
request's [session](/guides/why-blame/#sessions), beside what was recorded
on it with `record_session`, so reviewers and why-blame see them. Entries
recorded before the session named its pull request move onto it when it
does. A session never records tool output unless you send it as a
`tool_result` entry. What looks like a credential is taken out of
everything a session records, and only the workspace's members see inside
a session: see [who sees what](/work/sessions/#who-sees-what).

Updating, recording in and ending a session needs the token that started
it; starting one needs a confirmed email address and a role that may file
work items. With an access token, sessions need `pull_requests:write`.
See [who may do what](/work/claims-and-dependencies/#who-may-do-what).

## Work with no work item yet

Not every session starts from a work item, and most should not end with
one: a question, a look around or a quick fix needs no work item. The
session is the record of that work, and the team sees it in **Live now**,
on **Sessions** and on the project's overview, while it goes:

1. **It says what it is for.** g1t names it from what it does, first
   from its first prompt, then from its whole record (see
   [session titles](/work/session-titles/)). Give it a `title` yourself,
   when you start it or later with `session` `update`, only if you can
   name the whole job.
2. **It shows where it works.** Attach its `branch` and, once there is
   one, its `pull`: the project's **Live now** groups sessions on no work
   item by pull request, then by branch.
3. **It opens or claims a work item when it becomes a change** others
   should know about: a branch to push, a pull request. Look for one first
   (`work_item` `list`, `work_item` `list_claims`); if one covers the work,
   claim it. Otherwise open one and claim it in one step with `work_item`
   `claim` and a `title` instead of a `number` (see [claims](/work/claims-and-dependencies/#claims)),
   which attaches the session to it.

## Subagents

A harness that hands part of its work to a subagent (Claude Code's
subagents, a Managed Agents session's threads) records each as a session
of its own under the one that started it:

- Start it with `parent_id` (the session that started it), `agent_type`
  (its kind, such as `Explore`), the `task` it was given in a few words and
  the `prompt` (kept up to 4,000 characters). As its `harness_session_id`,
  give the parent's, `/agent/` and the subagent's id: starting it again
  returns it, in whatever order the harness's hooks arrive.
- It starts on its parent's work item, pull request and branch unless it says
  otherwise, so it is listed on them, and its heartbeats keep its parent
  active.
- End it with its `result`: its final message, kept up to 8,000
  characters. That is its parent's evidence; what its tools returned is
  never recorded. Once ended it stays ended, even when a late hook starts
  it again: that only fills in what it says.
- Ending a session ends the subagents it left going (`end_reason`
  `parent ended`).

Subagents see each other. Sibling subagents on one work item are listed in
`get_work` and `session` `list` beside the session that started them,
each holds a claim of its own (claims are told apart by session, so a
sibling's claim is listed in `others`), and when two of them touch the
same file, each is told with `overlap.detected`. The
[Claude Code plugin](/guides/claude-code-plugin/#subagents) does all of
this for Claude Code's subagents.

## What a session cost

A harness can say how many tokens a session used, and g1t estimates what
that cost at Anthropic's list price. The session's page and the
workspace's **Sessions** list show it as "≈ $4.12 at list price". It is
an estimate, not a bill: it is what the tokens cost at Anthropic's
published per-token prices, whatever your plan or discounts.

1. **Report** the session's usage so far with `session` `update`,
   `g1t session heartbeat --usage-json '…'`, or
   [`PATCH /repos/{owner}/{name}/sessions/{id}`](/reference/api/sessions/update-session/)
   with `usage`: one entry per model, with its `input_tokens`,
   `output_tokens`, `cache_write_5m_tokens`, `cache_write_1h_tokens` and
   `cache_read_tokens`. Usage is cumulative: each report replaces the
   last, so send the whole session's each time.

   ```json
   {
     "usage": [
       {
         "model": "claude-opus-5-5",
         "input_tokens": 1840,
         "output_tokens": 52310,
         "cache_write_5m_tokens": 210400,
         "cache_write_1h_tokens": 0,
         "cache_read_tokens": 4102300
       }
     ]
   }
   ```

2. **g1t prices it** as it records it: each model's tokens at its list
   price, cache writes at 1.25 times the input price for 5 minutes and
   twice it for 1 hour. A model id is matched without its date
   (`-20251001`), a `[1m]` suffix or a provider prefix
   (`us.anthropic.`). For claude-haiku-5-5, a prompt over 100,000 tokens
   is priced at its long-prompt rate: give those tokens in an entry of
   their own with `tier` `long`.
3. **The session shows `cost_usd`**, the sum over the models g1t has a
   price for. A model it has no price for, another provider's included,
   is left out, and `cost_partial` says some usage was priced as unknown
   ("some usage priced as unknown" on the page). With no model priced,
   `cost_usd` is null.

A subagent reports its own usage, to its own session: its parent's
transcript leaves out what the subagent used, so nothing is counted twice.
Only the workspace's members see what a session cost, as with the rest of
what is inside it ([who sees what](/work/sessions/#who-sees-what)). Up to
50 models a session, each count a whole number of tokens.

The [Claude Code plugin](/guides/claude-code-plugin/#what-a-session-cost)
counts it from the session's transcript and sends only the counts. The
Codex plugin does not report usage yet: it records sessions through g1t's
MCP tools, with no hooks to read Codex's session files from.

## Start a session on your Anthropic account

g1t runs no model. Work on a work item happens in your own harness, with
your own Claude, its skills and settings; g1t ties it back to the work
item. To hand a work item to a session from g1t itself (the work item
page's **Start a session**, `g1t work dispatch`, the `session` tool's
`dispatch`, or
[`POST /repos/{owner}/{name}/agent-sessions`](/reference/api/sessions/start-agent-session/),
in the repository the session works in):

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/agent-sessions \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"item": 12, "mode": "implement", "instruction": "Keep the old greeting behind a flag."}'
```

Give `item`, or `title` and `body` to open a new work item first (with
the repository as its origin), a `mode`
(`plan`, `implement` or `review`) and an optional `instruction`.

- **With an Anthropic AI provider** in the workspace (an owner adds one
  under [**AI**](/guides/ai/)), g1t starts a
  [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
  session on that account, with its key, on the model Ask is set to use
  (or `claude-opus-5-5`). It runs in a sandbox on Anthropic's side. Its
  first step installs the [g1t CLI](/guides/cli/) from g1t, sets git up to
  send the token and to commit as you (your username and noreply address),
  clones the repository and ties the clone to the session,
  so it works the way the work-on-item skill describes: `g1t work
  view`, `g1t work claim`, `g1t pr create --item`, `g1t pr checks --watch`.
  It works on a branch and a pull request, except in a repository with no
  commits yet, where there is nothing to open one against: it pushes the
  first version straight to the default branch. To show a screenshot of its
  preview in the pull request or a comment, it uploads the image with
  [`g1t attach`](/guides/cli/#images-in-descriptions-and-comments) (or
  `--attach` on `g1t pr create`, `g1t pr ready` and `g1t pr comment`) and
  pastes the Markdown it prints, rather than committing the image.
  g1t's MCP server is attached too, for anything the CLI has no command
  for. Its sandbox reaches the internet as a CI runner does, and it can
  search and read the web (web search and web fetch), for a fact the work
  needs from outside g1t or to open its own deploy. Before a headless
  browser (Playwright, Puppeteer) opens an https page, it copies the
  certificates the sandbox trusts into Chromium's own store, so pages load
  with certificate checks on. Both reach g1t with one token: g1t
  acting on your behalf, in that repository only, which lasts the session
  and is revoked when it ends. What the session does on g1t shows as
  **g1t, on behalf of @you**: its comments and reviews, what it closes or
  labels, and the work items and pull requests it opens (g1t's, requested
  by you); the audit log says "g1t on behalf of you". What it may do is
  your role in that repository, never more than Write, with what working on
  a work item needs (`repo:read`, `code:write`, `work:write`,
  `pull_requests:write`, and reading checks, workflows, deployments and
  observability): never settings, members, secrets, webhooks or merging.
  The session itself, its claims and its commits stay yours, and its
  pushes are yours too: to the repository and to its pull requests'
  working copies, under the repository's rules. An approval it gives is
  g1t's, so it counts toward required approvals only where agents'
  approvals do. The token is kept in a vault on the Anthropic account: the MCP
  server's credential, and `G1T_TOKEN`, which the sandbox holds only as a
  placeholder that is swapped for the token on its way to g1t. It is never
  in the prompt, and the model never sees it. The session has g1t's skills
  (work-on-item, coordinate and fix-integration, uploaded to the account
  the first time, and as a new version whenever g1t changes them; the
  agent uses the version g1t uploaded) next to the account's own custom
  skills, at their latest version, up to 20 in all. It may hand parts of the work to copies of itself; each is recorded
  as a subagent.
- **Without one**, or with `handoff: true`, nothing starts: you get
  `command`, a Claude Code command line to run in your working copy with
  the [plugin](/guides/claude-code-plugin/), and `prompt`, what to paste.
  The session that starts attaches to the work item.

The answer has the `session` on g1t, its `session_url`, and
`provider_session_url`, where the Anthropic Console shows it. The Console
keeps sessions in the workspace the key belongs to, and a session does not
say which that is: if the key is not in the account's Default workspace,
set the provider's **Console workspace** under [**AI**](/guides/ai/#anthropic-console-workspace)
so the link opens there.
The session is recorded as harness `claude_managed_agents`: its messages,
the tools it called and with what (never what they returned), the skills
it read, what it touched, and each thread as a subagent with its task and
report. g1t follows it every minute, and at once while its page is open. A
call that waits for someone's approval is declined, since nobody is
watching. When it finishes, its session ends with its last message as its
result. Whoever started it can stop it from its page, and open it on the
Claude Console from there (**Open in Claude Console**); nobody else is
given that link, since the Console shows everything the session was asked
and every tool's output. It runs on your
workspace's key and Anthropic bills the account for it; g1t bills nothing.

## Assign g1t, or ask it in the thread

You can also hand work to g1t from the work item or pull request itself,
the way you would ask a teammate:

- **Assign the work item to `g1t`**: **Assign to g1t** in the work
  item's sidebar, `g1t` among the assignees in
  [`update_work_item`](/reference/api/work-items/update-work-item/), or
  `g1t work edit 12 --add-assignee g1t`.
- **Mention `@g1t` in a comment** on a work item or a pull request:
  "@g1t the button still overlaps on a phone, fix that". On a pull
  request, the session carries on with that pull request on its branch.
  On a work item, it takes the work item on.

g1t reacts 👀 to what asked it, the comment or (for an assignment) the
work item, then starts a session on the workspace's Anthropic account, as
the person who asked, with what they wrote as its instruction. Each
session shows in the work item's or pull request's conversation as a card,
where it started, the way a comment or a review does: who it works for,
where it stands, its branch, and its report when it ends, linked to its
page. Not happy with what a session did? Say so with `@g1t` in the same
thread. The next session is told to fix the work on the same branch and
pull request, not start over, and `g1t work view` shows it every
session and pull request so far. If the session you started on that
thread is still going, your comment goes to it instead of starting
another.

Only the workspace's members can ask g1t; anyone else's `@g1t` is an
ordinary mention. A mention in quoted text or code (`` `@g1t` ``) asks
nothing. g1t answers one thread at most six times an hour. When it cannot
start a session, for instance because the workspace has no Anthropic AI
provider, it says why in the thread. On an update pull request g1t opened,
`@g1t rebase` and the other
[comment commands](/guides/dependency-updates/#comment-commands) still do what
they say.
