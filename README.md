# g1t

**Git tracks changes. g1t coordinates change.**

g1t is a git platform built for teams whose code is written by people and
their coding agents at the same time. You keep your own harness (Claude
Code, Codex, Cursor, Copilot or anything that speaks MCP); g1t is the
place they all work through. It hosts the repositories, shows who and what
is working on each project right now, keeps parallel work from colliding,
tests changes together before they land, deploys them, and remembers why
each change was made.

g1t is MIT-licensed and in alpha. Use it on [g1t.sh](https://g1t.sh) (anyone
can sign up), or run it yourself. It runs on Cloudflare Workers, with
repositories in Cloudflare Artifacts, and the core runs in Docker.

- Site: <https://g1t.sh>
- Docs: <https://docs.g1t.sh>
- API: <https://api.g1t.sh> · MCP: <https://mcp.g1t.sh>
- Limits you can hit today: [docs.g1t.sh/about/limitations](https://docs.g1t.sh/about/limitations/)

## Try it

```sh
# 1. Sign up and make a workspace at https://g1t.sh/register.

# 2. Install the g1t CLI (Windows: irm https://g1t.sh/install.ps1 | iex).
curl -fsSL https://g1t.sh/install | sh
g1t auth login
```

Choose your client in [Connect an AI client](https://docs.g1t.sh/guides/bring-your-own-agent/).
It covers Codex, Claude Code, Cursor, Gemini CLI and OpenCode, plus ChatGPT,
Claude, Grok, Open WebUI and LibreChat. The guides remember your choice.
Chat apps connect through MCP without needing the CLI or a local checkout.

For Claude Code, install the plugin and sign in from `/mcp`:

```sh
claude plugin marketplace add https://g1t.sh/flagon-io/g1t-plugins.git
claude plugin install g1t@g1t
```

For Codex, add the MCP server and sign in:

```sh
codex mcp add g1t --url https://mcp.g1t.sh
codex mcp login g1t
```

The [Codex marketplace plugin](https://docs.g1t.sh/guides/bring-your-own-agent/#codex-marketplace)
also supplies a work coordination skill. Use it or the standalone connection
above to avoid duplicate tools. Claude Code's plugin records sessions through
hooks; other clients record sessions through the CLI or MCP.
[Getting started](https://docs.g1t.sh/quickstart/) walks through a coding task.
An assistant can follow <https://g1t.sh/llms.txt>.

## What's in it

### Coordinating agents

- **Sessions.** Record a coding agent as it works: its
  prompts, tool calls, subagents, branches, commits and pull requests. Work
  that is not a work item yet is a session titled by what it is for. The
  [Claude Code plugin](https://docs.g1t.sh/guides/claude-code-plugin/) does
  it automatically after installation and sign-in; other clients can record
  summaries with the CLI or MCP, including through the Codex plugin skill.
- **Live now.** A project's page shows who is working on it right now and
  with which harness, grouped by work item, pull request or branch.
- **Claims.** Advisory, expiring claims on work items, so two agents don't do the
  same work, with hand-offs between sessions and coordination events
  (`g1t work events --follow`, or over MCP) when work overlaps.
- **Integration.** The merge queue tests changes together before they land,
  tests smaller combinations to narrow a failure without assuming a single
  culprit, and sends the evidence to the session responsible for repair.
- **Why-blame and decisions.** `g1t why file:line` answers why code is as it
  is: its commit, pull request, work item, the decisions recorded along the way,
  and the sessions behind it.
- **Ask g1t.** Ask about your work from any page, or by messaging @g1t. It
  answers with your workspace's own AI provider and reads g1t as you.

### Code

- Public and private repositories, git over HTTPS, creating a repository by
  pushing to it, GitHub import (every branch and tag, and issues, as work items).
- Work items that belong to the workspace and can span its repositories,
  with milestones and labels; pull requests, line comments and reviews.
- Required checks, rulesets, CODEOWNERS and the merge queue.
- Workflows from `.g1t/workflows` in GitHub Actions syntax, on g1t's Linux
  runners or self-hosted ones on Linux, macOS and Windows, with caches,
  secrets and variables.
- Packages: npm, Cargo, Composer, Maven, NuGet, RubyGems, Go modules and
  container images.
- Secret push protection, history scanning and dependency update pull
  requests.

### Deployments and observability

- A preview of every pull request on `g1t.page`, production on merge, custom
  domains. Static sites, Workers and containers, chosen from the project.
- Logs, traces, metrics and errors from your apps over OpenTelemetry.

### The workspace

- Chat: channels, direct messages and threads, live.
- Artifacts: docs written together, live, with comments, suggestions and
  history.
- Home, notifications with browser push, people and teams, roles, invites.
- A desktop app for Windows and Linux that can also be a runner for your
  workspace, and an Android app in testing ([g1t.sh/download](https://g1t.sh/download)).

### Extend

- REST API, OpenAPI, an MCP server, webhooks and the `g1t` CLI, all from one
  set of operations.
- Integrations: your own AI providers, Sentry, Datadog and webhook alerts,
  Jira and Linear.
- Usage billing with no seats and a public price book.

## Layout

| Path                      | What it is                                                                                                  | Language             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------- |
| `apps/web`                | The site: server-rendered React on a Worker. Holds no data.                                                 | TypeScript           |
| `apps/docs`               | The documentation site, with the API explorer.                                                              | TypeScript           |
| `apps/api`                | REST API and MCP server.                                                                                    | Rust                 |
| `apps/desktop`            | The desktop app (Tauri), with a runner inside.                                                              | Rust, TypeScript     |
| `apps/mobile`             | The phone app (Expo).                                                                                       | TypeScript           |
| `apps/status`             | The status page at `status.g1t.sh`.                                                                         | TypeScript           |
| `apps/sudo`               | g1t's own staff console.                                                                                    | TypeScript           |
| `services/identity`       | Accounts, workspaces, sessions, keys, tokens and invites.                                                   | Rust                 |
| `services/repos`          | Repository registry, contents, forks, diffs, landing, git over HTTPS.                                       | Rust                 |
| `services/work`           | Work items, pull requests, reviews, check runs, agent sessions, claims and the merge queue.                 | Rust                 |
| `services/events`         | The event bus and its log.                                                                                  | Rust                 |
| `services/search`         | Site-wide search and Explore.                                                                               | Rust                 |
| `services/billing`        | Usage, the price book, limits, invoices and payments.                                                       | Rust                 |
| `services/actions`        | Workflows, runs, caches and self-hosted runners.                                                            | Rust                 |
| `services/security`       | Push protection findings, history scanning and dependency updates.                                          | Rust                 |
| `services/integrations`   | AI providers, Ask, alerts, trackers and the GitHub App.                                                     | Rust                 |
| `services/webhooks`       | Webhook deliveries.                                                                                         | Rust                 |
| `services/packages`       | The package registries and container images.                                                                | Rust                 |
| `services/runner`         | Starts sandboxes for workflow jobs, builds and the merge queue.                                             | TypeScript           |
| `services/projects`       | Projects: what a workspace builds and runs, and where its code lives.                                       | TypeScript           |
| `services/deployments`    | Builds, previews and production on `g1t.page`.                                                              | TypeScript           |
| `services/pages`          | Serves every app deployed on `g1t.page`, and custom domains.                                                | TypeScript           |
| `services/telemetry`      | Observability: OpenTelemetry ingest, logs, traces, metrics and errors.                                      | TypeScript           |
| `services/chat`           | Channels, direct messages, threads and their live sockets.                                                  | TypeScript           |
| `services/artifacts`      | Docs: their spaces, sharing and live editing.                                                               | TypeScript           |
| `services/notify`         | Notifications: each person's feed, live counts and browser push.                                            | TypeScript           |
| `services/og`             | Social cards at `og.g1t.sh`: a PNG per page, showing only what anyone may see.                              | TypeScript           |
| `crates/g1t`              | The `g1t` command line.                                                                                     | Rust                 |
| `crates/runner`           | The program inside a sandbox, and the self-hosted runner: runs a workflow job or a build and reports back.  | Rust                 |
| `crates/contracts`        | Types and service interfaces for the Rust services.                                                         | Rust                 |
| `crates/kit`              | Plumbing shared by Rust services on Workers.                                                                | Rust                 |
| `crates/rules`            | The rules engine for rulesets on branches and tags.                                                         | Rust                 |
| `crates/blobstore`        | Object storage: R2 on Cloudflare, any S3-compatible store self-hosted.                                      | Rust                 |
| `crates/actions`          | Reads workflows and evaluates their expressions.                                                            | Rust                 |
| `crates/scan`             | Secret and lockfile scanning, shared by services.                                                           | Rust                 |
| `crates/secrets`          | Secrets at rest and signatures.                                                                             | Rust                 |
| `crates/sshd`             | Git over SSH, bridged to Cloudflare Artifacts. Not deployed.                                                | Rust                 |
| `packages/contracts`      | The same interfaces for TypeScript callers.                                                                 | TypeScript           |
| `packages/theme`          | Design tokens and the logo, shared by the site and the docs.                                                | CSS                  |
| `plugins/claude-code`     | g1t's Claude Code plugin: hooks, skills and commands, published to `flagon-io/g1t-plugins` on every change. | JavaScript           |
| `plugins/codex`           | Codex plugin: MCP server and work coordination skill, published to `flagon-io/g1t-plugins`.                 | JSON / Markdown      |
| `plugins/other-harnesses` | The AGENTS.md snippet for Codex, Cursor and other harnesses.                                                | Markdown             |
| `deploy`                  | `stack.jsonc`, every deployable part and its resources; `self-host`, the Docker Compose version.            | JSON, Docker Compose |

Each service is its own Worker, and each one that keeps data has its own
database. They call each other through service bindings and react to each
other through events. The core services are written in Rust; the web apps
and the rest of the Workers in TypeScript.

## Run your own

### On your own machine

The core forge runs in Docker, with no Cloudflare account:

```sh
docker compose -f deploy/self-host/docker-compose.yml up --build
```

Then open <http://localhost:8787> and sign up. The confirmation mail is in
Mailpit at <http://localhost:8025>. Repositories, push and clone, work items,
pull requests, code browsing, search, webhooks and observability work, and
the API and MCP server answer at <http://localhost:8789>; packages and
container images are kept in the bundled S3-compatible store, RustFS.
Deployments and billing are off, and the merge queue can't test or land
pull requests without g1t's runner.
[Run g1t yourself](https://docs.g1t.sh/guides/self-hosting/) says what works,
and [how a self-hosted g1t runs](https://docs.g1t.sh/guides/self-hosting-architecture/)
what runs inside it.

### On Cloudflare

You need a Cloudflare account on the Workers Paid plan (Cloudflare
Artifacts, where repositories are stored, requires it), Node 24 (`.nvmrc`,
and `engines` in `package.json`), Rust with the `wasm32-unknown-unknown`
target, and Docker to build the sandbox image.

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
