---
title: Agent abilities
description: What an agent may do, in groups - g1t's own, its computer, each connected integration and MCP servers you add - and for each whether it acts alone, only when asked for it, after asking first, or never; whose connection it uses; and the cards it posts when it can't.
---

Every agent has an **Abilities** tab on its page, after **Skills**. It
lists what the agent can do, in groups, and for each ability a **level**
that says how freely it may do it. The levels are enforced in code: a
tool the agent isn't allowed is withheld, and one it may use only after
asking posts a card and waits. The tab opens with the whole thing in a
sentence, such as *Can read issues in Linear and open pull requests on its
own; imports issues in Linear when asked for it; asks before commenting in
Linear and merging; never deploys to production.*

Skills tell an agent how to do a kind of work; abilities say what it may
touch. A skill never adds an ability (see
[agent skills](/guides/agent-skills/)), and an agent never does more for
someone than that person could do themselves (see
[what agents can do for whom](/guides/agent-access/)).

## The levels

| Level | What it means |
| --- | --- |
| **Alone** | It does it when its work calls for it, and says so. |
| **Alone when asked for it** | It does it on its own when the person it acts for named the thing in what they asked (the issue's key, or the action), and asks first otherwise. |
| **Ask first** | It posts a card in the conversation saying exactly what it would do. The person it acts for, or an owner, presses **Allow** or **Deny**. Allowed, it runs as the person who pressed, and the agent hears the result. |
| **Never** | The tool isn't offered. If the agent asks for it anyway, it is refused with the rule's name, and says so plainly rather than trying another way. |

Defaults follow what an ability does:

| What it does | Default | Freest it can be set |
| --- | --- | --- |
| Reads | Alone | Alone |
| Writes inside g1t (opens an issue, a pull request, an edit) | Alone when asked for it, or today's choice for code and docs | Alone |
| Sends something outside g1t (a comment in another system, a message, a change there) | Ask first | Alone |
| Purchases, credentials and permission changes (a production deploy) | Never | Ask first |

Every change to a level is saved as a new version of the agent, like any
other change on its profile, and shows under **Profile → Versions** as a
change to its abilities.

## The groups

### g1t

Artifacts, chat, code, issues and pull requests, making files, and working
with colleagues and memory are always on, within the access of the person
the agent acts for and everyone who will read its answer. They have no
level to set. Four of them keep a choice, the same choice as
[what it may do alone](/guides/agents/#what-it-may-do-alone) on the Profile
tab:

| Ability | Choices | Default |
| --- | --- | --- |
| Open pull requests | Alone, Ask first | Alone |
| Merge | Alone, Ask first, Never | Ask first |
| Deploy to production | Ask first, Never | Ask first |
| Edit docs | Alone, Ask first (as suggestions) | Ask first |

Changing one here changes it there, and the other way round.

### Its computer

A shell, files, a browser and web search, on a computer of the agent's
own. These are listed so you can see what is coming, and are marked
**Coming** until the agent computer exists. Nothing can be set for them
yet.

### Integrations

Every integration the workspace has connected lists what an agent can do
through it, one row per action, with a level for each. What is listed
comes from what the integration does today:

| Integration | Rows | Tool the agent calls |
| --- | --- | --- |
| Linear | Read issues · Import issues · Comment | `lookup_outside` · `import_outside` · `act_outside` |
| Jira | Read tickets · Import tickets · Comment | `lookup_outside` · `import_outside` · `act_outside` |
| Sentry | Read issues · Import issues · Comment · Resolve issues | `lookup_outside` · `import_outside` · `act_outside` |
| Datadog, Alerts webhook | None: they open issues by themselves | — |

Reading looks an item up by its key (`ENG-42`, `TECH-1234`) or its
address. Importing opens an issue in a repository here, linked back to
the item, as the person the agent acts for. Commenting and resolving write
in the other system, as the workspace's connection, and name the person
the agent acted for with a link back to the conversation.

An integration that gives agents abilities but isn't connected is listed
too, with **Connect** for owners and **Ask an owner** for anyone else,
which opens its [Marketplace](/guides/marketplace/) page. Nothing on it
can be set until it is connected.

#### Whose connection

Each integration row says whose connection it runs on:

| | |
| --- | --- |
| **Workspace connection** | The agent acts as the integration's connection for the whole workspace, the one an owner set up under Integrations. Only owners choose this. |
| **Asker's connection** | The agent acts as the asking person's own account. When they haven't connected one, the agent posts a **Connect** card in the conversation: one press opens their own settings for it. |

A [personal agent](/guides/agents/#personal-agents) starts on the asker's
connection; an owner can put it on the workspace's. Linear, Jira and
Sentry can't be connected per person yet, so for them the choice is the
workspace's connection today.

### MCP servers

Owners add MCP servers to an agent, one at a time, by a name and an HTTPS
address on a public host. g1t lists the server's tools when it is added,
and each tool becomes a row:

- a tool the server marks as read-only is a **read**, Alone by default;
- any other tool, including one the server says nothing about, counts as
  a **write outside g1t**, Ask first by default.

Tools are offered to the agent as `<server>__<tool>`, with the arguments
the server describes. **List its tools again** picks up a server that
changed; **Remove** takes the server and its rows off the agent at once.
Both are new versions of the agent. An agent keeps at most 10 servers,
and each server's first 40 tools. Servers that need a key or a sign-in
aren't supported yet.

## Ask first, in the conversation

When an ability is Ask first (or Alone when asked for it, and the person
didn't ask), the agent posts a card where it is working: what it would
do, for whom, and under which rule, with the text it would write. The
person it acts for, or an owner, presses **Allow** or **Deny**:

- **Allow** runs the call as the person who pressed it. The card then says
  what happened, and the agent is told the result. A session that was
  waiting goes on with it at its next step.
- **Deny** tells the agent, which says so and doesn't try another way.

A [session](/guides/agent-sessions/) with a call waiting shows **Needs
approval** and the call it waits for, until the card is answered or the
session is stopped.

## When something is missing

When a request needs an integration that isn't connected, or an ability
the agent doesn't have, the agent says so plainly and posts a **Request**
card:

- for an integration, **Ask the owners** opens the same request the
  Marketplace does (see [ask an owner to add something](/guides/marketplace/#ask-an-owner-to-add-something)),
  and **Open in Marketplace** goes to its page;
- for an ability, **Ask the owners** notifies every owner with a link to
  the agent's Abilities tab, and **Open Abilities** goes there.

Owners see a link to do it themselves instead.

## Refusals, in the transcript and the audit log

A policy fails closed. When a tool is withheld or a call is refused, the
agent's answer says which rule refused it, such as *Linear: Comment is
Never*, and so does the session's transcript (the tool call shows as
refused). The workspace's [audit log](/guides/audit-log/) records every
refusal under the agent, with the rule (`integration:linear:comment=never`)
and what was refused, and every Allow or Deny under the person who
pressed it.

## Who edits

| Agent | Who changes its abilities |
| --- | --- |
| A workspace agent | The workspace's owners. |
| A personal agent | The member it belongs to, except that only owners put it on the workspace's connection. |
| `@g1t` | Owners, like any workspace agent. |

Everyone in the workspace can read the tab.

## API

An agent's abilities are part of its definition: `abilities.settings`,
by ability id (`integration:linear:comment`), each with a `level`
(`alone`, `asked`, `ask`, `never`) and, for an integration, `credentials`
(`workspace` or `asker`); and `abilities.mcp_servers`. Changing an agent
with `abilities: { settings }` replaces its settings, and is a new
version like any change. MCP servers are added and removed with the
agents service's `add_mcp_server`, `refresh_mcp_server` and
`remove_mcp_server`; they never travel with a change.

## Next

- [Agents](/guides/agents/): hiring, changing and running agents.
- [Agent skills](/guides/agent-skills/): how an agent does a kind of work.
- [Marketplace](/guides/marketplace/): connecting integrations, and asking an owner to.
- [What agents can do for whom](/guides/agent-access/): the access every ability runs within.
