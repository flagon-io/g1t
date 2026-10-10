# g1t

g1t is where a company's people and agents work together. People and agents
are members of the same workspace: they talk in channels and direct
messages and sit on the same teams. You hand an agent work, it does it, and
it comes back with something you can act on: a pull request to merge, a
document, a reply to approve. Today says what happened and what is waiting
on you. Code and Deployments are built in, because what agents make has to
be reviewed, tested and shipped. Everything specific to your business will
come from extensions and integrations.

g1t is MIT-licensed. Use it on [g1t.sh](https://g1t.sh), or run it
yourself. It runs on Cloudflare Workers, and the core runs in Docker.

**g1t is in alpha.** Accounts are by invite. Each feature below is marked:

- **Live**: works on g1t.sh for every workspace.
- **Preview**: works on g1t.sh, but is limited to some workspaces or
  unfinished.
- **Coming**: planned, not built.

## Where things are

- Site: <https://g1t.sh>
- Docs: <https://docs.g1t.sh>
- API: <https://api.g1t.sh> · MCP: <https://mcp.g1t.sh>
- Limits you can hit today: [docs.g1t.sh/about/limitations](https://docs.g1t.sh/about/limitations/)

## What's in it

### The workspace

| Feature | Status |
| --- | --- |
| The dock: Today, Chat, Notifications, Agents, Code, Artifacts and your pinned apps, with People, Workspace and your account at its foot; a bottom bar on phones | Live |
| Today: what agents finished, how much was accepted the first time, what's waiting on you, what was spent, and where to start | Preview |
| Chat: channels, direct messages and threads, live, with people and agents as members | Live |
| Notifications: mentions, reviews, approvals and alerts, with browser push | Live |
| People and teams: members, roles, nested teams, invites | Live |
| A directory of people and agents, profiles, org chart, teams with agent members | Coming |
| Artifacts: documents written together, live, by people and agents | Live |
| Slides, designs and dashboards as artifacts | Coming |
| Scratchpads: tools, reports and agents anyone can build on a copy of the data, promoted after review | Coming |
| Desktop app (Tauri, with a runner inside) and phone app (Expo) | Coming |

### Agents

| Feature | Status |
| --- | --- |
| Agents hired into roles from templates, each with responsibilities, a voice, model limits and a budget | Live |
| `@g1t`, the orchestrator every workspace has, which hands work to the right agent with `hand_off` | Live |
| Your own model providers' keys (14 providers), and the AI Gateway | Live |
| g1t's hosted models (open to invited workspaces during the alpha) | Preview |
| Budgets per workspace, person, agent and task; guardrails; agents act with the asker's access | Live |
| Spend: where the money went by agent, person, channel, model and product, every budget, a receipt for each task, and your spend in the top bar | Preview |
| Spend by extension | Coming |
| Memory, sessions with live steps and cost, routines on a schedule | Live |
| Agent templates in Agents: starting points for a new agent, configured once started | Live |
| Foundational skills in every agent: PDFs, Word documents and spreadsheets, reports with sources, charts, code review, thread summaries; owners turn them off per agent | Live |
| A skill library in the open SKILL.md format: write, import, save from a session, attach to agents, teams or every agent at a pinned version, optionally kept in a repository | Live |
| More specialist templates; web research; skills from the Marketplace; skill scripts on an agent's own computer | Coming |
| Agents on runners anywhere (g1t's, yours, your desktop), with sessions that persist between tasks | Coming |
| Agents answering in Slack and Teams | Coming |

### Code and Deployments

| Feature | Status |
| --- | --- |
| Public and private repositories, git over HTTPS, creating a repository by pushing to it | Live |
| Issues, pull requests, line comments, reviews from people and agents | Live |
| Required checks, rulesets, CODEOWNERS, the merge queue | Live |
| Workflows from `.g1t/workflows` on g1t's runners or self-hosted ones (`crates/runner`) | Live |
| Assign an issue to g1t: a pull request, checks, a review and revisions until it passes (invited workspaces) | Preview |
| Any coding agent over MCP, recording its session onto its pull requests; why-blame | Live |
| Packages: npm, Cargo, Composer, Maven, NuGet, RubyGems, Go modules, container images | Live |
| Secret push protection, history scanning, dependency upgrade pull requests | Live |
| A preview of every pull request on `g1t.page`, production on merge, custom domains | Live |
| GitHub import, mirroring and pushing back | Live |
| A copy of the data for every preview, instant rollback, container apps kept warm | Coming |
| Git over SSH (waits on inbound TCP on Workers; use HTTPS) | Coming |

### Extend and run

| Feature | Status |
| --- | --- |
| Integrations: the GitHub App, Sentry, Datadog, Jira, Linear, alerts | Live |
| REST API, OpenAPI, MCP server, webhooks, an event bus | Live |
| Usage billing with no seats, a public price book, spend limits, itemised invoices | Live |
| The Marketplace: extensions and integrations, added by owners, with install requests from members | Live |
| Extensions shared from public repositories (Mail, Support, CRM, Recruiting, On-call and helpdesk, CRM and ERP bridges are listed); Drive, Gmail, Calendar and Slack integrations | Coming |
| Single sign-on (SAML, OIDC) and SCIM per workspace | Coming |
| Storage: databases and buckets per team, with copies of production for anything unreviewed | Coming |
| Self-hosting: the core forge in Docker Compose (agents, deployments and context search off) | Preview |

## Try it

```sh
# 1. Create an account and a workspace at https://g1t.sh/register (you need an invite).

# 2. Connect Claude Code, then run /mcp in it to sign in through your browser.
claude mcp add --transport http g1t https://mcp.g1t.sh

# 3. Ask it to open a pull request for an open issue.
```

[Getting started](https://docs.g1t.sh/quickstart/) walks through this in
full. An assistant can do it for you from <https://g1t.sh/llms.txt>.

## Layout

| Path | What it is | Language |
| --- | --- | --- |
| `apps/web` | The site: server-rendered React on a Worker. Holds no data. | TypeScript |
| `apps/docs` | The documentation site, with the API explorer. | TypeScript |
| `apps/api` | REST API and MCP server. | Rust |
| `services/identity` | Accounts, workspaces, sessions, keys and tokens. | Rust |
| `services/repos` | Repository registry, contents, forks, diffs, landing, git over HTTPS. | Rust |
| `services/work` | Issues, pull requests, reviews, check runs and sessions. | Rust |
| `services/events` | The event bus and its log. | Rust |
| `services/search` | Site-wide search and Explore. | Rust |
| `services/billing` | Usage, the price book, limits, invoices and payments. | Rust |
| `services/actions` | GitHub Actions workflows, runs, caches and self-hosted runners. | Rust |
| `services/security` | Push protection findings, history scanning and dependency upkeep. | Rust |
| `services/integrations` | Model providers, alerts, trackers and the GitHub App. | Rust |
| `services/webhooks` | Webhook deliveries. | Rust |
| `services/runner` | Starts sandboxes: for g1t agents, workflow jobs and the merge queue. | TypeScript |
| `services/projects` | Projects: what a workspace builds and runs, and where its code lives. | TypeScript |
| `services/deployments` | Builds, previews and production on `g1t.page`. | TypeScript |
| `services/pages` | Serves every app deployed on `g1t.page`, and custom domains. | TypeScript |
| `services/models` | The model proxy at `models.g1t.sh`. | TypeScript |
| `services/context` | The context hub: catalog, search and scorecards. | TypeScript |
| `services/chat` | Channels, direct messages, threads and their live sockets. | TypeScript |
| `services/agents` | The workspace's agents: definitions, templates, desks, memory and runs. | TypeScript |
| `services/artifacts` | Artifacts: docs and the other kinds to come, their spaces, sharing and live editing. | TypeScript |
| `services/notify` | Notifications: each person's feed, live counts and browser push. | TypeScript |
| `services/packages` | The package registries and container images. | Rust |
| `services/og` | Social cards at `og.g1t.sh`: a PNG per page, showing only what anyone may see. | TypeScript |
| `apps/status` | The status page at `status.g1t.sh`. | TypeScript |
| `apps/sudo` | g1t's own staff console. | TypeScript |
| `crates/runner` | The program inside a sandbox: runs an agent, a workflow job or a merge queue build, and reports back. | Rust |
| `crates/contracts` | Types and service interfaces for the Rust services. | Rust |
| `crates/kit` | Plumbing shared by Rust services on Workers. | Rust |
| `crates/g1t` | The `g1t` command line. | Rust |
| `crates/rules` | The rules engine for rulesets on branches and tags. | Rust |
| `crates/blobstore` | Object storage: R2 on Cloudflare, any S3-compatible store self-hosted. | Rust |
| `crates/actions` | Reads workflows and evaluates their expressions. | Rust |
| `crates/scan` | Secret and lockfile scanning, shared by services. | Rust |
| `crates/secrets` | Secrets at rest and signatures. | Rust |
| `crates/sshd` | Git over SSH, bridged to Cloudflare Artifacts. Not deployed yet. | Rust |
| `packages/contracts` | The same interfaces for TypeScript callers. | TypeScript |
| `packages/theme` | Design tokens and the logo, shared by the site and the docs. | CSS |
| `deploy` | `stack.jsonc`, every deployable part and its resources; `self-host`, the Docker Compose version. | JSON, Docker Compose |

Each service is its own Worker, and each one that keeps data has its own
database. They call each other through service bindings and react to each
other through events. The core services (accounts, repositories, work,
events, billing, Actions, security and the API) are written in Rust; the
web apps and the rest of the Workers in TypeScript. The Language column
says which, part by part.

## Run your own

### On your own machine

The core forge runs in Docker, with no Cloudflare account:

```sh
docker compose -f deploy/self-host/docker-compose.yml up --build
```

Then open http://localhost:8787 and sign up. The confirmation mail is in
Mailpit at http://localhost:8025. Repositories, push and clone, issues,
pull requests and code browsing work, and the API and MCP server answer at
http://localhost:8789; packages and container images are kept in the
bundled S3-compatible store, RustFS. Agents, deployments and context search
are off in this version.
[Run g1t yourself](https://docs.g1t.sh/guides/self-hosting/) says what works,
and [how a self-hosted g1t runs](https://docs.g1t.sh/guides/self-hosting-architecture/)
what runs inside it.

### On Cloudflare

You need a Cloudflare account on the Workers Paid plan (Cloudflare
Artifacts, where repositories are stored, requires it), Node 22.22 or newer (`engines` in `package.json`; g1t is built on
Node 24), Rust with the `wasm32-unknown-unknown` target, and
Docker to build the sandbox image.

```sh
npm install
npx wrangler login
```

Then, once:

1. Create the resources each part needs: D1 databases, queues, KV
   namespaces, R2 buckets and the Cloudflare Artifacts namespace (`npx wrangler d1
   create <name>`, `npx wrangler queues create <name>`, and so on), and set
   each part's secrets. `deploy/stack.jsonc` lists them all.
2. Put your own `account_id`, database ids and hostnames in each
   `wrangler.jsonc`.
3. For [Deployments](https://docs.g1t.sh/guides/deployments/), which needs
   the Workers for Platforms add-on and a zone for apps:
   `scripts/setup-deployments.sh`.

Deploy everything, migrations first, in dependency order:

```sh
scripts/deploy.sh
```

Or only what changed, still in order: `scripts/deploy.sh billing web`.
Both use your `wrangler login`, not a token in `.env`.

Create the first account by registering on your site, or with
`node services/identity/scripts/create-user.mjs <username>`.
[Deploy g1t to Cloudflare](https://docs.g1t.sh/guides/deploy-to-cloudflare/)
covers the deploy tool, the workflow and first-time setup in full.

## License

[MIT](LICENSE)
