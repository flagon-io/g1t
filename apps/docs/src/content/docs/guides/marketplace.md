---
title: Marketplace
description: Add agents, integrations and extensions to a workspace. Anyone browses the Marketplace; owners add things, and everyone else asks an owner. What each listing may do, where its data goes, and how installs, requests and the kill switch work.
---

The Marketplace is where a workspace adds what isn't built in. Code,
Deployments, Chat, Agents and Artifacts come with every workspace; the
Marketplace lists what you can add to them:

| Kind | What it adds | Status |
| --- | --- | --- |
| **Agents** | An agent hired into a role from the agent catalog. | Live |
| **Integrations** | A connection to a tool you already use, which gives agents new abilities without adding pages. | Live for the integrations marked available; the rest are coming |
| **Extensions** | Pages, data, cards and agent roles for what your team does besides code. | Coming: g1t's own are listed, and install from their first release |

Open it from **Apps** at the foot of the dock (the launcher's
**Marketplace** link, or **Browse the Marketplace** on the Apps page), from
**More** on a phone, or with <kbd>Ctrl</kbd> <kbd>K</kbd> and
*Marketplace*. Its address is `g1t.sh/<workspace>/-/marketplace`. The
Marketplace isn't in the dock itself.

## Who can add things

Every member of a workspace can browse the Marketplace. Only its
**owners** add agents, connect integrations and install extensions,
because each of them can spend the workspace's money or reach its data.
Everyone else sees **Request** where an owner sees **Add**, and asks.

## The Marketplace's pages

| Tab | What it shows |
| --- | --- |
| **Discover** | What every workspace has, a few roles from the agent catalog with `@g1t` first, integrations with the connected ones first, and extensions. |
| **Agents** | The agent catalog: every role, by department, with who in the workspace has the job. |
| **Integrations** | Connected integrations, the ones you can connect now, and the ones coming. Search by name, by what it does, or by a word such as *tracker*. |
| **Extensions** | Every extension listed, published ones first, and how extensions are shared. |
| **Requests** | For owners, every request members made, waiting first; for anyone else, **Your requests**. The tab shows how many are waiting. |

## The agent catalog

Each role in the catalog is a starting point for an agent: a name it
suggests, a title, responsibilities, a voice, model limits and the helpers
it works with. [Role templates](/guides/agents/#role-templates) lists them.
Choose a role to see all of it, including the instructions it starts from
and who in the workspace was already hired into it.

To add an agent from the catalog as an owner:

1. Open **Marketplace → Agents**, or `g1t.sh/<workspace>/-/marketplace/agents`.
2. Choose **Add to workspace** on the role (**Add another** when someone
   already has the job).
3. Finish the new-agent form, which opens with the role chosen, and choose
   **Create agent**. See [Hire an agent](/guides/agents/#hire-an-agent).

Adding an agent from a role answers every open request for that role: each
person who asked hears that it was added.

## Integrations

The Marketplace lists every integration in the
[integrations directory](/guides/integrations/) that a workspace can
connect, with whether yours has. **Connect** opens its setup page;
**Manage** opens it once it is connected. **Needs attention** means a
connection's last check failed: hover it to see why.

Integrations each person connects for themselves, such as a calendar or a
mailbox, are listed among the coming ones; they are set up in your own
[settings](/guides/integrations/#workspace-and-personal) once available.

## Extensions

An extension adds pages to its own sidebar, data, cards in chat, tools for
agents and agent roles. g1t's own are listed now, marked **Soon**, so you
can see what each will add and what it will be able to do: **Support**,
**Recruiting**, **Mail** and **On-call**. None can be installed before its
first release.

### Who stands behind a listing

| Tier | Who | |
| --- | --- | --- |
| **Official** | g1t | Built and supported by g1t. |
| **Verified** | A reviewed publisher | Code and permissions are checked before it is listed. |
| **Community** | Anyone | Shared from a public repository. Pages run sandboxed; server code runs on the publisher's own servers until hosted code has an isolated sandbox. |
| **Internal** | Your workspace | Built by your own people and agents, seen only by your workspace. |

### What an extension's page tells you

Before anything is installed, its page lists:

- **What it adds**: its pages, the agent roles it brings, the tools agents
  get, and the notifications it sends.
- **It will be able to**: what it may do, in plain words, and the scopes
  its token asks for, each described.
- **Where it runs, and where data goes**: on g1t, or on its publisher's
  servers, and every domain outside g1t its data goes to, as *Data leaves
  g1t to api.example.com*. *Its data stays in g1t* means it sends nothing
  elsewhere.
- **Version** and **Source**: the release it installs, and the repository
  and tag it was published from.
- **Price**: every listing is free. What its agents do is billed at what
  it costs, like any agent's work.

### How extensions are shared

An extension is a public repository on g1t with a manifest,
`.g1t/extension.json`. Tagging a release (`v1.2.0`) publishes that version.
An install keeps the version it was installed at; updates are offered to
owners, never forced.

| Manifest field | What it says |
| --- | --- |
| `id`, `name`, `tagline`, `description`, `category` | What it is called and what it does. |
| `publisher` | Who publishes it, and its tier. |
| `runtime` | `hosted` (runs on g1t) or `connected` (runs on the publisher's servers). |
| `scopes` | The [scopes](/guides/authentication/#scopes) its token asks for. |
| `permissions` | What it may do, in plain words, for the install screen. |
| `domains` | Every host outside g1t its data goes to. A connected extension must name the ones it runs on. |
| `ui.entry` | Its page, loaded in a sandboxed frame from the user-content domain, which reaches g1t only through what it was allowed. |
| `adds` | Its `pages`, `agent_roles`, `tools` and `notifications`. |
| `pricing` | `null`: listings are free. |

### Installed extensions

Once installed, an owner can, from the extension's page:

- **Switch off**: the kill switch. Its token stops working and its page
  stops loading at once, until it is switched on again.
- Cap what it spends in a month. Without a cap, the workspace's
  [spend limit](/guides/usage-and-billing/) applies.
- **Uninstall** it. The record of who installed and removed it stays.

Installing, switching on or off, setting a budget and uninstalling are in
the [audit log](/guides/audit-log/).

## Ask an owner to add something

1. Choose **Request** on an agent, an integration or an extension.
2. Say why you want it, if you like, and choose **Send request**.

Every owner is notified. The button then reads **Requested**, and **Your
requests** lists it until an owner answers; you are notified when one does.
You can't ask twice for the same thing while a request is waiting, and you
can have 20 waiting at once.

To answer requests as an owner, open **Marketplace → Requests**:

| | |
| --- | --- |
| **Add**, **Connect** or **Install** | Opens where it is added. Adding an agent from its role answers every request for that role by itself. |
| **Mark added** | After you connected the integration, or added it another way. |
| **Turn down** | The person who asked is told. They can ask again. |

Answered requests stay listed for 30 days.

## Apps

What the workspace added from the Marketplace that you can use is under
**Apps**: today, the integrations it connected. Pin the ones you want to
your dock. See [Apps](/guides/workspaces/#apps).
