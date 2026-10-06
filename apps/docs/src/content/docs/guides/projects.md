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
| **Overview** | `g1t.sh/<workspace>/<project>` | Production with a screenshot, the steps left to get to production, what is in progress, active branches, live previews, recent builds, and the source. See [the overview](#the-overview). |
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
| **Production** | A screenshot of the live site, which opens it; its address, the commit it runs and when it went up; **Visit** and **Redeploy**. See [the production screenshot](/guides/deployments/#the-production-screenshot). |
| **Get to production** | The checklist below, until every step is done or you dismiss it. |
| **Right now** | Agents at work, and open pull requests moving from working to landed. |
| **Needs you** | What is waiting on a person: a failed production build, a pull request to merge or review, a stuck run. |
| **Active branches** | Branches other than the default, newest first. See [active branches](#active-branches). |
| **Recent changes**, **Activity**, **Previews** | What landed, everything that happened, and the previews that are up. |
| **Health**, **Dependencies**, **Clone** | How often checks pass, recent builds and open issues by age; what it uses and what uses it; the clone address. |

### Get to production

People with a role on its repository see a card that counts what the project has done towards
production, such as **3/6**. Each step is worked out from the project
itself, and each links to where you do it:

| Step | Done when | Links to |
| --- | --- | --- |
| Connect a source or push code | The default branch has a commit, or the source is a mirror. | **Code**, which shows how to push, or how to have your coding agent start the project. |
| Deploy to production | A production build has gone live. | Deployments settings, or **Deployments** once they are on. |
| Add a custom domain | The project has a [custom domain](/guides/deployments/#custom-domains). | Domain settings. |
| Open a preview | A branch or pull request has had a [preview](/guides/deployments/#previews-of-branches). | A new pull request. |
| Set up repository instructions | `AGENTS.md` or `CLAUDE.md` is at the root of the default branch. | The instructions on the **Agents** page. See [repository instructions](/guides/g1t-agents/#repository-instructions). |
| Assign a first issue to g1t-agent | g1t-agent has had a run, a pull request or an issue here. | A new issue. |

The card goes away when every step is done. To hide it sooner, choose
**×** on it. That hides it for this project in this browser only.

### Active branches

Up to five branches other than the default, the most recently changed
first. Each shows its last commit and who made it, how many commits it is
ahead of the default branch and behind it, and its open pull request,
with its checks, and preview, if it has them. A branch with no pull
request links to opening one.

Ahead and behind are counted from the last 40 commits of the branch and
the last 120 of the default branch. A count that runs past that shows as
`40+`. Ten branches are read, those with open pull requests first; a
project with more says how many it has.

## Settings

A project's **Settings** has a tab for each part:

| Tab | What it holds |
| --- | --- |
| **General** | The project's name and description, its source, and its **root directory**. A project shows its repository's description, and follows it as it changes, until you give the project one of its own; **Use the repository's description** goes back. |
| **Deployments** | Production, previews, build command, output directory and idle days. See [Deployments](/guides/deployments/#settings). |
| **Domains** | Custom domains for production. See [custom domains](/guides/deployments/#custom-domains). |
| **Dependencies** | The projects this one uses, and the ones that use it. See [Dependencies](#dependencies). |
| **Agents** | How g1t's agents pick up work here, and what they read first. |
| **Guardrails** | What agents may reach, run and spend while they work here. See [guardrails](/guides/guardrails/). |
| **Repository** | The repository's name, description, website, [topics](/guides/search/#what-is-indexed) and default branch, and its danger zone: visibility, archive, transfer and delete. See [Managing a repository](/guides/managing-repositories/). |
| **Access** | Who has a [role](/guides/access-and-roles/) on the repository, and invitations. |
| **Branches and merging** | Branch protection, [required status checks](/guides/pull-requests/#required-status-checks), required approvals, the merge queue, auto-merge and how g1t's agents review. |
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
| **General**, **Dependencies**, **Agents**, and on **Repository** its description, website and topics | Maintain |
| **Branches and merging**, **Guardrails** | Maintain |
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
     into a new one on g1t.
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
