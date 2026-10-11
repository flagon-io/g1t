---
title: Customize
description: One place for what shapes how a workspace's agents work - Skills, Connectors and Plugins, each with what you have and what you can add. Everything installs in the formats Claude Code reads, so public marketplaces, plugins, skills, subagents and MCP servers work on g1t as they are, and what you customize reaches Claude Code when it runs on a g1t runner.
---

**Customize** is where a workspace shapes what its agents know, what they
can reach, and what they bring with them. It has three parts, each in two
halves: **Yours**, what the workspace has, and **Discover**, what it can
add.

| Part | What it holds |
| --- | --- |
| **Skills** | What agents know how to do: g1t's [foundational skills](/guides/agent-skills/#the-foundational-skills), your workspace's [skill library](/guides/agent-skills/#the-skill-library), and every skill published in a marketplace. |
| **Connectors** | What agents can reach: MCP servers connected once and given to agents, and g1t's own [integrations](/guides/integrations/) (GitHub, trackers, alerts, model providers). |
| **Plugins** | Skills, agents and connectors published together, from any marketplace in the open plugin format. |

Everything installable keeps the formats and the names the open ecosystem
uses. A marketplace is a repository with `.claude-plugin/marketplace.json`;
a plugin is a folder with `skills/`, `agents/`, `commands/` and `.mcp.json`;
a skill is a `SKILL.md` folder. g1t reads them exactly as Claude Code does
and invents no format of its own, so a plugin written for Claude Code
installs here unchanged, and what a workspace customizes reaches Claude
Code when it [runs on a g1t runner](#what-a-run-gets).

Open Customize from **Apps** at the foot of the rail (the Apps page and
the launcher lead here), from **More** on a phone, or with
<kbd>Ctrl</kbd> <kbd>K</kbd> and *Customize*. Its address is
`g1t.sh/<workspace>/-/customize`; each part has its own, such as
`…/-/customize/skills`. The old `…/-/marketplace` addresses arrive here.

## Who adds things

Every member of a workspace browses Customize. Only its **owners** add
marketplaces, install plugins, connect connectors and decide which agents
get what, because each of those reaches the workspace's data or spends
its money. Everyone else sees **Request** where an owner sees **Install**
or **Connect**, and asks (see [requests](#requests)). Writing and
importing skills stays with owners and team maintainers, as in the
[skill library](/guides/agent-skills/#who-can-do-what).

Every page has a search, filters by category, by source (which
marketplace) and by availability, and an **Add** menu: **Write a skill**,
**Import**, **Add a marketplace** and **Add a connector by URL**.

## Skills

**Skills → Yours** is the skill library, the same one as **Agents →
Skills**: g1t's foundational skills, the skills your workspace wrote,
imported or saved from a session, and the skills installed plugins brought.
Writing, importing, versions and the linked repository are in
[agent skills](/guides/agent-skills/).

**Skills → Discover** lists every skill the marketplaces your workspace
reads publish, one card per skill, with the plugin and the marketplace it
comes from. Each card says whether your library has it already, and
whether the plugin it is in can be installed here (see
[what g1t can read](#where-plugins-come-from)).

### Add a skill from Discover

1. Open **Customize → Skills → Discover** and find the skill, by name or
   by what it does.
2. Choose **Add**. g1t installs the plugin that carries it, at its current
   commit, and the plugin's skills join the library.
3. Choose who gets it under **Available to**: every agent in the
   workspace, a team (every agent on it), or one agent. This is a skill
   [attachment](/guides/agent-skills/#the-skill-library), so the same
   rules apply: owners attach anywhere, team maintainers on the teams they
   maintain.

A skill does nothing until it is available to someone. Owners can turn any
skill off for one agent from its **Skills** tab, as with every skill.

### Skills from plugins

A skill a plugin brings is named `plugin:skill`, after the plugin's name
(`pdf@anthropic-agent-skills` brings `pdf:pdf`), on the library's page, on
each agent's Skills tab and in the agent's own instructions. Agents call it
with `use_skill` by that name, or by its bare name when only one plugin
brings a skill called that. A plain name always means the workspace's own
skill first.

| | A skill written here | A skill from a plugin |
| --- | --- | --- |
| Name | Lowercase letters, digits and single hyphens, at most 64 characters; the foundational skills' names are taken | As Claude Code takes it: letters, digits, dots, underscores and hyphens, at most 64, case kept; may reuse a foundational name, since it is always called as `plugin:name` |
| Edited | In the editor, or from the linked repository | Read-only. It changes when the plugin is reinstalled at a newer commit, and leaves with the plugin |
| Size | 1 MB and 200 files | 1.5 MB and 1,000 files kept here. A larger folder keeps its text and leaves its biggest files out, binaries first, each named on the plugin's page; Claude Code on a runner gets the whole plugin |
| `description` | At most 1,024 characters | Kept as written; a longer one is shortened for the listing |
| `tools:` | Only tools agents have are accepted | Tools agents don't have are kept aside rather than refused |
| `commands/*.md` | — | Each command file becomes a one-file skill named after the file, its `description` (or first line) saying when to use it |

When a plugin is **switched off**, its skills leave every agent that had
them at once, and come back when it is switched on. When it is
**uninstalled**, its skills and their attachments go. **Update** reads the
plugin again at its marketplace's current listing: each skill gets a new
version, and every attachment follows it.

## Connectors

A **connector** is an MCP server the workspace connects once, then gives
to agents. **Connectors → Yours** lists the ones your workspace has, each
with its state and how many tools it offers, beside g1t's own integrations
connected here (GitHub, Linear, Jira, Sentry, Datadog, model providers and
the rest), which keep their own [setup pages](/guides/integrations/).

**Connectors → Discover** is the [directory](/guides/integrations/#the-directory):
every tool g1t connects to, by category. A tool that publishes a remote
MCP server (Linear, Notion, Sentry, Stripe, Figma, Supabase, Cloudflare
and more) is connected from here; an integration g1t built itself
(trackers, alerts, model providers) opens its own page; one marked
**Soon** can be asked for.

### Where a connector comes from

| From | How |
| --- | --- |
| **The directory** | Choose the tool and **Connect**. g1t knows its address and how it signs in. |
| **A plugin** | A plugin's `.mcp.json` names servers. Installing it adds each remote (`http` or `sse`) server as a connector, named *Plugin: server*, waiting for an owner to sign in or paste a key, unless it is open. A `stdio` server runs only where Claude Code runs, and is marked so. |
| **An address** | **Add a connector by URL**: a name (2 to 32 lowercase letters, digits and hyphens) and an HTTPS address on a public host, with how it signs in. |

Two connectors with the same name get numbered. A workspace keeps at most
50.

### Signing in

Each connector signs in the way its server asks. A directory card says
which, and anything to know first, such as where a key comes from:

| Sign-in | What happens |
| --- | --- |
| **Browser** | OAuth. g1t finds the server's authorization server from the server's own metadata, registers itself as a client there when the server allows it, and sends you to sign in; the sign-in uses PKCE and comes back to g1t with a code, which g1t exchanges for tokens. Tokens are kept sealed and renewed before they expire. A sign-in that takes more than 15 minutes is started again. |
| **Key** | A key an owner pastes, sent as a header (`Authorization` unless the server names another). The key is kept sealed and never shown again. |
| **Open** | The server needs nothing. |

A server that doesn't register clients on its own can't be signed in with
the browser from g1t; when it takes a key instead, add it by address with
a key. A server that answers a sign-in with `401` or `403` is marked, and
the connector asks to be signed in again or for its key to be checked.

#### What each directory server needs

| Sign-in | Servers |
| --- | --- |
| **Browser**, with g1t registering itself as a client | Atlassian, Canva, Cloudflare, Figma, Hugging Face, Intercom, Linear, Neon, Notion, PayPal, PostHog, Sentry, Stripe, Supabase and Vercel |
| **Browser**, but only for apps registered with them | Asana and HubSpot. g1t isn't registered with them yet, so signing in from here fails until it is; their cards say so |
| **Key** | GitHub's MCP server (a personal access token) and Zapier (the token from its MCP settings), each pasted as `Bearer <token>` |
| **Open** | Cloudflare docs, Context7, DeepWiki and Microsoft Learn |

A server that speaks only the older event-stream transport isn't listed
until it serves the current one.

On g1t.sh the sealing key is set. On a g1t you run yourself, the agents
service's `CONNECTORS_KEY` seals connectors' keys and tokens; without it,
open servers work and nothing that signs in can be kept. See
[run g1t yourself](/guides/self-hosting/).

### States

| State | What it means |
| --- | --- |
| **Connected** | Its tools were listed and agents that have it can use them. |
| **Needs sign-in** | A browser sign-in hasn't been done, or was signed out. |
| **Needs a key** | A key hasn't been pasted yet. |
| **Problem** | Its last check or renewal failed; the connector says why. **List its tools again** checks again. |

Only a connected connector reaches agents. One in any other state is
listed, with what it needs, and gives agents nothing until it is fixed.

### Tools and what agents may do with them

When a connector connects, g1t lists the server's tools and keeps the
first 40. Each becomes an ability on every agent that has the connector,
offered as `<connector>__<tool>`, with the arguments the server
describes, under the same [levels](/guides/agent-abilities/#the-levels)
as every ability:

- a tool the server marks read-only is a **read**, Alone by default;
- any other tool, including one the server says nothing about, is a
  **write outside g1t**, Ask first by default: the agent posts a card
  saying what it would do, and waits for Allow or Deny.

A call carries the connector's sign-in. If the sign-in can't be renewed,
the agent is told that an owner needs to sign the connector in again, and
the connector shows **Problem**. Levels, Ask-first cards and the
[audit log](/guides/audit-log/) work exactly as for an agent's own MCP
servers.

### Who gets a connector

A connector reaches agents through **grants**, which work like a skill's
attachments. Open the connector and choose **Give to**:

| Give to | Who gets it | Who can |
| --- | --- | --- |
| Every agent in the workspace | Every agent, `@g1t` included | Owners |
| A team | Every agent on the team | Owners |
| One agent | That agent | Owners |

The same grant twice is one. An agent's **Abilities** tab lists each
connector that reaches it under **Connectors**, with how it has it (every
agent, a team, this agent) and a level for each tool, beside the MCP
servers added to that agent alone, marked **Only this agent**. See
[agent abilities](/guides/agent-abilities/#connectors).

### Manage a connector

On a connector's page, owners can:

- **List its tools again**, to pick up a server that changed, or to check
  one that showed a problem.
- **Sign out** (browser sign-ins): the tokens go, and the connector needs a
  sign-in again. **Replace the key** (keys): the new key is sealed and the
  tools listed again.
- **Take back** a grant, or **Remove** the connector, which removes every
  grant with it. Uninstalling a plugin removes the connectors it brought.

Adding, keying, signing in and out, granting, taking back and removing a
connector are in the audit log under `customize/connectors/<name>`.

## Plugins

A **plugin** is a folder in the open plugin format, listed in a
**marketplace**. Installing one spreads its parts to where g1t's agents use
them, and keeps the rest for Claude Code on a runner.

### Marketplaces

Every workspace starts with three marketplaces, built in, kept current by
g1t and not removable:

| Marketplace | What it lists |
| --- | --- |
| `claude-plugins-official` | Anthropic's reviewed plugins: tools, connectors and skills from Anthropic and the companies behind them. |
| `anthropic-agent-skills` | Anthropic's skills: documents, spreadsheets, presentations, PDFs, design, testing and more. |
| `g1t` | g1t's own plugins: what g1t is building for what a team does besides code (see [what g1t is building](#what-g1t-is-building)). |

Owners add more with **Add a marketplace**, from **Plugins** or
`…/-/customize/marketplaces`, in the forms Claude Code's
`plugin marketplace add` takes:

| Type | Read as |
| --- | --- |
| `owner/repo`, `owner/repo#ref` or `owner/repo@ref` | A public repository on GitHub, or a repository on this g1t when `owner/repo` names one you can read |
| A `github.com` address, with or without `.git` or `/tree/<ref>` | The same repository on GitHub |
| A git address on this g1t | The repository here |
| A link ending in `marketplace.json` | That file alone. Plugins it lists by a relative path can't be reached this way, so add such a marketplace by its repository instead |

The marketplace is named as its `marketplace.json` names itself, unless
you give another name. Names Claude Code keeps for its own marketplaces
(and `g1t`) are refused, so `name@claude-plugins-official` always means
the real thing. A workspace reads at most 20 marketplaces of its own; a
`marketplace.json` is at most 4 MB.

A marketplace's manifest is read when it is added, again when it is older
than six hours and someone opens Discover, and on **Read it again**.
When it can't be read, the marketplace stays listed with the problem, so
it can be read again later. **Remove** takes a marketplace off the
workspace; plugins installed from it stay installed.

### Where plugins come from

Each plugin entry in a marketplace says where its files are (Claude Code's
`source`). g1t reads some of those places and not others:

| Source | On g1t |
| --- | --- |
| A relative path inside the marketplace's repository | Read, when the marketplace is on GitHub or on this g1t |
| `github` (`owner/repo`, with a `ref` or a `sha`) | Read: public repositories, at the commit the ref names |
| `url` or `git-subdir` on github.com or on this g1t | Read |
| `archive` (a zip over HTTPS, with an optional `sha256`) | Read; the checksum is checked when given |
| `npm` | Listed as **Not available here**: g1t doesn't install from npm yet. It still works in Claude Code |
| `command` | Listed as **Not available here**: it is produced by a command on the installing machine, which g1t can't run. It still works in Claude Code |
| A git host other than GitHub or this g1t | Listed as **Not available here** |

Private GitHub repositories aren't read yet. A plugin read here holds at
most 2,000 files and 24 MB together; a file over 2 MB is left out and
named on the plugin's page. Claude Code on a runner fetches the plugin
whole for itself, so nothing is lost there.

### Discover and a plugin's page

**Plugins → Discover** lists every plugin every marketplace lists, by
category, each with its availability:

| Availability | What it means |
| --- | --- |
| **Available** | Installable now. Owners see **Install**; everyone else **Request**. |
| **Installed**, or **Switched off** | The workspace has it. |
| **Not available here** | g1t can't fetch it, with why (above). |
| **Soon** | g1t's own, announced but not released. Nothing can be pressed. |

A plugin's page, `…/-/customize/plugins/<name@marketplace>`, shows its
README, its marketplace and who owns it, its manifest (name, version,
license, repository), and what it brings: skills, agents, commands, MCP
servers, and whether it carries hooks, LSP servers, output styles or
`bin/`. Anything that couldn't be read is listed too.

### Install a plugin

1. Open the plugin's page and choose **Install**. Owners only.
2. g1t fetches the plugin at a **pinned commit**: the commit the
   marketplace's `sha` or `ref` names, or the head it is at now. The
   install remembers that commit; the plugin never changes under you.
3. Each part goes where g1t's agents use it:

| In the plugin | Becomes |
| --- | --- |
| `skills/<name>/SKILL.md` | A library skill, `plugin:name`, read-only, ready to be made available to agents |
| `commands/<name>.md` | A one-file skill, `plugin:name` |
| `agents/<name>.md` | A template under **Agents → Templates → From plugins**, to [hire an agent from](/guides/agents/#role-templates) |
| `.mcp.json` servers of type `http` or `sse` | A connector each, waiting for an owner to sign in or paste a key |
| `.mcp.json` servers of type `stdio` | Marked **Claude Code only**; nothing on g1t's agents |
| `hooks/hooks.json`, `.lsp.json`, `output-styles/`, `bin/` | Kept for Claude Code on a runner, which fetches the plugin whole at the same commit |

The plugin's files aren't copied into g1t beyond its skills and
subagents. A runner fetches them when a job runs (see
[what a run gets](#what-a-run-gets)).

### Switch off, uninstall and update

| | |
| --- | --- |
| **Switch off** | The kill switch. The plugin's skills leave every agent at once, its agents leave Templates, the connectors it brought stop reaching agents, and runners stop getting it. **Switch on** brings them all back. |
| **Uninstall** | Its skills and their attachments go, and the connectors it brought are removed. The record of who installed and removed it stays. |
| **Update** | Shown as **Update available** when its marketplace lists a newer version or commit than the one installed. An install never moves on its own. **Update** reads the plugin again at that commit: its skills get new versions and their attachments follow, skills it no longer has are archived, its agents and connectors are refreshed (a connector it already brought is left as it is), and the install's version and commit move. |

A workspace installs at most 100 plugins. Installing, updating, switching on and
off and uninstalling are in the audit log under
`customize/plugins/<name@marketplace>`, and adding or removing a
marketplace under `customize/marketplaces/<name>`.

### What g1t is building

g1t's own marketplace, `g1t`, is where g1t's own plugins are listed as
they are released. The ones announced are marked **Soon** and can't be
installed until their first release:

| Plugin | What it adds |
| --- | --- |
| **Mail** | Email on your own domain, with shared inboxes agents work in. |
| **Support** | Conversations, escalations, macros and a knowledge base; bug reports become issues in Code. |
| **CRM** | Accounts, deals by stage and a forecast, kept current by agents. |
| **Recruiting** | Openings, candidates, scorecards and interview loops. Agents screen; people decide. |
| **On-call** | Rotations, pages and incidents. |
| **Helpdesk bridge**, **CRM bridge**, **ERP bridge** | Each bridges a system your team already runs, so agents work across it and g1t together. Anything that changes money or stock waits for a person. |

## The formats

g1t reads the files below exactly as Claude Code does, and ignores keys it
doesn't know, so a plugin never needs a g1t version. Paths are inside the
repository or the plugin's folder.

### `.claude-plugin/marketplace.json`

| Key | Required | What it is |
| --- | --- | --- |
| `name` | Yes | The marketplace's name: letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64. Plugins are `name@marketplace` by it. |
| `owner` | Yes | `{ "name", "email", "url" }`, or a name alone. |
| `plugins` | Yes | The plugins it lists (below). An entry that can't be read is noted, not refused, and the others are listed. |
| `description`, `version` | No | Shown on the marketplace. `metadata.description` and `metadata.version` are read too. |
| `metadata.pluginRoot` | No | The folder bare plugin paths resolve under. |

Each entry in `plugins`:

| Key | Required | What it is |
| --- | --- | --- |
| `name` | Yes | The plugin's name, like `pr-review-toolkit`: letters, digits, `.`, `_` and `-`, at most 64. Listed once per marketplace. |
| `source` | Yes | A relative path (`./plugins/pdf`), or an object: `{ "source": "github", "repo", "ref", "sha" }`, `url`, `git-subdir` (`url`, `path`), `archive` (`url`, `sha256`), `npm` (`package`, `version`), `command` (`command`). See [where plugins come from](#where-plugins-come-from). |
| `description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords`, `category`, `tags`, `displayName` | No | Shown on the card and the page. |
| `skills`, `commands`, `agents` | No | Component paths, added to the plugin's standard folders. A skills-only plugin that names its skills here is listed in Discover's Skills without being fetched. |
| `mcpServers` | No | Servers, in `.mcp.json`'s shape, for a plugin without a `plugin.json`. |
| `strict` | No | `false` means the entry names its components outright and the standard folders aren't read, as a marketplace that keeps many plugins in one repository does. |

### `.claude-plugin/plugin.json` and the plugin's layout

`plugin.json` is optional: a folder with the layout alone is a plugin, and
only `name` is required when the file is there.

| Key | What it is |
| --- | --- |
| `name` | The plugin's name, as above. |
| `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords` | Shown on the page. |
| `skills`, `commands`, `agents`, `hooks` | Component paths besides the standard folders (`./` is kept off; `.` is the root). |
| `mcpServers` | Servers inline, in `.mcp.json`'s shape, or a path to a file holding them. |
| `lspServers` | Whether it brings LSP servers (Claude Code only). |

| In the folder | What g1t does with it |
| --- | --- |
| `skills/<name>/SKILL.md` | A skill each |
| `commands/*.md` | A one-file skill each |
| `agents/*.md` | A hireable template each |
| `.mcp.json` | Connectors (remote servers) |
| `hooks/hooks.json`, `.lsp.json`, `output-styles/`, `bin/` | Kept for Claude Code on a runner |
| `README.md` | Shown on the plugin's page |

### `SKILL.md`

The [skill format](/guides/agent-skills/#the-skill-format), unchanged:
YAML front-matter, then the instructions.

| Key | Required | What it is |
| --- | --- | --- |
| `name` | Yes (for a plugin's skill, the folder's name when absent) | The skill's name. |
| `description` | Yes | When to use it, at most 1,024 characters. |
| `license`, `compatibility`, `metadata`, `allowed-tools` | No | Kept as written; change nothing. |
| `tools` | No | g1t's own key: the agent tools the skill uses. |
| `requires_computer` | No | g1t's own key: `true` when the skill needs the agent's own computer. |

### `agents/<name>.md`

A subagent file: front-matter, then the system prompt as the body. Both
`name` and `description` are required, and the body can't be empty.

| Key | What it is | On g1t |
| --- | --- | --- |
| `name` | At most 256 characters, no colon, not starting with a hyphen | The template's name, `plugin:name` |
| `description` | When to use it | The template's description |
| `model` | The model it prefers | Kept with the template, for the agent's model limits |
| `tools`, `disallowedTools` | Claude Code's or MCP tool names, as a list or separated by commas | Kept with the template; g1t's agents use g1t's own tools and abilities |
| `skills`, `mcpServers`, `color` | Skills to preload, servers it uses, its colour | Kept as written |
| The body | The system prompt | The agent's instructions when you hire from it |

### `.mcp.json`

```json
{
  "mcpServers": {
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" },
    "search": { "type": "sse", "url": "https://example.com/sse", "headers": { "Authorization": "Bearer ${SEARCH_KEY}" } },
    "local": { "command": "npx", "args": ["-y", "some-server"] }
  }
}
```

| Server | On g1t |
| --- | --- |
| `type: http` (or `streamable-http`) or `sse`, with a `url` | A connector. One whose `url` or `headers` reference a `${VARIABLE}` asks for a key; one without asks for a browser sign-in. |
| `type: stdio`, or a `command` with no type | Claude Code only. |
| A `url` with no `type` | Noted as a problem: a remote server says its type. |
| `ws`, `sdk` | Not a connector. |

A server's name is letters, digits, dots, underscores and hyphens, at
most 64.

## Requests

Anyone who isn't an owner asks for what they need from the same place an
owner would add it:

1. Choose **Request** on a plugin, a skill from Discover, or a connector.
2. Check what you are asking for: the dialog shows where it comes from and
   that it is available.
3. Say why you want it, if you like (280 characters), and choose
   **Send request**.

Every owner is notified. The button then reads **Requested**, and **Your
requests** lists it until an owner answers; you are notified when one does.
You can't ask twice for the same thing while a request is waiting, and you
can have 20 waiting at once.

Owners answer requests from **Requests** in Customize's header, at
`…/-/customize/requests`, which shows how many are waiting:

| | |
| --- | --- |
| **Install** or **Connect** | Opens where it is added. Installing a plugin, or signing a connector in, answers every request for it by itself. |
| **Mark added** | After you added it another way. |
| **Turn down** | The person who asked is told. They can ask again. |

Answered requests stay listed for 30 days. A request names its listing as
`plugin:<name@marketplace>`, `skill:<name@marketplace>/<skill>`,
`connector:<id>` (from the directory) or `integration:<id>` (one of g1t's
own integrations). When an agent needs a connector or an integration that
isn't connected, it posts a **Request** card in the conversation that
opens the same request (see
[when something is missing](/guides/agent-abilities/#when-something-is-missing)).
Open requests also appear on owners'
[Home](/guides/home/#where-youre-needed).

## What a run gets

When Claude Code runs a job on a [g1t runner](/guides/self-hosted-runners/),
it is given what the workspace customized, as the job's agent would have
it: every installed plugin that is switched on, to fetch at its pinned
commit; the library's own skills that reach the agent, as files; and the
connected connectors that reach it, with what signs them in. The runner
writes the plugins to disk and starts Claude Code with each as a plugin
directory, puts the skills where it reads them, and merges the connectors
into its MCP configuration. See
[what a run gets from Customize](/guides/self-hosted-runners/#what-a-run-gets-from-customize).

Chat replies and [sessions](/guides/agent-sessions/) on g1t get the same
things in their own way: skills through `use_skill`, connectors as
abilities with levels.

## API

Customize is in the REST API under `/workspaces/{workspace}/customize/…`
and in the MCP server as the `customize` tool, one action per thing an
owner does here: marketplaces, Discover, plugins and installs (installing,
switching off, updating and uninstalling), connectors with their keys and
grants. Reading needs `workspace:read`; adding, installing, connecting and
granting need `workspace:admin`, as a person who owns the workspace.
Signing a connector in with OAuth needs a browser, so it stays on the
site. The bundle a runner reads,
`GET /workspaces/{workspace}/customize/bundle`, needs `agents:run` and is
read with a job's agent token, since it carries the connectors' sign-ins.
See the [MCP tools](/reference/mcp/) and the [API reference](/reference/api/).

## Next

- [Agent skills](/guides/agent-skills/): the library, the skill format, versions and the linked repository.
- [Agent abilities](/guides/agent-abilities/): the levels every connector's tools run under.
- [Agents](/guides/agents/): hiring an agent from a plugin's template.
- [Self-hosted runners](/guides/self-hosted-runners/): where what you customize reaches Claude Code.
