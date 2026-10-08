---
title: Projects
description: A project is what you build and run. Its code lives in its source; its deployments, secrets and variables belong to the project.
---

A project is the thing you are building and running: a site, an API, a
worker, a library. Every project has one **source**, where its code lives,
and everything about running it belongs to the project:

| Belongs to the project | Belongs to its repository |
| --- | --- |
| [Deployments](/guides/deployments/): production and previews | Branches and commits |
| Its address on g1t.page | Issues and pull requests |
| [Secrets and variables](/guides/secrets-and-variables/) | Review, merge rules and the [merge queue](/guides/merge-queue/) |
| Its name, description and root directory | Webhooks |

That split is what lets the code live anywhere while the project stays the
same.

## Your projects

Every repository on g1t is a project of its own name, with nothing to set
up: `g1t.sh/acme/web` is the `web` project, built from the `acme/web`
repository. Repositories made before projects existed became projects the
first time their workspace was opened.

A workspace's page, `g1t.sh/<workspace>`, shows your pinned projects and
its most active ones, each with where it is deployed, its latest build, and
its open issues and pull requests. **All projects** in the sidebar lists
every one, with search, filters and sorting; see
[the Projects page](/guides/workspaces/#the-projects-page). The sidebar keeps
your [pinned and recent projects](/guides/workspaces/#pinned-and-recent-projects).

## A project's pages

| Page | Address | |
| --- | --- | --- |
| **Overview** | `g1t.sh/<workspace>/<project>` | What it is and its links; production wherever it is deployed, or for a library its packages; the steps that apply to it; what is in progress, active branches, the latest commits, and its About. See [the overview](#the-overview). |
| **Code** | `…/code` | The repository's files, commits and branches. |
| **Issues**, **Pull requests**, **Merge queue**, **Plan** | `…/issues` and so on | As they always were. |
| **Actions** | `…/actions` | [GitHub Actions workflows](/guides/actions/). |
| **Deployments** | `…/deployments` | What is up now and every build. |
| **Settings** | `…/settings` | See below. |

Every address that pointed into a repository before still works: the
project has the repository's name.

## The overview

A project's overview is the first page you see. People with a
[role](/guides/access-and-roles/) on its repository see all of it; anyone
else sees what the project shares publicly.

| Part | What it shows |
| --- | --- |
| **What it is** | A badge, such as **App, deployed elsewhere** or **Library**, beside its homepage and docs. People who can change its settings open the badge to change [what it is](#what-a-project-is) in one click. |
| **Production** | For an app [deployed on g1t](/guides/deployments/): a screenshot of the live site, which opens it; its address, the commit it runs and when it went up; **Visit** and **Redeploy**. For an app deployed elsewhere: production's address and **Visit**, with the default branch's latest commit. For an app nobody has placed yet: one question, where it runs. |
| **Packages** | For a library or a tool, in place of Production: the packages its repository publishes, each with its latest version and how to install it, or how to publish a first one. |
| **Documentation**, **Homepage** | For docs, where they are read; for anything else, its homepage. |
| **Get to production**, **Ship a release** or **Get started** | The [checklist](#the-checklist) for what the project is, until every step is done or you dismiss it. |
| **Right now** | Agents at work, and open pull requests moving from working to landed. |
| **Needs you** | What is waiting on a person: a failed production build, a pull request to merge or review, a stuck run. |
| **Active branches** | Branches other than the default, newest first. See [active branches](#active-branches). |
| **Recent changes**, **Latest on main**, **Activity**, **Previews** | What landed, the default branch's latest commits, what happened (pull requests opened, readied and merged, issues opened and closed, checks, reviews, comments, pushes to the default branch and production deploys), and the previews that are up. |
| **About** | Its description, its [links](#links), what it is, and its latest release (its newest tag). People who can change its settings edit the description and links from here. |
| **Health**, **Dependencies**, **Clone** | How often checks pass, recent builds and open issues by age; what it uses and what uses it; the clone address. |

### The checklist

People with a role on its repository see a card that counts what the
project has done, such as **3/5**. Its steps follow
[what the project is](#what-a-project-is): only an app deployed on g1t is
asked to deploy, add a domain or open a preview. Each step is worked out
from the project itself, and each links to where you do it. The card goes
away when every step is done. To hide it sooner, choose **×** on it. That
hides it for this project in this browser only.

| What it is | Card | Steps |
| --- | --- | --- |
| App or site, deployed on g1t | **Get to production** | [Below](#get-to-production). |
| Library, tool | **Ship a release** | [Below](#ship-a-release). |
| App, deployed elsewhere | **Get started** | Push code; add production's address; add checks on pull requests; repository instructions; a first issue for g1t. |
| App nobody has placed yet | **Get started** | Push code; say where it runs; add checks on pull requests; repository instructions; a first issue for g1t. |
| Documentation | **Get started** | Push code; add where its docs are read (a docs or homepage address); repository instructions; a first issue for g1t. |
| Something else | **Get started** | Push code; add its links; repository instructions; a first issue for g1t. |

### Get to production

For an app or site deployed on g1t:

| Step | Done when | Links to |
| --- | --- | --- |
| Connect a source or push code | The default branch has a commit, or the source is a mirror. | **Code**, which shows how to push, or how to have your coding agent start the project. |
| Deploy to production | A production build has gone live. | Deployments settings, or **Deployments** once they are on. |
| Add a custom domain | The project has a [custom domain](/guides/deployments/#custom-domains). | Domain settings. |
| Open a preview | A branch or pull request has had a [preview](/guides/deployments/#previews-of-branches). | A new pull request. |
| Set up repository instructions | `AGENTS.md` or `CLAUDE.md` is at the root of the default branch. | The instructions on the **Agents** page. See [repository instructions](/guides/working-with-g1t/#repository-instructions). |
| Assign a first issue to g1t | g1t has had a run, a pull request or an issue here. | A new issue. |

### Ship a release

A library or a tool does not deploy, so its card counts the steps to a
first release instead:

| Step | Done when | Links to |
| --- | --- | --- |
| Connect a source or push code | As above. | **Code**. |
| Add checks on pull requests | The repository has a workflow in `.g1t/workflows`. Its runs are every pull request's checks. | **Actions**, which offers to add a starter workflow. |
| Tag a release or publish a package | A package its repository publishes has a version. For [Composer](/guides/composer/) and [Go](/guides/go/), pushing a tag such as `v1.0.0` is the release. | The package's page, or the guide for its registry. |
| Set up repository instructions | As above. | The **Agents** page. |
| Assign a first issue to g1t | As above. | A new issue. |

## What a project is

A project is one of these, and its overview follows:

| What it is | Its overview shows |
| --- | --- |
| **App or site, deployed on g1t** | Production on g1t.page, with previews and domains, and **Get to production**. |
| **App or site, deployed elsewhere** | Production at the address you give, deployed by your own pipeline, with **Visit**. It is never asked to turn on Deployments; Deployment settings stay one link away. |
| **Library or package** | The packages its repository publishes and how to install them, and **Ship a release**. |
| **Tool or CLI** | The same as a library: its packages and releases. |
| **Documentation** | Where its docs are read. Docs can be published on g1t.page too, by turning on Deployments. |
| **Something else** | Its homepage and links. |

Its **Deployments** page stays in the sidebar whatever it is.

### How g1t works it out

Until you say, g1t works it out for itself, in this order:

1. If [Deployments](/guides/deployments/) are on for the project, it is
   an app deployed on g1t.
2. If its repository publishes a package other than a container image,
   such as a [Composer](/guides/composer/) or [npm](/guides/npm/)
   package, it is a library.
3. If the files at the root of its default branch (or of its root
   directory) say what it is, it is that:

   | File | Says |
   | --- | --- |
   | `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` | An app. |
   | `mkdocs.yml`, `book.toml`, `docusaurus.config.js` (or `.ts`, `.mjs`) or `antora.yml` | Documentation. |
   | `composer.json` | A library when its `type` is anything but `project`, such as `library`; or it has no `type`, has `autoload`, and has no `public/index.php`. |
   | `Cargo.toml` | A library when it builds a library (`[lib]` or `src/lib.rs`) and no binary (`[[bin]]` or `src/main.rs`). |
   | `go.mod` | A library when no `.go` file at the root is `package main`. |
   | `pyproject.toml` | A library when it has a build backend and depends on no app framework, such as Django, Flask or FastAPI. |
   | `package.json` | A tool when it has `bin` and nothing to import (no `main`, `module` or `exports`); a library when it has `main`, `exports`, `module`, `files` or `bin`; either way only with no `start` or `dev` script and no app framework such as Next.js, Astro, Nuxt, Remix or SvelteKit. |

   The language's own manifest is read before `package.json`, which many
   projects carry only for tooling. An `index.html` at the root makes it
   an app.
4. Anything else is an app.

The files are read again on every push to the default branch.

An app found this way runs on g1t only while Deployments are on. Until
you say where it runs, its overview asks, in place of production:
**Deploy on g1t**, **It's deployed elsewhere** (with production's
address), or **It isn't deployed** (a library, a tool, documentation or
something else).

### Choosing it yourself

From the overview, open the badge beside its name, such as **App**, and
choose one. Or open **Settings**, then **General**, and under **What it
is** choose **Detect automatically**, which shows what was detected and
why, or one of the kinds above. **App or site, deployed elsewhere** asks
for production's address.

Choosing a library, a tool or something else while Deployments are on is
refused: turn them off first under **Settings**, then **Deployments**;
g1t does not turn them off for you. While it is set that way, Deployments
cannot be turned on. Turning Deployments on for an app deployed elsewhere
makes it an app deployed on g1t.

Changing what it is needs the role that changes the project's settings.

### Active branches

Up to five branches other than the default, the most recently changed
first. Each shows its last commit and who made it, how many commits it is
ahead of the default branch and behind it, and its open pull request,
with its checks, and preview, if it has them. A branch with no pull
request links to opening one, unless it has nothing the default branch
lacks, which says **Nothing to merge**.

Ahead and behind are exact, merges included. g1t reads up to 1,000
commits of each history to find where the two meet; a branch that left
the default branch further back than that shows no counts. Ten branches
are read, those with open pull requests first; a project with more says
how many it has.

## Links

A project has a **homepage**, a **docs** address, and up to 10 other
links, each a label and an address, such as a status page or its listing
in a registry. They show in its overview's About and beside what it is,
on its card on its workspace's page, in its workspace's Projects, and on
Explore for a public project.

To set them, open **Settings**, then **General**, and fill in **Links**;
or choose the pencil on the overview's **About**. Each is an http or
https address; `https://` is added when you leave it out. A label left
empty is the address's host name. Removing every row of other links
clears them.

A repository's own project shows the repository's website as its
homepage until you give the project one of its own. For an app deployed
on g1t, its g1t.page address still shows as production; set the homepage
to production's own domain if you have one.

## Settings

A project's **Settings** has a tab for each part:

| Tab | What it holds |
| --- | --- |
| **General** | The project's name and description, its source, its **root directory**, [what it is](#what-a-project-is), and its [links](#links). A project shows its repository's description, and follows it as it changes, until you give the project one of its own; **Use the repository's description** goes back. |
| **Deployments** | Production, previews, build command, output directory and idle days. See [Deployments](/guides/deployments/#settings). |
| **Domains** | Custom domains for production. See [custom domains](/guides/deployments/#custom-domains). |
| **Dependencies** | The projects this one uses, and the ones that use it. See [Dependencies](#dependencies). |
| **Agents** | How g1t's agents pick up work here, and what they read first. |
| **Guardrails** | What agents may reach, run and spend while they work here. See [guardrails](/guides/guardrails/). |
| **Repository** | The repository's name, description, website, [topics](/guides/search/#what-is-indexed) and default branch, and its danger zone: visibility, archive, transfer and delete. See [Managing a repository](/guides/managing-repositories/). |
| **Access** | Who has a [role](/guides/access-and-roles/) on the repository, and invitations. |
| **Branches and merging** | Auto-merge, how g1t's agents review and revise, the CODEOWNERS file's errors, and what the rules hold for the default branch. |
| **Rules** | [Rulesets](/guides/rules/): branch and tag protection, [required status checks](/guides/pull-requests/#required-status-checks), approvals, the merge queue, and rules for agents' changes, with Insights. |
| **Secrets and variables** | The project's rows. See [Secrets and variables](/guides/secrets-and-variables/). |
| **Runners** | The project's own [self-hosted runners](/guides/self-hosted-runners/), and where its agents' work runs. |
| **Webhooks** | The repository's [webhooks](/guides/webhooks/). |

The **root directory** says where in the repository the project lives,
such as `apps/web`. Builds run there. Leave it empty for the whole
repository.

Each tab needs a [role](/guides/access-and-roles/) on the project's
repository:

| Tab | Needs |
| --- | --- |
| **General**, **Dependencies**, **Agents**, **Branches and merging**, and on **Repository** its description, website and topics | Maintain |
| **Rules**, **Guardrails** | Admin |
| **Access**: seeing who has a role; changing it | Write; Admin |
| **Deployments**, **Domains**, **Secrets and variables**, **Runners**, **Webhooks** | Admin |
| On **Repository**: its name, default branch, and the danger zone (visibility, archive) | Admin |
| Transfer and delete | An owner of the workspace |

Someone without the role does not see the tab.

## Create a project

1. Choose **New project** in the sidebar, or go to `g1t.sh/new`.
2. Choose where its code comes from:
   - **Start empty**: a new repository on g1t.
   - **Import code**: copy a public repository from GitHub or any git host
     into a new one on g1t, with every branch and tag (up to 40 MB of
     history).
   - **Import from GitHub**: import, mirror or move repositories you can
     reach on GitHub, private ones too, with every branch and tag and,
     if you like, their issues. See [GitHub](/guides/github/).
3. Give it a name and say who can see it, then choose **Create project**.

Pushing a repository that does not exist yet makes one, and with it a
project:

```sh
git push https://g1t.sh/acme/my-app.git main
```

## Sources

A project's source is a repository hosted on g1t. A repository can be a
**mirror of one on GitHub**: the code stays there, every push to GitHub is
fetched into g1t, and the project gets g1t's deployments, secrets and
agents on it. See [GitHub](/guides/github/#import-mirror-or-move-a-repository).

Coming next:

- **Mirrored from GitLab or Bitbucket**, and previews on GitHub's own pull
  requests.
- **Several projects on one repository**, each from its own root
  directory, with a push building only the projects it touched.


## Dependencies

A project can depend on others in its workspace: `web` calls `api`'s HTTP
API, or consumes `ui-kit`'s package. Declare it under **Settings →
Dependencies**, or in a `.g1t/project.yml` in the project's root
directory:

```yaml
dependsOn:
  - project: api
    as: API_URL
  - project: ui-kit
```

The file is read on every push to the default branch, and its dependencies
replace the ones it declared before; those are marked **project.yml** and
changed only in the file. A dependency that would make a cycle, or names a
project that does not exist, is left out.

What g1t does with them:

| | |
| --- | --- |
| **Addresses in builds and apps** | With `as: API_URL`, `web`'s builds and its running app get `API_URL` set to `api`'s address for the same environment: production gets `api`'s production; a preview gets the preview of `api` on the same branch if one is up, else `api`'s production. A secret or variable of the same name on `web` wins. |
| **Preview stacks** | On a pull request of `api` whose preview is up, **Preview them against this change** builds a preview of every project that uses `api`, from its default branch, under the same branch name, so each reaches the change through its variable. A reviewer clicks through the whole change. |
| **Affects** | A pull request lists the projects that use its project, so reviewers see what else a change can break. |
| **Agents** | An agent working on a project is told what it uses and what uses it. If its change alters what those rely on, it keeps it working for them or opens an issue on each saying what to change, and says so in its summary. |
| **The overview** | Each project's overview shows what it depends on and what uses it. |

## From the API

Projects keep their repository's routes: `/repos/{workspace}/{project}/…`
reaches the project's repository, and its secrets and variables are the
project's. See the [API reference](/reference/api/).

What a project is, where it runs and its links have routes of their own,
and actions on the [MCP](/reference/mcp/) `workspace` tool:

| Route | MCP action | |
| --- | --- | --- |
| `GET /workspaces/{workspace}/projects` | `list_projects` | The workspace's projects you can see. |
| `GET /workspaces/{workspace}/projects/{project}` | `get_project` | One project, with `kind`, `runs`, `production_url`, `setting`, `detected` and `links`. |
| `PATCH /workspaces/{workspace}/projects/{project}` | `update_project` | Changes `kind`, `runs`, `production_url`, `homepage`, `docs_url`, `links`, or its name, description or root directory. Needs `repo:write`. |

To say an app is deployed by your own pipeline, with its docs:

```sh
curl -X PATCH https://api.g1t.sh/workspaces/acme/projects/web \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"runs": "elsewhere", "production_url": "https://acme.dev", "docs_url": "https://docs.acme.dev"}'
```
