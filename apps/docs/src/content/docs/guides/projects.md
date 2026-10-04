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

A workspace's page, `g1t.sh/<workspace>`, shows its projects first, each
with where it is deployed, its latest build, and its open issues and pull
requests. The sidebar lists them too.

## A project's pages

| Page | Address | |
| --- | --- | --- |
| **Overview** | `g1t.sh/<workspace>/<project>` | Production and its address, live previews, what is in progress, recent builds, and the source. |
| **Code** | `…/code` | The repository's files, commits and branches. |
| **Issues**, **Pull requests**, **Merge queue**, **Plan** | `…/issues` and so on | As they always were. |
| **Actions** | `…/actions` | [GitHub Actions workflows](/guides/actions/). |
| **Deployments** | `…/deployments` | What is up now and every build. |
| **Settings** | `…/settings` | See below. |

Every address that pointed into a repository before still works: the
project has the repository's name.

## Settings

A project's **Settings** has a tab for each part:

| Tab | What it holds |
| --- | --- |
| **General** | The project's name and description, its source, and its **root directory**. |
| **Deployments** | Production, previews, build command, output directory and idle days. See [Deployments](/guides/deployments/#settings). |
| **Secrets and variables** | The project's rows. See [Secrets and variables](/guides/secrets-and-variables/). |
| **Repository** | The repository's visibility, branch protection, required approvals, checks, the merge queue and auto-merge. |
| **Webhooks** | The repository's [webhooks](/guides/webhooks/). |

The **root directory** says where in the repository the project lives,
such as `apps/web`. Builds run there. Leave it empty for the whole
repository.

## Create a project

1. Choose **New project** in the sidebar, or go to `g1t.sh/new`.
2. Choose where its code comes from:
   - **Start empty**: a new repository on g1t.
   - **Import code**: copy a public repository from GitHub or any git host
     into a new one on g1t.
3. Give it a name and say who can see it, then choose **Create project**.

Pushing a repository that does not exist yet makes one, and with it a
project:

```sh
git push https://g1t.sh/acme/my-app.git main
```

## Sources

Today a project's source is a repository hosted on g1t. Coming next:

- **Mirrored from GitHub, GitLab or Bitbucket.** The code stays there; the
  project gets g1t's deployments, previews on its pull requests, secrets
  and agents.
- **Several projects on one repository**, each from its own root
  directory, with a push building only the projects it touched.
- **Dependencies between projects**: `web` uses `api`, so a preview of
  `web` can point at `api`'s preview, and an agent changing `api` knows
  what depends on it.

## From the API

Projects keep their repository's routes: `/repos/{workspace}/{project}/…`
reaches the project's repository, and its secrets and variables are the
project's. See the [API reference](/reference/api/).
