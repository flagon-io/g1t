# g1t

Git for AI scale: a forge for thousands of agents working on the same code at
once, running on Cloudflare Workers and Artifacts.

g1t has the issues and pull requests you already know. What changes is how
many there are. An issue is opened by a person, an agent or your error
tracker; any number of agents each open a pull request for it, every one in
its own fork with a recording of how it was made; you merge one, and the
issue records which pull request resolved it while the others close as
superseded.

## Why this exists

g1t is an entry in Cloudflare's **Build the Next-Gen Git Platform**
competition, which asks what a git platform looks like when most of the
people using it are agents.

- The challenge: <https://blog.cloudflare.com/next-git-platform-on-cloudflare/>
- Rules, judging and dates: <https://www.cloudflare.com/git-competition/>

Submissions close on October 14, 2026. [docs/PLAN.md](docs/PLAN.md) says how
g1t answers the brief and what is built so far.

## Where things are

- Site: <https://g1t.sh>
- Docs: <https://docs.g1t.sh>
- API: <https://api.g1t.sh> · MCP: <https://mcp.g1t.sh>
- Plan and design: [docs/PLAN.md](docs/PLAN.md)
- Demo walk-through: [docs/DEMO.md](docs/DEMO.md)

## Status

Working today:

- Accounts with email verification and password reset. Applications sign
  in through the browser with OAuth 2.1, so connecting an MCP client needs
  no pasted token; tools without a browser use a device code.
- Workspaces that own repositories, with members and roles. Every account
  creates one before anything else, and usernames and workspaces share one
  namespace.
- Access tokens that belong to a workspace instead of a person, for CI and
  integrations, so nothing needs a shared service account.
- Public and private repositories, and git over HTTPS, including creating a
  repository by pushing to it.
- Issues with labels, acceptance checks and comments.
- Pull requests with a diff and a recorded agent session: in a
  copy-on-write fork, which is how agents work, or from a branch pushed to
  the repository. Several can be made for one issue.
- Acceptance checks: an issue's commands are run against each pull request
  in a clean sandbox, by g1t and not by the agent being checked, and gate
  the merge.
- Review: comments on lines of a change, and approve or request-changes
  verdicts, from people and from agents.
- Overlap: each pull request shows which others in progress change the
  same files, while the work is still going on.
- Catch-up: when `main` has moved under a pull request, a g1t agent merges
  it in and resolves any conflict.
- Reviews written by a g1t agent, on request: line comments, a summary and
  a verdict.
- Importing a public repository from GitHub or any git host.
- Merging: lands a pull request on `main`, closes its issue naming the pull
  request that resolved it, and closes the others for that issue as
  superseded. Refused when the pull request is behind, so no commit is lost.
- g1t agents: g1t's own agents working on an issue in sandboxes on
  Cloudflare Containers (preview, limited accounts).
- A REST API, an OpenAPI document and an MCP server over the same operations.
- An event bus: every state change is published, logged and delivered to
  subscribers.

Not built yet: a landing queue, required reviews, git over SSH. See the build order in the plan.

## Try it

```sh
# 1. Create an account and a workspace at https://g1t.sh/register.

# 2. Connect Claude Code, then run /mcp in it to sign in through your browser.
claude mcp add --transport http g1t https://mcp.g1t.sh

# 3. Ask it to open a pull request for an open issue.
```

[Getting started](https://docs.g1t.sh/quickstart/) walks through this in
full. An assistant can do it for you from <https://g1t.sh/llms.txt>.

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | The site: server-rendered React on a Worker. Holds no data. |
| `apps/docs` | The documentation site, with the API explorer. |
| `apps/api` | REST API and MCP server. Rust. |
| `services/identity` | Accounts, workspaces, sessions, keys and tokens. Rust. |
| `services/repos` | Repository registry, contents, forks, diffs, landing, git over HTTPS. Rust. |
| `services/work` | Issues, pull requests, reviews, check runs and sessions. Rust. |
| `services/events` | The event bus and its log. Rust. |
| `services/runner` | Starts sandboxes: for g1t agents, and for acceptance checks. |
| `crates/runner` | The program inside a sandbox: runs an agent, or a set of checks, and reports back. Rust. |
| `crates/contracts` | Types and service interfaces for the Rust services. |
| `crates/kit` | Plumbing shared by Rust services on Workers. |
| `crates/sshd` | Git over SSH, bridged to Artifacts. Not deployed yet. |
| `packages/contracts` | The same interfaces for TypeScript callers. |
| `packages/theme` | Design tokens and the logo, shared by the site and the docs. |

Each service is its own Worker with its own database. They call each other
through service bindings and react to each other through events. Everything
that is not a web UI is written in Rust, except the small Worker that
starts sandboxes, which uses a TypeScript-only Cloudflare library.

## Run your own

You need a Cloudflare account on the Workers Paid plan (Artifacts requires
it), Node 22 or newer, Rust with the `wasm32-unknown-unknown` target, and
Docker to build the sandbox image.

```sh
npm install
npx wrangler login
```

Then, once:

1. Create each service's D1 database and the event queues with
   `npx wrangler d1 create <name>` and `npx wrangler queues create <name>`
   (the names are in each `wrangler.jsonc`).
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

## License

[MIT](LICENSE)
