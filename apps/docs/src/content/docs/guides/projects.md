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
| **Dependencies** | The projects this one uses, and the ones that use it. See [Dependencies](#dependencies). |
| **Secrets and variables** | The project's rows. See [Secrets and variables](/guides/secrets-and-variables/). |
| **Repository** | The repository's description, [topics](/guides/search/#what-is-indexed), visibility, branch protection, required approvals, checks, the merge queue and auto-merge. |
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
