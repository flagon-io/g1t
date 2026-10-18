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
| Its address on g1t.page | Work items and pull requests |
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
its open work items and pull requests. **All projects** in the sidebar lists
every one, with search, filters and sorting; see
[the Projects page](/guides/workspaces/#the-projects-page). The sidebar keeps
your [pinned and recent projects](/guides/workspaces/#pinned-and-recent-projects).

## A project's pages

| Page | Address | |
| --- | --- | --- |
| **Overview** | `g1t.sh/<workspace>/<project>` | What it is and its links; production wherever it is deployed, or for a library its packages; what is in progress, active branches, the latest commits, and its About. See [the overview](#the-overview). |
| **Code** | `…/code` | The repository's files, commits and branches. |
| **Work** | `g1t.sh/<workspace>/-/work?repo=<name>` | The workspace's [work items](/guides/work-items/) linked to the repository. |
| **Pull requests**, **Merge queue** | `…/pulls` and so on | As they always were. |
| **Actions** | `…/actions` | [GitHub Actions workflows](/guides/actions/). |
| **Deployments** | `…/deployments` | What is up now and every build. |
| **Settings** | `…/settings` | See below. |

Every address that pointed into a repository before still works: the
project has the repository's name.

## The overview

A project's overview is the first page you see. It says what the project
is, whether it is running and healthy, and who is working on it right now.
Its files, branches and commits are on **Code**; its pull requests and the
merge queue on **Pull requests** and **Work**. The overview links to them
rather than repeating them.

People with a [role](/guides/access-and-roles/) on its repository see all
of it; anyone else sees what the project shares publicly: production, its
checks, who is working on it, its deployments and About.

The production card's header keeps **Visit**, deployment history, and
deployment settings together, with management controls shown according to
your permissions. Hosted projects also offer **Redeploy** there. **Instant
rollback** is marked **Soon** and disabled; it does not change production.

| Part | What it shows |
| --- | --- |
| **What it is** | A badge, such as **App, deploys itself** or **Library**, beside its homepage and docs. People who can change its settings open the badge to change [what it is](#what-a-project-is) in one click. |
| **Production** | [Production's picture](#productions-picture), which opens the live site, beside the rest. For an app [hosted on g1t.page](/guides/deployments/): its address, the commit it runs and when it went up; **Visit** and **Redeploy**. For an app that deploys itself: production's address and **Visit**, with its latest reported production deployment (and the workflow run that made it, when g1t Actions did) or the default branch's latest commit. For an app nobody has placed yet: one question, where it runs. |
| **Packages** | For a library or a tool, in place of Production: the packages its repository publishes, each with its latest version and how to install it, or how to publish a first one. |
| **Documentation**, **Homepage** | For docs, where they are read; for anything else, its homepage. |
| **Facts** | Under production: its latest release (or, where the card does not already say it, production's state), how often checks pass, and either how many changes pass on the first try and what is open, or, for people with a role when [Observability](/guides/observability/) has data, requests and the error rate over the last day with how many errors are open. |
| **Code** | One line to the repository: its name, default branch and when it was last pushed to, linking to **Code**. |
| **Needs you** | For someone signed in: what is waiting on them, such as a failed production build or a pull request to merge or review. |
| **Live now** | The people and coding agents working on it: each work item with its [claims and sessions](/guides/sessions/), the harness each came from and who it acts for, and sessions on no work item yet. **Sessions** has everything. With nobody working, people with a role see how to [connect a coding agent](/guides/bring-your-own-agent/). |
| **Previews** | For people with a role: the pull requests' previews that are up. |
| **Deployments** | Each environment's latest deployment and when. |
| **Observability** | For people with a role, when there is data: the last day's requests, an hour a bar, latency, and the newest open errors. |
| **About** | Its description, its [links](#links), what it is, and its latest release (its newest tag). People who can change its settings edit the description and links from here. |
| **Health** | For people with a role, its recent builds; and its open work items by age. |

### Production's picture

The production card always has a picture of the app, wherever it runs.
It is the first of these there is:

1. **A screenshot of production.** For an app hosted on g1t.page, g1t takes
   one each time production goes live (see
   [the production screenshot](/guides/deployments/#the-production-screenshot));
   people with a role on the repository see it, like the rest of its
   deployments. For an app that deploys itself, g1t takes one of
   production's address: the address its latest production deployment
   reported to g1t gives, or else the one set for it under **What it is**.
   Anyone who can see the project sees it.
2. **An image someone uploaded**, under **Settings** → **General** →
   **Production image**.
3. **A plain frame** with production's address. People who can change
   the project's settings see **Add an image of your app** on it, which
   opens **Production image**.

A screenshot of an app that deploys itself is taken:

- when its address is set or changed;
- when a production deployment of it is reported to g1t and succeeds,
  through the [API](/guides/deployments/) or by a workflow job with an
  `environment:`;
- otherwise about once a day, when the one kept is a day old. Opening the
  overview after that also takes a new one, in the background, while the
  old one shows.

g1t waits up to 12 seconds for the page to settle, as a 1280 by 800
browser window sees it, then takes it as it is. Only public `http` and
`https` addresses on their usual ports are visited: an address on a
private network, a loopback or link-local address, or one of g1t's own
service addresses (other than `g1t.sh` itself) gets the uploaded image
or the frame instead. Screenshots are not charged.

#### Uploading an image

**Production image** takes a PNG, JPEG or WebP of at most 5 MB; wide
images fit best, such as 1280 by 800. It is checked by its contents, not
its name, and served from g1t's user-content address
(`g1tusercontent.com` on g1t.sh), never from the site itself. Its address
is made from its contents, so the card shows a new image as soon as it
is uploaded. Anyone with an image's address can open it, even for a
private project, so upload only what you would show.

- The uploaded image shows whenever there is no screenshot: before the
  first one, when one cannot be taken, or for an app with no production
  address.
- **Use the uploaded image instead of a screenshot** shows it in place of
  any screenshot. While it is on, g1t takes no screenshots of an app
  that deploys itself.
- **Remove** takes it away; the card goes back to the screenshot or the
  frame.

Anyone who can change the project's settings (the **Maintain** role on
its repository and up, as for production's address) can upload, replace
or remove it.

## What a project is

A project is one of these, and its overview follows:

| What it is | Its overview shows |
| --- | --- |
| **App or site, hosted on g1t.page** | g1t builds and hosts it: production on g1t.page, with previews and domains. |
| **App or site that deploys itself** | Its own [workflows](/guides/deployments/#deploying-from-a-workflow) on g1t Actions, or another pipeline, deploy it to hosting of its own. Production at the address its deployments report or you give, with **Visit**. It is never asked to turn on Deployments; Deployment settings stay one link away. |
| **Library or package** | The packages its repository publishes and how to install them. |
| **Tool or CLI** | The same as a library: its packages and releases. |
| **Documentation** | Where its docs are read. Docs can be published on g1t.page too, by turning on Deployments. |
| **Something else** | Its homepage and links. |

Its **Deployments** page stays in the sidebar whatever it is.

### How g1t works it out

Until you say, g1t works it out for itself, in this order:

1. If [Deployments](/guides/deployments/) are on for the project, it is
   an app hosted on g1t.page.
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
**Deploy on g1t**, **It deploys itself** (with production's
address), or **It isn't deployed** (a library, a tool, documentation or
something else).

### Choosing it yourself

From the overview, open the badge beside its name, such as **App**, and
choose one. Or open **Settings**, then **General**, and under **What it
is** choose **Detect automatically**, which shows what was detected and
why, or one of the kinds above. **App or site that deploys itself** asks
for production's address.

Choosing a library, a tool or something else while Deployments are on is
refused: turn them off first under **Settings**, then **Deployments**;
g1t does not turn them off for you. While it is set that way, Deployments
cannot be turned on. Turning Deployments on for an app that deploys itself
makes it an app hosted on g1t.page.

Changing what it is needs the role that changes the project's settings.

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
| **General** | The project's name and description, its source, its **root directory**, [what it is](#what-a-project-is), its [links](#links), and its [production image](#uploading-an-image), and its danger zone: archive, [transfer](/guides/transferring-repositories/) and delete, which take its repository with it. Only projects have descriptions: a repository has none of its own, and search, link previews and lists of repositories show its project's. A fork's project starts with the description of the project it was forked from. |
| **Deployments** | Production, previews, build command, output directory and idle days. See [Deployments](/guides/deployments/#settings). |
| **Domains** | Custom domains for production. See [custom domains](/guides/deployments/#custom-domains). |
| **Guardrails** | How long g1t's checks, merge queue and merge checks may run here. See [guardrails](/guides/guardrails/). |
| **Repository** | The repository's name, website, [topics](/guides/search/#what-is-indexed) and default branch, and its danger zone: visibility, and detaching a fork. See [Managing a repository](/guides/managing-repositories/). |
| **Access** | Who has a [role](/guides/access-and-roles/) on the repository, and invitations. |
| **Branches and merging** | Auto-merge, the CODEOWNERS file's errors, and what the rules hold for the default branch. |
| **Rules** | [Rulesets](/guides/rules/): branch and tag protection, [required status checks](/guides/pull-requests/#required-status-checks), approvals and the merge queue, with Insights. |
| **Secrets and variables** | The project's rows. See [Secrets and variables](/guides/secrets-and-variables/). |
| **Runners** | The project's own [self-hosted runners](/guides/self-hosted-runners/). |
| **Webhooks** | The repository's [webhooks](/guides/webhooks/). |

The **root directory** says where in the repository the project lives,
such as `apps/web`. Builds run there. Leave it empty for the whole
repository.

Each tab needs a [role](/guides/access-and-roles/) on the project's
repository:

| Tab | Needs |
| --- | --- |
| **General**, **Dependencies**, **Branches and merging**, and on **Repository** its website and topics | Maintain |
| **Rules**, **Guardrails** | Admin |
| **Access**: seeing who has a role; changing it | Write; Admin |
| **Deployments**, **Domains**, **Secrets and variables**, **Runners**, **Webhooks** | Admin |
| On **Repository**: its name, default branch, and the danger zone (visibility); on **General**, archive | Admin |
| Transfer and delete | An owner of the workspace |

Someone without the role does not see the tab.

## Create a project

1. In the workspace the project belongs to, choose **New project** in the
   sidebar, or go to `g1t.sh/new`. It's made in the workspace you're in; to
   make one somewhere else, switch workspaces first.
2. Choose where its code comes from:
   - **Start empty**: a new repository on g1t.
   - **Import code**: copy a public repository from GitHub or any git host
     into a new one on g1t, with every branch and tag (up to 40 MB of
     history).
   - **Import from GitHub**: import repositories you can reach on GitHub,
     private ones too, with every branch and tag and, if you like, their
     issues, as work items. See [GitHub](/guides/github/).
3. Give it a name and say who can see it, then choose **Create project**.

Pushing a repository that does not exist yet makes one, and with it a
project:

```sh
git push https://g1t.sh/acme/my-app.git main
```

## Sources

A project's source is a repository hosted on g1t: one you pushed, or one
imported from GitHub or any git host. See
[GitHub](/guides/github/#import-a-repository).

Coming next:

- **Several projects on one repository**, each from its own root
  directory, with a push building only the projects it touched.

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

Its g1t.page deployment settings, on the `workflow` tool, are at
`GET` and `PATCH /workspaces/{workspace}/projects/{project}/deployments/settings`
(`get_deployment_settings`, `update_deployment_settings`): `enabled: true`
turns its deployments on. See [Turn on deployments](/guides/deployments/#without-the-site).

To say an app is deployed by your own pipeline, with its docs:

```sh
curl -X PATCH https://api.g1t.sh/workspaces/acme/projects/web \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"runs": "elsewhere", "production_url": "https://acme.dev", "docs_url": "https://docs.acme.dev"}'
```
