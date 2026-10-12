---
title: Memory
description: Short notes about a project or a whole workspace that your team and your coding agents read before they start and add to as they learn.
---

Memory is what someone working on a project should know before they start:
how to build it, its conventions, the decisions behind it and its traps.
People write it on g1t, and your coding agents read and add to it through
the [`memory` tool](/reference/mcp/#memory) or the API, so what one agent
learns the next one starts with.

| You want to | Go to |
| --- | --- |
| Read or change what a project remembers | The repository's **Memory** page, `g1t.sh/<workspace>/<repo>/memory` |
| Read or change what holds in every project | **Workspace memory**, `g1t.sh/<workspace>/-/memory` |
| Have your agent read memory before it starts | `memory` with `recall` |
| Have your agent save what it learned | `memory` with `remember` |

## Two levels

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

Each memory has a **kind**: `fact` (the default), `convention`, `decision`
or `gotcha`.

## From your coding agent

An agent connected over [MCP](/guides/bring-your-own-agent/) uses the
`memory` tool:

- **`recall`** before it starts: the project's memory and, for members of
  the workspace, the workspace's, pinned memories first, then the most
  recently used. `query` matches every word in any order; leave it out to
  list everything. `limit` caps each level, 20 by default and at most 100.
- **`remember`** when it learns something the next agent should know: one
  short fact per call, at most 1,000 characters. `scope` is `project` (the
  default) or `workspace`, and `kind` is one of the four kinds above.
  `from_number` records the pull request it was working on as where the
  memory came from.

```json
{ "name": "memory", "arguments": { "action": "remember", "repo": "acme/web",
  "text": "The date tests fail unless TZ=UTC.", "kind": "gotcha", "from_number": 14 } }
```

The same over REST:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/memory \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "The date tests fail unless TZ=UTC.", "kind": "gotcha"}'

curl "https://api.g1t.sh/repos/acme/web/memory?q=tests" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

Reading needs the `memory:read` scope, and saving `memory:write`. Every
memory a `recall` returns counts as used, which keeps it near the front of
what the next `recall` returns.

Tell your agent to treat memory as notes from colleagues: usually right,
sometimes out of date, and where it disagrees with the code, the code wins.
A line in your repository's `AGENTS.md` or `CLAUDE.md` is enough, such as
"Before starting, call g1t's `memory` tool with `recall`; save anything the
next agent should know with `remember`."

## Curate it

Memory is only as good as it is true. On a project's **Memory** page,
anyone with the Write [role](/guides/access-and-roles/) or higher on its
repository can, and on **Workspace memory**, members can:

- **add** a memory, with its kind;
- **pin** one, so it comes first in every `recall`;
- **edit** one that has drifted, or change its kind;
- **forget** one that no longer holds.

Each shows who added it and when, and when it was last recalled. A memory
nobody has recalled for a long time is a good one to check. Saving the same
text twice keeps one memory. A project or a workspace keeps up to 500.

For members, a project's Memory page also lists the workspace's memory,
read-only; manage it from **Workspace memory**.

## Who can see it

| Memory | Who reads it | Who changes it |
| --- | --- | --- |
| A project's | Anyone who can read its repository: for a public one, anyone | Write or higher on the repository |
| The workspace's | Members of the workspace | Members of the workspace |

Since a public project's memory can be read by anyone, keep what the
workspace keeps to itself in workspace memory, or in a private project. An
agent's token reads only what the person it acts for can read.

## Never a secret

Memory is read by everyone who can see it and by their agents, so it never
holds a secret. g1t refuses text that looks like one: a key or token with a
known prefix (such as `sk-`, `ghp_`, `AKIA` or `g1t_`), a private key, a
URL with a password in it, `password=` or `token:` followed by a value, or
a long random string. Say where the secret lives instead: "The deploy key
is the `DEPLOY_KEY` secret". Workflows read secrets from
[secrets and variables](/guides/secrets-and-variables/), never from memory.
