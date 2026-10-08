---
title: Audit log
description: Every action agents take with their run credentials, and every change people and tokens make, with whether it was allowed and the rule that decided.
---

Every workspace keeps an audit log. It records:

- **Everything an agent does** with its [run credentials](/guides/working-with-g1t/#credentials),
  reads included: every API and MCP call, every clone and fetch, every push.
- **Every change people and workspace tokens make** through the API, the
  MCP server and git: opening and closing issues, comments, merges,
  settings, pushes. Reads by people are not recorded.

- **A repository's lifecycle**, wherever the change was made, g1t.sh
  included. A transfer is recorded in both workspaces' logs, and a
  workspace's deletion as `workspace.deleted`. A restore by g1t's support
  is recorded as `workspace.restored`, and the purge 30 days after a
  deletion as `workspace.purged`, its log's last entry.

| Action | Recorded when |
| --- | --- |
| `repo.renamed` | A repository was renamed. |
| `repo.visibility_changed` | It was made public or private. |
| `repo.default_branch_changed` | Its default branch changed. |
| `branch.renamed` | A branch was renamed. |
| `repo.archived`, `repo.unarchived` | It was archived, or unarchived. |
| `repo.transferred` | It moved to another workspace. |
| `repo.deleted`, `repo.restored`, `repo.purged` | It was deleted, restored, or removed for good. |
| `repo.collaborator_added`, `repo.collaborator_role_changed`, `repo.collaborator_removed` | Someone was given a role on it, had it changed, or lost it. See [access and roles](/guides/access-and-roles/). |
| `repo.invitation_created`, `repo.invitation_revoked` | Someone was invited to it, or an invitation was withdrawn. |
| `workspace.base_permission_changed` | An owner changed what members get on every repository. |
| `workspace.team_creation_changed` | An owner changed who can create teams. See [who can create teams](/guides/teams/#who-can-create-teams). |
| `team.created`, `team.edited`, `team.deleted` | A [team](/guides/teams/) was created, changed or deleted. |
| `team.member_added`, `team.member_role_changed`, `team.member_removed` | Someone was added to a team, made its maintainer or a member, or taken out of it. |
| `team.repo_added`, `team.repo_role_changed`, `team.repo_removed` | A team was given a role on a repository, had it changed, or lost it. |
| `workspace.residency_changed` | An owner changed where the workspace's new repositories are stored. See [data residency](/guides/workspaces/#data-residency). |
| `workspace.deleted`, `workspace.restored`, `workspace.purged` | An owner deleted the workspace, g1t's support restored it, or it was removed for good. See [deleting a workspace](/guides/workspaces/#delete-a-workspace). |

Through the API and the MCP server, the call itself is recorded under its
operation's name too, such as `delete_repo`. See
[managing a repository](/guides/managing-repositories/).

Refusals are recorded too, with the rule that refused them. Entries are
only ever added: nothing edits or removes one.

## What an entry says

| Field | What it is |
| --- | --- |
| Time | When it happened, to the millisecond. |
| Actor | Who did it: a person, an agent, or a workspace token. |
| On behalf of | For an agent, the person it worked for: `g1t on behalf of syntaqx`. |
| Run | The agent run, with its kind: `implement`, `review`, `update` and so on. |
| Credential | The id of the token used. |
| Action | The API or MCP operation, such as `create_issue`, or `git.push` and `git.fetch`. |
| Target | The repository, the issue or pull request number, and for git the refs it moved. |
| Outcome | `allowed` or `denied`. |
| Rule | What decided it: the run's scope, such as `run:implement/tools`; a refusal rule, such as `scope:repository`; or, for people, their own access. A refusal by the repository's own rules is `service` (or `repository` for git). |
| Result | `ok`, or the reason it failed. |
| Request id | The request's id, the same one Cloudflare logs it under. |

The rules that refuse an agent are listed under
[credentials](/guides/working-with-g1t/#credentials).

## Read the log

Open the workspace's settings and choose **Audit log**, or go to
`g1t.sh/<workspace>/-/audit`.

- **Owners** see everything in the workspace.
- **Members** see what was done to the workspace's projects, and anything
  they did, or had done on their behalf. Changes owners made to the
  workspace itself are for owners.

Filter by actor (a person matches what they did and what agents did for
them), agent, action, project, outcome, who acted, and a range of days.
The filters are part of the page's address, so a filtered view can be
shared with anyone who can see it.

Each agent run's page has a **What it did** section listing its entries in
order, and a pull request's **Agent** panel shows the latest of what its
runs did. Both link to the full log, filtered to the run.

## How long it is kept

How far back the log goes depends on the workspace's plan:

| Workspace | Kept |
| --- | --- |
| Free | **7 days** |
| On the [g1t plan](/guides/usage-and-billing/#the-g1t-plan) | **90 days** |
| Paid for by an [enterprise](/guides/usage-and-billing/#enterprises-and-custom-terms) | **90 days** |
| Longer, by arrangement | Up to **400 days** |

The log can be read and exported back that far, and no further. Once a
day, entries older than that are **deleted**, and cannot be brought back:
export what you need to keep before then. Starting the plan keeps 90 days
from then on; entries already deleted stay deleted. Ending it goes back to
7 days, and the next daily pass deletes what is older.

For a longer log, such as for a compliance requirement, email
[support@g1t.sh](mailto:support@g1t.sh). g1t can set the workspace's
account to keep up to 400 days, and what is set there takes the place of
the plan's. A [self-hosted](/guides/self-hosting/) g1t that does not charge
keeps 90 days for every workspace.

## Export

**CSV** and **JSON** on the Audit log page download what the current
filters match, up to 10,000 entries, newest first. The CSV has one column
for each field above; a cell that a spreadsheet would read as a formula is
written as text.

## What is not recorded

- Reads by people and workspace tokens.
- What people do on the website itself. The API, the MCP server and git
  are recorded.
- What g1t does on its own, such as closing a pull request whose agent
  failed. Those changes are in the pull request's timeline.
