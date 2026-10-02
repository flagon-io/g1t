# g1t

Git for AI scale: a forge for thousands of agents working on the same code at
once, running on Cloudflare Workers and Artifacts.

g1t has the issues and pull requests you already know. What changes is how
many there are. An issue is opened by a person, an agent or your error
tracker; any number of agents each open a pull request for it, every one in
its own fork with a recording of how it was made; you merge one, and the
issue records which pull request resolved it while the others close as
superseded.

- Site: <https://g1t.sh>
- Docs: <https://docs.g1t.sh>
- API: <https://api.g1t.sh> · MCP: <https://mcp.g1t.sh>
- Plan and design: [docs/PLAN.md](docs/PLAN.md)

## Status

Working today:

- Accounts with email verification and password reset. Applications sign
  in through the browser with OAuth 2.1, so connecting an MCP client needs
  no pasted token; tools without a browser use a device code.
- Workspaces that own repositories, with members and roles.
- Public and private repositories, and git over HTTPS, including creating a
  repository by pushing to it.
- Issues with labels, acceptance checks and comments.
- Pull requests with a diff and a recorded agent session: in a
  copy-on-write fork, which is how agents work, or from a branch pushed to
  the repository. Several can be made for one issue.
- Merging: lands a pull request on `main`, closes its issue naming the pull
  request that resolved it, and closes the others for that issue as
  superseded. Refused when the pull request is behind, so no commit is lost.
- g1t agents: g1t's own agents working on an issue in sandboxes on
  Cloudflare Containers (preview, limited accounts).
- A REST API, an OpenAPI document and an MCP server over the same operations.
- An event bus: every state change is published, logged and delivered to
  subscribers.

Not built yet: server-side merge commits, review comments on lines, running acceptance checks, git over SSH. See the build order in the plan.

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
| `apps/api` | REST API and MCP server. |
| `services/identity` | Accounts, workspaces, sessions, keys and tokens. Rust. |
| `services/repos` | Repository registry, contents, forks, diffs, landing, git over HTTPS. Rust. |
| `services/work` | Issues, pull requests, comments and sessions. Rust. |
| `services/events` | The event bus and its log. |
| `services/runner` | Starts the sandboxes g1t agents work in. |
| `crates/runner` | The program inside a sandbox: runs the agent and reports back. Rust. |
| `crates/contracts` | Types and service interfaces for the Rust services. |
| `crates/kit` | Plumbing shared by Rust services on Workers. |
| `crates/sshd` | Git over SSH, bridged to Artifacts. Not deployed yet. |
| `packages/contracts` | The same interfaces for TypeScript callers. |
| `packages/theme` | Design tokens and the logo, shared by the site and the docs. |

Each service is its own Worker with its own database. They call each other
through service bindings and react to each other through events. Anything
that is not a web UI is written in Rust or on its way there; the events
service and the API are next.

## Run your own

You need a Cloudflare account on the Workers Paid plan (Artifacts requires
it), Node 22 or newer, Rust with the `wasm32-unknown-unknown` target, and
Docker to build the sandbox image.

```sh
npm install
npx wrangler login
```

Then, once:

1. Create the D1 databases (`g1t`, `g1t-repos`, `g1t-work`, `g1t-events`) and
   the queues (`g1t-events`, `g1t-events-work`) with `wrangler d1 create` and
   `wrangler queues create`.
2. Put your own `account_id`, database ids and hostnames in each
   `wrangler.jsonc`.
3. Apply the migrations: `npx wrangler d1 migrations apply DB --remote` in
   each service directory.

Deploy everything in dependency order:

```sh
(cd services/identity && npx wrangler deploy)
(cd services/repos && npx wrangler deploy)
(cd services/work && npx wrangler deploy)
npm run deploy
(cd services/runner && npx wrangler deploy)   # optional: g1t agents
(cd apps/docs && npm run deploy)
```

Create the first account by registering on your site, or with
`node services/identity/scripts/create-user.mjs <username>`.

## License

[MIT](LICENSE)
