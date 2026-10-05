---
title: Context hub
description: The catalog g1t builds of everything a workspace builds and runs, memory that fills itself from runs, reviews, merges and docs, one search over all of it, and a scorecard for every project.
---

The **context hub** is one place to ask about a workspace: what it builds
and runs, who owns what, how each project is built, tested and deployed,
and what people and agents have learned along the way. It fills itself
from your repositories, deployments and integrations, and from the work
agents and people do, so it is never a wiki someone has to keep up.

Open it from **Context**, under Across projects in the workspace's sidebar.
It has four tabs:

| Tab | What it shows |
| --- | --- |
| **Catalog** | Every project, app, API, package, language, owner, environment, integration and doc, and how they relate |
| **Memory** | The Review queue: memory candidates waiting for a person |
| **Search** | One search across the catalog, docs, issues, pull requests and memory |
| **Scorecards** | A few rules every project should meet, each failing one a click away from an issue an agent fixes |

Every g1t agent run starts with a **Context** section drawn from the hub,
and your own agents can ask it through the [MCP tools](#mcp-tools)
`search_context` and `get_entity`.

## The catalog

The catalog is built from each project's default branch, on every push to
it. g1t reads the files that say what a project is, and only those whose
contents changed since the last push:

| Read from | Gives |
| --- | --- |
| `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements.txt` | **Packages** (name, version, dependencies), **languages**, test and build commands, the package manager from the committed lockfile |
| `wrangler.jsonc`, `wrangler.json`, `wrangler.toml`; `openapi.*`, `swagger.*` | **APIs**: a Worker's routes, or an OpenAPI document's operations |
| `README`, `AGENTS.md` (or `CLAUDE.md`), `CONTRIBUTING`, `docs/*.md`, `runbooks/*.md` | **Docs**, split into sections for search |
| `.g1t/workflows/*`, `.github/workflows/*` | Whether the project's tests run in checks |
| `owners:` in `.g1t/project.yml`, and `CODEOWNERS` | **Owners** |

and joins them with what g1t already knows:

- **Dependencies** between projects, from [Projects](/guides/projects/);
- **Apps and environments**, with their live addresses, from
  [Deployments](/guides/deployments/);
- **Integrations**, from [Integrations](/guides/integrations/);
- **Owners** also include the members who wrote at least a fifth of the
  project's last 100 commits, up to three.

Each entry links to where it lives: a project's code, a doc's file, an
app's address. Entries relate to each other:

| Relation | Example |
| --- | --- |
| `depends_on` | `web` depends on `api`; `@acme/web` depends on `@acme/ui` |
| `owned_by` | `web` is owned by `ana` |
| `deploys_to` | the `web` app deploys to `web/production` |
| `documented_by` | `web` is documented by its `README.md` |
| `exposes` | `web` exposes the `@acme/web` package and its app; the app exposes its routes |
| `uses` | `web` uses TypeScript, and the Sentry integration that reports on it |

The **Catalog** tab filters by kind and by project, and draws the
workspace's projects with an arrow from each to the projects it uses.

Building the catalog is cheap and repeatable: each push reads at most 15
files of a project, a file whose contents have not changed is never read
again, and building twice from the same commit gives the same catalog.

## Memory that fills itself

[Memory](/guides/agents-and-memory/#memory) is what agents are told about a
project and its workspace. Besides what agents save with `remember` and
what people add by hand, the hub captures it from four places:

| Source | What it captures | Kind |
| --- | --- | --- |
| **Agent runs** | At the end of every run that changes code, the agent is asked what it learned that the next agent would need, with what showed it | fact, convention, decision or gotcha |
| **Reviews** | A person's request for changes, or a comment that corrects the agent ("we use the shared client instead"), on a pull request | convention, quoting the comment |
| **Merges** | A merged pull request's title, why (the first paragraph of its description) and the files it changed | decision |
| **Docs and manifests** | Bullets in `AGENTS.md`; commands under a README's setup and testing sections; conventions sections; the package manager and test commands from manifests | fact, convention or gotcha |

What is captured arrives as a **candidate**. No agent is given a candidate
until it is **kept**:

- **at once**, when two independent sources say the same thing (a doc and
  a run, two runs, a run and a review), or when a project's `AGENTS.md` or
  manifests state it;
- **by a person**, in the Review queue.

The same thing said again in different case, punctuation or spacing counts
as the same memory, seen once more. A memory seen again from the same
source (the same run, the same file) is not counted twice.

### Review

The **Memory** tab of the Context page lists every candidate in the
workspace; a project's **Agents → Memory** lists its own. Each shows where
it came from (a run, a review comment, a merged pull request, a doc), the
evidence quoted, how sure its source was and how often it has been seen.

- **Keep** gives it to every agent from their next run on.
- **Edit** rewords it, or changes its kind, and keeps it.
- **Dismiss** throws it away, and the same wording is never suggested
  again.

### Never a secret

Captured memory is held to the same rule as everything else in memory: text
that looks like a key, a token, a password or a private key is refused, in
the memory and in its evidence. Agents are told never to report one.

## Search

**Search** finds things by meaning, across:

- catalog entries;
- the sections of every project's docs;
- issues and pull requests, with their descriptions (an agent's pull
  request description is its account of the session);
- kept memory.

Each result says what kind of thing it is, where it came from, who wrote it
and how fresh it is. When the search index cannot answer, g1t matches the
words of your query instead, and says so.

### Who sees what

- Search never reads another workspace's rows.
- Members of the workspace, and its agents, find everything in it.
- Anyone else who can see a public project finds that project's catalog
  entries, docs, issues and pull requests, and never memory.
- A project made private is hidden from people outside the workspace at
  once, even before it is searched again.

## Scorecards

Each project is checked against a few rules:

| Rule | Passes when |
| --- | --- |
| **Has an owner** | `.g1t/project.yml` or `CODEOWNERS` names one, or a member wrote most of it |
| **Has a README** | A README sits at the project's root |
| **Has an AGENTS.md** | An `AGENTS.md` (or `CLAUDE.md`) tells agents how to work here |
| **Tests run in checks** | A workflow in `.g1t/workflows` or `.github/workflows` runs tests |
| **Production deploy is green** | Production is live and its latest build did not fail. Does not apply to a project that does not deploy on g1t |
| **No open secret findings** | [Security](/guides/security/) has no open secret findings for it |

A failing rule has **Fix with an agent**: g1t opens an issue saying what to
do, with an acceptance check where one can be written (such as
`test -f AGENTS.md`), and puts g1t's agent on it.

## Agents start with context

Every g1t agent run is given a **Context** section, after the project's
memory, within about 4,000 characters:

- the project's stack, test commands, owners, docs, and its environments
  with their addresses;
- the projects it uses, with their live addresses and the variables that
  carry them, and the projects that use it;
- the kept memories closest to the task, beyond the pinned ones every run
  already has;
- the latest decisions from merged pull requests.

Each line says where it came from (`[source: catalog]`,
`[source: AGENTS.md]`, `[source: review on #12]`). Agents are told it is
reference material: where it disagrees with the code, the code wins.

## Building it for a workspace

The first time anyone opens a workspace's Context page, g1t builds its hub:
the catalog for every project (up to 50), memory candidates from their
docs, manifests and last 20 merged pull requests with their reviews, and
the search index for docs, recent issues and pull requests, and kept
memory. **Rebuild** does it again, reading every file afresh.

Putting text in the search index uses Workers AI and is counted per
workspace and month; a workspace that passes 20 million tokens in a month
keeps text search, and new text waits for the next month's index.

## MCP tools

| Tool | Takes | Does |
| --- | --- | --- |
| `search_context` | `query`, and `workspace` or `repo`; optional `project`, `kinds`, `limit` | One search across the catalog, docs, issues, pull requests and memory, as [Search](#search) |
| `get_entity` | `kind`, `id`, and `workspace` or `repo` | One catalog entry by its id or key (a project's slug, `npm:<name>`, a username), with every relation |

g1t's own agents have both. Over REST:

```sh
curl "https://api.g1t.sh/workspaces/acme/context/search?q=how+do+we+deploy+the+api" \
  -H "Authorization: Bearer $G1T_TOKEN"

curl "https://api.g1t.sh/workspaces/acme/context/project/web" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

See [Search the context hub](/reference/api/context/search-context/) and
[Get a catalog entry](/reference/api/context/get-entity/).
