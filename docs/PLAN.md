# g1t plan

g1t runs your company: people and agents in teams, a forge where agents
build, and everything else you install.

Open g1t on the web, your desktop or your phone, and you're in your
company's workspace. People and agents work side by side in channels, DMs
and teams, and some teams are only agents. Hand work to an agent and it
does it on a runner, with the skills it came with and the ones you've
added. It comes back with something you can act on: a pull request to
merge, a report, an email to approve. Today says what happened and what's
waiting. Notifications collect everything waiting on you. Code and
Deployments are built in, because agents build things. Anyone can build a
tool, a report or an agent in a scratchpad without risking production.
Everything specific to a business is an extension or an integration from
the marketplace. g1t can be a whole company, or work alongside the tools a
company already has. It's MIT-licensed: run it yourself, let us run it, or
split it.

This file is the plan of record. The docs at `apps/docs` describe what
works; this says what g1t is becoming and in what order.

## Where things stand

g1t is in alpha. Every feature carries one label, here, in the README and
in the docs:

| Label | Means |
| --- | --- |
| **Live** | Works on g1t.sh for every workspace. |
| **Preview** | Works on g1t.sh, but is limited to some workspaces or unfinished. Its guide says how. |
| **Coming** | Planned, not built. No page promises it works. |

A label moves from Coming to Preview to Live in the same change that makes
it true, with the docs. User-facing text never describes how a feature
used to work.

## The shape

| Layer | What's in it |
| --- | --- |
| Surfaces | g1t.sh on the web, the desktop app, the phone app, MCP at `mcp.g1t.sh`, Slack and Teams |
| Built in | Today, Chat and Notifications, People and teams, Agents and `@g1t`, Artifacts, **Code**, **Deployments**, Spend, Identity and SSO |
| Extension contract | Installs and scopes (OAuth 2.1 apps), UI slots served from g1tusercontent.com, tools (MCP), events and webhooks, workspace data, agent roles and skills |
| Extensions | Official, verified, community, and internal (promoted scratchpads) |
| Runs on | Runners (g1t cloud, the runner binary anywhere, the desktop app), the model gateway (at cost, your keys, local models), storage (D1 and R2, or SQLite and S3-compatible self-hosted) |

Built in means it ships with every workspace and the core depends on it.
Everything else is an extension, including what g1t itself builds for
support, recruiting, on-call or mail.

## The shell

Three surfaces that never blur together:

- **The dock**: a floating, rounded bar down the left, with the g1t mark
  at its top. Built-in items below it (Today, Chat, Notifications, Agents, Code, Artifacts), then only
  the apps this person pinned, then the **Apps** launcher. Its foot holds
  People, Workspace and the account menu, which also holds help, docs,
  shortcuts and your profile. The dock is per person: nobody sees an app
  they can't use.
- **The in-context sidebar**: flat, on the background, belonging to the
  current app. Its top row is the workspace: its logo, its name and the
  switcher, with the collapse toggle beside them (Ctrl B). Where there is
  no sidebar, or it is collapsed, the workspace's logo and name lead the
  page header's breadcrumbs instead, so the g1t mark and the workspace's
  logo are always both on screen.
- **The page**: a rounded inset panel, always the brightest surface, with a
  full-width header (sidebar toggle, breadcrumbs, search, actions).

Today is the front page and has no sidebar. On phones and narrow browsers
the dock becomes a bottom bar (Today, Chat, Notifications, Agents, Code,
More); More opens a sheet with all apps, the Marketplace, pinned apps,
People, Workspace and you; the sidebar becomes a drawer.

The **Apps launcher** lists every app installed in the workspace that you
can use, with search and a pin on each, and links to the Apps page and the
Marketplace. Apps you lack access to show Request access. Anyone can
browse the Marketplace; owners install; everyone else sends a request,
which reaches an owner in Notifications.

**Auth pages stand alone**: sign-in, sign-up, two-factor, password reset,
email confirmation, invites, device and OAuth consent, and choosing or
creating a workspace render with no dock, sidebar or header: the logo, a
centred form and a footer of links. A signed-in person always sees the
full app inside a workspace, including on public pages. A signed-out
visitor on a public page sees a small public header.

Workspace settings drop the second sidebar for a row of tabs and a
settings search, with forms in a centred column.

## Built in

### Today

With a fleet working all day, the first screen is a summary, not a chat.
Today leads with one sentence about the day and one button for what's
waiting. Then how much agent work was accepted the first time, with a
strip where every mark is one of today's tasks; Needs attention, each row
with what's at stake and its action; spend today, split the way it's
billed; and one item g1t picked as the place to start, by a rule the guide
states. Every number comes from a service; a section with no data says so.

| Part | Status |
| --- | --- |
| The page, Ask g1t, Needs attention (Code, agents, notifications, chat), Start here | Preview |
| Accepted first time and the task strip, from agents' pull requests and `revise` runs | Preview |
| Spend today from the day's statement (UTC days) | Preview |
| Work by source: Chat, Code, schedules, other agents | Preview |
| Accepted or fixed for agent sessions (needs a review signal on a session) | Coming |
| A per-pull-request outcome (changes requested, first pass) and `since` filters on sessions and runs | Coming |
| Spend by day in the viewer's time zone; due dates on needs | Coming |

### Chat and Notifications

Channels, DMs and threads with people and agents as members. Mention an
agent, or hand it work with `hand_off`, and progress shows in the channel
and in Agents; the result comes back as a card you can act on (a pull
request with Merge, a doc with Publish, an email with Approve). Outside
email, production deploys and spend over budget wait for a person, in the
card and in Notifications.

| Part | Status |
| --- | --- |
| Channels, DMs, threads, mentions, rich text, live sockets, presence | Live |
| Agents as members, `hand_off`, cards | Live |
| Notifications feed, counts, browser push | Live |
| Cards from extensions | Coming |
| Push to the desktop and phone apps | Coming |
| Agents answering in Slack and Teams | Coming |

### Agents: one or forty

A workspace can run on `@g1t` alone, the general agent that does
everything. As work grows it hires specialists from the catalog. Each
brings a role, skills, the tools it needs and a runner preference. `@g1t`
knows all of them: ask it anything and it answers or brings in the right
agent, and you stay in the conversation.

| Part | Status |
| --- | --- |
| Definitions: role, responsibilities, voice, model routing, budget, autonomy | Live |
| Templates to hire from (7) | Live |
| `@g1t` orchestrator, DMs with any agent, `hand_off` | Live |
| Memory at project and workspace level; sessions with live steps and cost; routines | Live |
| Your own model providers (14), the AI Gateway | Live |
| g1t's hosted models: open where billing is live or the workspace is listed in `HOSTED_AGENT_WORKSPACES` | Preview |
| The catalog (about 40 specialists), installed like extensions | Coming |
| Foundational skills in every agent: documents, research and the web, data, code, communication, files and media | Coming |
| Memory editor; skills proposed from finished work, published after review | Coming |
| Effort per agent (auto to max) | Coming |

Skills never add permissions: a skill uses only tools the agent already
has. Agents act with the lower of their own access and the asker's.

### People and teams

People sits in the dock's foot, because knowing who does what is how work
gets routed. Teams can be mixed, people only or agents only. A team has a
lead, a channel, a Code role, a storage level and a budget, inherited by
everyone on it, and its agents know their teammates from the team page.

| Part | Status |
| --- | --- |
| Members, roles, nested teams, invites, teams with Code roles | Live |
| Directory of people and agents, profiles, reporting lines, local time | Coming |
| Agent members of teams, all-agent teams, inherited policy | Coming |
| Org chart | Coming |

### Runners

Every agent's machine is a g1t runner: one binary for Linux, macOS and
Windows on x64 and arm64 that registers with a one-time token, installs
itself as a service and only connects out. Use g1t's cloud runners (scale
to zero, billed by the minute), run the binary anywhere (time on it is
free), or let the desktop app act as a runner for tasks that need your
computer, asking before each one.

| Part | Status |
| --- | --- |
| Self-hosted runners for workflow jobs; g1t's sandboxes for agents, checks and the merge queue | Live |
| Agents on any runner, by labels and per-agent routing rules | Coming |
| Sessions that persist on the runner between tasks; an official agent image | Coming |
| A runner inside the desktop app | Coming |

### Code and Deployments

Everything an agent makes ends up as code that has to be reviewed, tested
and shipped, so Code and Deployments come with every workspace. It runs on
Cloudflare: previews scale to zero, Workers have no cold starts, and
container apps can be set to always on.

| Part | Status |
| --- | --- |
| Repositories, git over HTTPS, issues, pull requests, reviews, why-blame | Live |
| Checks, rulesets, CODEOWNERS, the merge queue, catch-up | Live |
| Workflows from `.g1t/workflows` | Live |
| Packages: seven registries and container images | Live |
| Security: push protection, history scanning, dependency updates | Live |
| GitHub import, mirroring, pushing back | Live |
| A preview per pull request on g1t.page, production on merge, custom domains | Live |
| g1t's agents on issues, outcomes planned into issues | Preview (hosted agents) |
| Each preview with its own fork of the data | Coming |
| Instant rollback, request logs, analytics per environment | Coming |
| Framework detection; scale to zero or always on for containers | Coming |
| Comments on previews that land on the pull request | Coming |
| Git over SSH (needs inbound TCP on Workers) | Coming |

**Code access.** Every workspace has Code, but not everyone has to see it:
five repository roles, a base permission that can be None, teams, outside
collaborators and a per-member switch that removes Code are live. A
workspace setting that makes Code invite-only is Coming.

**A finding that changes Deployments.** Workers previews share the same
database and bucket unless each is bound to its own, so a preview would
read and write production data. Every preview, scratchpad and agent test
gets its own fork instead (see Storage).

### Artifacts

Things people and agents make together: documents now; slides, designs and
dashboards next; types registered by extensions later. Artifacts open in a
panel beside any chat.

| Part | Status |
| --- | --- |
| Documents: spaces, sharing, live editing, the artifact MCP tool, REST and scopes | Live |
| Slides, designs, dashboards (contracts exist) | Coming |
| Reports that keep the query and refresh time behind every number | Coming |
| Types from extensions | Coming |

The service is `services/docs` today and becomes `services/artifacts`,
with a doc as one type. The Cloudflare git-store binding and workflow-run
artifacts get names that don't collide. That rename touches Cloudflare
resources, so it waits for an owner's go-ahead.

### Scratchpads

A tool, a report or an agent you get by asking. Each has its own
repository in Code, its own fork of the data it needs, a small budget and
hard limits: production is read-only, no customer messages, no money
moving. When it's useful you ask for a review, which shows the code, the
data it touches and the permissions it wants in one diff. After approval
it becomes an internal extension. Status: Coming.

### Storage

Each team gets a level, and everything below production is a fork.

| Level | What a team and its agents can do |
| --- | --- |
| Locked | Read-only views of production data. Reports only. |
| Sandboxed | Masked forks of production, deleted after 14 days unless kept. |
| Builders | Create databases and buckets for development. Production changes go through review. |
| Full | Change production, with approval for anything destructive and an undo window. |

D1 has no branching and R2 no bucket fork, so g1t builds forks itself:
export, mask personal data and import into a new database per sandbox; a
prefix per sandbox that reads from production and writes only its own
copy. Neon is the first Postgres option, for its native branches. Promotion
works like a deploy request: a schema and data-access diff, checks for
conflicts and data loss, required approval, then an undo window. Status:
Coming.

### Spend

| Part | Status |
| --- | --- |
| No seats; compute at cost plus 20%; agent runs at the model's price plus a flat agent rate | Live |
| Budgets per workspace, agent and task; guardrails; spend limits; itemised invoices | Live |
| Models at the provider's price with no markup; everything g1t runs at cost plus 20%; own runners, keys and local models free | Coming |
| Budgets per person and per team; at a limit an agent asks, switches to a cheaper model, or pauses | Coming |
| Task receipts; spend by agent, person, extension, channel or model | Coming |
| A spend pill in the header: your own spend, or the workspace's for owners and billing admins | Coming |
| Recommendations checked against past work ("same verdict on 39 of 40 reviews at medium") | Coming |

Any change to prices or to how billing charges waits for an owner's
go-ahead.

### Workspaces and sign-in

In the cloud you sign in once and pick a workspace at `g1t.sh/<name>`.
Self-hosted, the instance runs one workspace or many. Everything inside a
workspace belongs to its owners: OIDC or SAML, verified domains, SCIM,
extensions, agents and models.

| Part | Status |
| --- | --- |
| Accounts by invite, two-factor, access tokens (including use on the website), OAuth 2.1 apps with dynamic registration, device sign-in | Live |
| Workspaces, roles, billing managers, the audit log | Live |
| SAML and OIDC per workspace, SCIM, passkeys | Coming |
| Self-hosted: one or many workspaces, chosen at setup | Coming |

## Extend

**Integrations add abilities. Extensions add pages.** An integration
connects something a company already uses (Drive, Gmail, Slack,
Salesforce) and gives agents new abilities without adding pages. An
extension brings its own pages, data, cards, agent roles and skills, and
can join several systems together.

| Part | Status |
| --- | --- |
| Integrations: the GitHub App, Sentry, Datadog, Jira, Linear, alerts | Live |
| The contract underneath: OAuth apps, 43 scopes, signed webhooks with retries, the event bus, MCP | Live |
| Drive, Gmail, Calendar, Slack, Microsoft 365, each listing the abilities it gives agents | Coming |
| The Marketplace, the Apps launcher's install flow, install requests to owners | Coming |
| Mail: email on your own domain, shared inboxes agents work in, run by g1t | Coming |
| Official extensions: Support, Recruiting, On-call | Coming |

Decided for extensions:

- **Two kinds launch together.** "Runs on g1t" extensions are hosted by
  us. "Connected" extensions run on the publisher's own servers, with
  declared domains, an install screen that says "Data leaves g1t to
  acme.dev" and lists which data, UI in a sandboxed frame from the declared
  domain, every call in the audit log, a budget and rate limit per install,
  health checks, and a kill switch for the workspace and for us.
- **Shared like Actions.** An extension is a public repository on g1t with
  a manifest. Tagging a release publishes it; its README is the listing.
  Installs pin a version; updates are offered, never forced.
- **Free at launch, ready for paid.** Listings carry an empty pricing
  field and installs record a plan, so paid listings later are billing
  work, not a schema change.
- **Community server code waits for the sandbox**: its own dispatch
  namespace on the Workers for Platforms setup Deployments already uses,
  an outbound Worker that enforces declared domains, CPU and subrequest
  limits, and no bindings except the g1t API. Self-hosted, workerd
  isolates. Until then community extensions publish UI, tools and
  Connected backends.
- **UI first.** Extensions, agents and settings are configured in the
  product. A file in a repository is an optional mirror, kept in sync.

## Everywhere

g1t ships as three apps that behave as one. The desktop app is where you
sit with the work: a global shortcut for a quick ask, the menu bar showing
who's working, and a runner an agent can use with permission per task. The
phone app is where you run the fleet: who's working, approvals with Face ID
or a fingerprint, delegation by voice, task progress on the lock screen.
Drafts, unread state and approvals sync; an approval taken on one device
disappears from the others.

- **Desktop: Tauri 2.** It links `crates/runner` directly, shows the web
  app in a native window, and gets tray, shortcuts, notifications, deep
  links and auto-update from plugins. CI renders on WebKit, WebView2 and
  WebKitGTK. It uses the existing `window.g1tDesktop` bridge.
- **Phone: Expo.** Native screens, one TypeScript codebase sharing
  `packages/contracts`, push, biometrics, secure storage and over-the-air
  updates. Lock-screen progress and widgets are small Swift and Kotlin
  modules through the Expo Modules API.
- Self-hosted servers send phone push through a g1t relay with end-to-end
  encrypted payloads: the one piece a self-hoster can't run, a toggle in
  "Who runs what".

Status: Coming.

## Run it your way

The whole product is MIT-licensed and, as the goal, fully featured
self-hosted: Docker, or the customer's own Cloudflare account, where it
runs as g1t.sh does. Each part is "yours or ours" as a setting: runners,
the model gateway, storage, phone push. Self-hosted with our gateway or
runners costs the same as the cloud; fully self-hosted, we earn nothing.

| Part | Status |
| --- | --- |
| The core forge in Docker Compose (`deploy/self-host`): repositories, push and clone, issues, pull requests, the API and MCP | Preview |
| Agents through runners rather than in-server sandboxes | Coming |
| Search, context and deployments self-hosted | Coming |
| Setup in the browser, one workspace or many, "Who runs what" settings | Coming |
| Deploy to your own Cloudflare account in one step | Coming |

Self-hosting never makes the cloud worse: every Cloudflare-only binding
sits behind an adapter, with the hosted path unchanged. The inventory and
design are in [SELF_HOSTING.md](SELF_HOSTING.md).

## Architecture

| Component | Language | Responsibility |
| --- | --- | --- |
| `crates/contracts`, `packages/contracts` | Rust, TypeScript | Every service's interface, the event catalogue, shared types. Services depend on these, never on each other's code. |
| `services/identity` | Rust | Accounts, workspaces, roles, teams, sessions, tokens, OAuth apps |
| `services/repos` | Rust | Repository registry, contents, forks, diffs, landing, git over HTTPS |
| `services/work` | Rust | Issues, pull requests, reviews, check runs, sessions |
| `services/events` | Rust | The event bus and its log |
| `services/billing` | Rust | Usage, the price book, limits, budgets, invoices, payments |
| `services/actions` | Rust | Workflows, runs, caches, self-hosted runners |
| `services/security`, `services/packages`, `services/search`, `services/integrations`, `services/webhooks` | Rust | What their names say |
| `services/chat`, `services/notify` | TypeScript | Chat and its sockets; Notifications, counts and push |
| `services/agents` | TypeScript | Agent definitions, templates, desks, memory, routines, runs |
| `services/docs` | TypeScript | Artifacts (becomes `services/artifacts`) |
| `services/runner`, `crates/runner` | TypeScript, Rust | Sandboxes; the runner binary |
| `services/projects`, `services/deployments`, `services/pages` | TypeScript | Projects, builds and previews, serving g1t.page |
| `services/models`, `services/context`, `services/og` | TypeScript | The model proxy, the context hub, social cards |
| `apps/web`, `apps/docs`, `apps/api`, `apps/status`, `apps/sudo` | TypeScript, Rust | The site, the docs, REST and MCP, the status page, staff tools |

How they fit:

- **Each service is its own Worker with its own database.** Callers reach
  it through a typed RPC binding to its interface in the contracts.
- **Expected failures are values.** Every call returns a `Result`.
- **Side effects travel as events.** A service publishes what happened and
  doesn't call others to react; each subscriber has its own queue.
- **Every read takes the viewer.** The service that owns the data decides
  who may see it.
- **APIs are snake_case** in request and response bodies, webhooks and MCP
  results, converted at the edge.
- **Ids are TypeIDs**: a prefix naming the kind of thing, then a UUIDv7 in
  lowercase base32, made by the service that creates the record.

Domains: g1t.sh for the app, API and MCP; g1t.page for deployments and
hosted scratchpads; g1tusercontent.com for uploads, raw files, avatars and
extension UI; models.g1t.sh for the gateway.

The new pieces land here:

| Workstream | Where the work lands |
| --- | --- |
| Shell: dock, sidebar, panel, Today, Notifications, phone bar, standalone auth | `apps/web` (`components/rail.tsx`, `shell.tsx`, `mobile.tsx`, `lib/workspace-nav.ts`) |
| Marketplace and installs | New `services/extensions`; contracts in `packages/contracts` and `crates/contracts`; builds on OAuth apps in `services/identity` |
| Agent catalog and hiring | `services/agents` (`templates.ts`, `definition.ts`) |
| Spend | `services/billing` (`budget.rs`), `services/models` (effort per agent) |
| Runners as agent machines | `crates/runner` (`harness.rs`, resume), `services/runner`, the agent image |
| Extension UI slots | The `apps/web` shell, plus a bridge for frames on g1tusercontent.com |
| SSO and SCIM; teams with agent members | `services/identity` |
| Artifact types, reports | `services/docs`, renamed `services/artifacts` |
| Storage forks and masking | New `services/storage` (D1 export, mask and import; R2 prefixes; Neon branches) |
| Scratchpads | `services/repos` and `services/work`: a repository per scratchpad, review as a pull request with a data and permissions diff |
| Agent builder and tests | `services/agents`: instructions, per-tool limits, test runs on forks, required review |
| Mail | New `services/mail` |
| Integrations | `services/integrations` |
| Desktop app | New `apps/desktop` (Tauri, bundles the runner) |
| Phone app | New `apps/mobile` (Expo) |
| Docs | `apps/docs`, in the same change as each feature |

## Build order

Each stage leaves g1t.sh working.

1. **Alpha.** The docs, README and site describe g1t as this product with
   every feature labelled. The shell: dock, in-context sidebar, page panel,
   Today, Notifications, the phone bar and More sheet, standalone auth
   pages. Code with Deployments and Packages in its sidebar. The Apps page
   and launcher over what's installed. Then the Marketplace page with
   today's connectors as official listings, the agent catalog from the
   templates with hiring, the Spend page over billing, and a Runners page
   over self-hosted runners.
2. **Launch.** Install records, the install screen, UI slots on
   g1tusercontent.com and the builder; Support, Recruiting and On-call as
   the first official extensions; persistent agent sessions and the agent
   image; SAML, OIDC and SCIM; the desktop and phone apps; the memory
   editor, learning with review, slides and dashboards; storage forks;
   pricing at cost plus 20% with models at provider price.
3. **Next.** Verified publishers, then community extensions; workspace
   data collections and database bridges; scratchpads promoted to
   extensions; self-hosting with agents, deployments and search; agents in
   Slack and Teams.
4. **Later.** Revenue share for publishers; agents with their own email
   addresses and phone numbers; hand-offs across workspaces; confidential
   runners for regulated teams.

## Decisions

- **MIT, all of it.** Open source and self-hostable, or we run it.
- **g1t is the name.** Code and Deployments are built in; everything else
  is an extension. Flagon, Inc. makes it.
- **Code access is configurable**: open, invite-only or read-only, on the
  roles that exist plus an invite-only switch.
- **Agents work on runners**: g1t cloud, the binary anywhere, or the
  desktop app.
- **Self-hosting is fully featured and hybrid**: every part can be yours or
  ours.
- **Tauri 2 for desktop, Expo for phones.**
- **Pricing**: models at provider price, everything g1t runs at cost plus
  20%, no seats, own runners, keys and local models free.
- **Notifications** is the built-in place for what's waiting on you;
  **Mail** is an official extension.
- **People and teams are front and centre**, and agents know their
  teammates.
- **Every agent ships with foundational skills.**
- **Connected extensions at launch**, shared like Actions, free, ready for
  paid, with a sandbox for community server code later.
- **The dock is per person and its own surface**; the Marketplace isn't in
  it.
- **Auth pages stand alone**, and the full app is always inside a
  workspace.
- **Before anything risky, ask**: deploys, migrations on live data,
  renames that touch Cloudflare resources, and anything that changes
  billing.

Open:

- How the agent catalog is curated and versioned once publishers can add
  agents.
- Which official extensions follow Support, Recruiting and On-call.
- The phone push relay's pricing for self-hosters.
