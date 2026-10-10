---
title: Marketplace
description: Add functionality to a workspace with extensions, and connect the tools your team already uses so agents can work with that data. Anyone browses the Marketplace; owners add things, and everyone else asks an owner. What each listing may do, where its data goes, and how installs, requests and the kill switch work.
---

The Marketplace is where a workspace adds functionality g1t doesn't have
built in, and connects the data it already keeps elsewhere so agents can
use it. Code, Deployments, Chat, Agents and Artifacts come with every
workspace and aren't listed. Two kinds of listing are:

| Kind | What it adds | Status |
| --- | --- | --- |
| **Extensions** | Pages, data, cards and agent roles for what your team does besides code, such as email on your domain, support or recruiting. Some bridge a system you already run. | Coming: g1t's own are listed, and install from their first release |
| **Integrations** | A connection to a tool you already use, which gives agents new abilities without adding pages. | Live for the integrations marked available; the rest are coming |

Agents aren't in the Marketplace. To add one, start from a
[template](/guides/agents/#role-templates) in Agents.

Open it from **Apps** at the foot of the dock (the launcher's
**Marketplace** link, or **Browse the Marketplace** on the Apps page), from
**More** on a phone, or with <kbd>Ctrl</kbd> <kbd>K</kbd> and
*Marketplace*. Its address is `g1t.sh/<workspace>/-/marketplace`. The
Marketplace isn't in the dock itself.

## Who can add things

Every member of a workspace can browse the Marketplace. Only its
**owners** install extensions and connect integrations, because each of
them can spend the workspace's money or reach its data. Everyone else sees
**Request** where an owner sees **Install** or **Connect**, and asks.

## The Marketplace's pages

| Tab | What it shows |
| --- | --- |
| **Discover** | Featured extensions, integrations with the connected ones first, starter kits, and connected systems. |
| **Extensions** | Every extension listed: published ones first, then g1t's own that are coming, then connected systems, and how extensions are shared. |
| **Integrations** | Connected integrations, the ones you can connect now, the ones each person connects for themselves, and the ones coming. Search by name, by what it does, or by a word such as *tracker*. |
| **Requests** | For owners, every request members made, waiting first; for anyone else, **Your requests**. The tab shows how many are waiting. |

## Extensions

An extension adds pages to its own sidebar, data, cards in chat, tools for
agents and agent roles. g1t's own are listed now, marked **Soon**, so you
can see what each will add and what it will be able to do. None can be
installed before its first release.

| Extension | What it adds |
| --- | --- |
| **Mail** | Email on your own domain, run by g1t. Shared inboxes such as support@ work like channels: agents sort and draft, and sending needs approval or a rule you set. |
| **Support** | Conversations, escalations, macros and a knowledge base. Customer cards in chat, and bug reports become issues in Code. |
| **CRM** | Accounts, deals by stage and a forecast. Agents log calls and draft follow-ups for a person to send. |
| **Recruiting** | Openings, candidates, scorecards and interview loops. Agents screen; people decide. |
| **On-call** | Rotations, pages and incidents, with who is on call now. |

### Connected systems

A connected system is an extension that bridges a system your team already
runs, so agents work across it and g1t together. Its page says *Data leaves
g1t to* the system you connect.

| Extension | What it bridges |
| --- | --- |
| **Helpdesk bridge** | Tickets from your helpdesk, with replies drafted for a person to send and bug reports linked to issues in Code. |
| **CRM bridge** | Accounts and deals from your CRM, in g1t and in chat. |
| **ERP bridge** | Orders, invoices and stock from your ERP. Anything that changes money or stock waits for a person's approval. |

### Starter kits

A starter kit is a set of extensions for one kind of team, installed
together once each of them is published: **Customer team** (Mail, Support,
CRM), **Engineering extras** (On-call, Helpdesk bridge) and **People and
operations** (Recruiting, ERP bridge). They are on **Discover**, marked
**Soon** until then.

### Who stands behind a listing

| Tier | Who | |
| --- | --- | --- |
| **Official** | g1t | Built and supported by g1t. |
| **Verified** | A reviewed publisher | Code and permissions are checked before it is listed. |
| **Community** | Anyone | Shared from a public repository. Pages run sandboxed; server code runs on the publisher's own servers until hosted code has an isolated sandbox. |
| **Internal** | Your workspace | Built by your own people and agents, seen only by your workspace. |

### What an extension's page tells you

Before anything is installed, its page lists:

- **What it adds**: its pages, the cards it shows in chat, the agent roles
  it brings, the tools agents get, and the notifications it sends.
- **It will be able to**: what it may do, in plain words, and the scopes
  its token asks for, each described.
- **Where it runs, and where data goes**: on g1t, or on its publisher's
  servers, and everywhere outside g1t its data goes, as *Data leaves g1t to
  api.example.com*, or *to the CRM you connect* for a connected system.
  *Its data stays in g1t* means it sends nothing elsewhere.
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
| `bridges` | Optional. The system it connects to, in words, such as `the CRM you connect`, when its data goes wherever the workspace points it. |
| `ui.entry` | Its page, loaded in a sandboxed frame from the user-content domain, which reaches g1t only through what it was allowed. |
| `adds` | Its `pages`, `cards`, `agent_roles`, `tools` and `notifications`. |
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

## Integrations

Integrations are how agents reach your data: each one says, in plain words,
what it lets agents do, such as *Agents can read* or *Opens issues*. The
Marketplace lists every integration in the
[integrations directory](/guides/integrations/) that a workspace can
connect, with whether yours has. **Connect** opens its setup page;
**Manage** opens it once it is connected. **Needs attention** means a
connection's last check failed: hover it to see why.

Some integrations each person connects for themselves, such as a GitHub
account or an MCP client. They are listed under **Connected by each
person**, and **Connect yours** opens your own
[settings](/guides/integrations/#workspace-and-personal) for them. Agents
use a personal connection only when that person asks. Those that aren't
available yet, such as a calendar or a mailbox, are listed among the
coming ones.

## Ask an owner to add something

1. Choose **Request** on an extension or an integration.
2. Say why you want it, if you like, and choose **Send request**.

Every owner is notified. The button then reads **Requested**, and **Your
requests** lists it until an owner answers; you are notified when one does.
You can't ask twice for the same thing while a request is waiting, and you
can have 20 waiting at once.

To answer requests as an owner, open **Marketplace → Requests**:

| | |
| --- | --- |
| **Install** or **Connect** | Opens where it is added. Installing an extension answers every request for it by itself. |
| **Mark added** | After you connected the integration, or added it another way. |
| **Turn down** | The person who asked is told. They can ask again. |

Answered requests stay listed for 30 days.

## Apps

What the workspace added from the Marketplace that you can use is under
**Apps**: today, the integrations it connected. Pin the ones you want to
your dock. See [Apps](/guides/workspaces/#apps).
