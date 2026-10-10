---
title: Teams
description: Group a workspace's people and agents into teams, give a team a lead, a channel and a budget for its agents, give a team a role on repositories, mention it with @workspace/team, and ask it to review pull requests, with review assignment picking who.
---

A **team** is a group of a workspace's people and agents, in any mix:
people and agents together, people only, or agents only. Instead of
giving each person a role on each repository, you give the team a role,
and everyone in it has it. A team can have a lead, a channel and a
monthly budget for its agents, and every agent on it is told who is on
the team, who leads it and who owns what. A team is also a name you can use in conversation: mention
`@acme/backend` in a comment and everyone in it hears of it, or ask it to
review a pull request and it decides who looks.

Only members of a workspace, and its own agents, can be in its teams.
Someone who leaves the workspace leaves all of its teams with it.

For the workspace's directory, profiles and org chart, see
[people and teams](/guides/people-and-teams/).

## Create a team

Any member of the workspace with a confirmed email address can create a
team, and becomes its first maintainer, unless an owner has set
[who can create teams](#who-can-create-teams) to owners only.

1. Open **Teams** in the sidebar: `g1t.sh/<workspace>/-/teams`.
2. Choose **New team**, or go to `g1t.sh/<workspace>/-/teams/new`. The
   **+** menu in the top bar has **New team** too, for the workspace the
   sidebar is on.
3. Give it a **name**, such as `Backend`. Its **slug**, the name used in
   addresses and mentions, is made from the name (`backend`); you can
   change it.
4. Optionally, add a **description**, choose its **visibility**, pick a
   **parent** team, and add **members**.
5. Choose **Create team**.

The team's page is `g1t.sh/<workspace>/-/teams/<team>`, and it is
mentioned as `@<workspace>/<team>`.

| Field | Limits |
| --- | --- |
| Name | Up to 80 characters. |
| Slug | 1 to 60 lowercase letters, digits and single hyphens, not starting or ending with a hyphen. Unique in the workspace. `Web & Mobile` becomes `web-mobile`. |
| Description | Up to 280 characters. |
| Teams in one workspace | Up to 500. |

The **Teams** page lists the teams you can see, yours first, then by
name, with a search box that matches names and slugs. Each team shows a
small mark for what it is made of, and counts such as
*2 members · 1 agent · 1 repository*. A person's teams also show on
their card in the [People directory](/guides/people-and-teams/#the-directory)
and on their profile.

### Who can create teams

An owner chooses who can create the workspace's teams, under **Settings**,
**General**, **Teams**:

| Who can create teams | |
| --- | --- |
| **Any member** | Every member with a confirmed email address. The default. |
| **Owners only** | Only the workspace's owners. Members see **Only owners can create teams in this workspace.** on the Teams page instead of **New team**, and **New team** in the **+** menu is greyed out. |

Teams that already exist stay as they are, and their maintainers still
manage them. The change is recorded in the [audit log](/guides/audit-log/)
as `workspace.team_creation_changed`.

Through the API, set `team_creation` to `members` or `owners` with
[`PATCH /workspaces/{workspace}`](/reference/api/workspaces/update-workspace/)
(the `workspace` tool's `update` action over MCP); the workspace you get
back, and [`GET /workspaces/{workspace}`](/reference/api/workspaces/get-workspace/),
include it. Creating a team when you may not is refused with `403`.

## Visibility

| Visibility | Who can see it, mention it and ask it to review |
| --- | --- |
| **Visible** | Every member of the workspace. The default. |
| **Secret** | Its own people and the workspace's owners. To anyone else it does not exist. |

Secret teams cannot be nested: a secret team has no parent and no child
teams. To make a nested team secret, first take it out from under its
parent and move its child teams elsewhere.

## Maintainers and members

Each person in a team is a **maintainer** or a **member**. Maintainers
look after the team; owners of the workspace can do everything a
maintainer can on every team, whether or not they are in it.

| | Who |
| --- | --- |
| See a visible team | Every member of the workspace |
| See a secret team | Its own people and the workspace's owners |
| Create a team | Any member. Under a parent: an owner, or a maintainer of the parent |
| Add and remove people, make someone a maintainer | Owners, and the team's maintainers |
| Add and remove agents | Owners, and the team's maintainers |
| Set its lead, channel and budget | Owners, and the team's maintainers |
| Change its name, slug, description, visibility, notifications and review assignment | Owners, and the team's maintainers |
| Move it under another team | Owners, or someone who maintains both teams |
| Delete it | Owners, and the team's maintainers |
| Give it a role on a repository | Anyone with the Admin [role](/guides/access-and-roles/) on that repository |
| Take its role on a repository away | Admin on that repository, owners, and the team's maintainers |
| Leave it | Anyone in it |

Changing a team is for people, signed in or with a personal access token,
with a confirmed email address. An agent's token or a workspace's token
cannot change one.

To manage the people in a team:

1. Open the team, `g1t.sh/<workspace>/-/teams/<team>`. **People and
   agents** is its first tab.
2. Add someone by username. They must already be a member of the
   workspace.
3. Beside a person, choose **Make maintainer** (or **Make member**), or
   **Remove**. Beside yourself, **Leave**.

Turn on **Include the people of child teams** to also list the people of its
[child teams](#nesting), each with the child team they are in.

## Agents on a team

The **People and agents** tab lists the team's **Agents** under its
people. An agent is on a team in one of two ways:

| How | Badge | |
| --- | --- | --- |
| **Its home team** | **Home team** | The team its own profile names under **Team** (see [title, team and responsibilities](/guides/agents/#title-team-and-responsibilities)). To take it off, change its profile. |
| **Added** | None | A maintainer or an owner added it from the team's page. An agent can be on any number of teams this way. |

To add or remove an agent:

1. Open the team's **People and agents** tab,
   `g1t.sh/<workspace>/-/teams/<team>`.
2. Under **Agents**, choose one of the workspace's agents in **Add an
   agent**, and **Add**.
3. To take an added agent off, choose **Remove** beside it. An agent
   whose home team it is has no **Remove**: change its profile instead.

An agent on a team works with the access of whoever asks it, not with the
team's roles on repositories. Being on a team tells the agent about it
(see [what agents on the team know](#what-agents-on-the-team-know)), and
its spend counts towards the team's [budget](#lead-channel-and-budget).

## Lead, channel and budget

A team's header shows what it is made of (such as *People only*, *Agents
only*, or *2 people and 1 agent*), **Led by**, its **#channel**,
**Code: N repositories** (its roles on repositories), **Storage**
(coming), and its budget: *$X of $Y this month*, what its agents spent
together against it.

A maintainer or an owner sets them under the team's **Settings**, **Lead,
channel and budget**:

| Setting | What it is |
| --- | --- |
| **Lead** | Someone on the team: a person or an agent. Choosing an agent that is on the team only through its home team adds it to the team too. When a person is needed, the team's agents ask the lead first. |
| **Channel** | The team's channel in [Chat](/guides/chat/), by name. Leave it empty for none. |
| **Budget for its agents, a month** | In dollars, such as `150`. Empty or `0` for no team budget. At most $1,000,000. |
| **Storage level** | Coming. |

Taking the lead off the team, or out of the workspace, leaves the team
with no lead.

The **budget** caps what the team's agents, added and home team alike,
spend together in a calendar month (UTC). When they reach it, its agents
take no new work until the 1st, and say:

```text
Backend's agents have used the team's budget of $150.00 for this month. Someone who manages the team can raise it on its settings.
```

Each agent keeps its own budget too; the first limit reached stops the
work. See [how limits stack](/guides/agent-budgets/#how-limits-stack).

## What agents on the team know

Every agent on a visible team is told about it every time it replies and
at every session step: its description, lead, channel and budget, each
person with their title, what they own, who they report to, whether they
are around and their local time, and the team's other agents. The
**People and agents** tab shows the team's part of it, exactly as the
agents get it, under **What the agents on** *team* **know about it**.

Agents are never told about secret teams. See
[what agents are told](/guides/people-and-teams/#what-agents-are-told).

## Nesting

A team can have a **parent**. Choose one when you create it, or under the
team's **Settings**. A child team:

- **inherits its parent's roles on repositories**, and its parent's
  parent's, all the way up. Its own role on a repository counts too; the
  highest wins.
- **is reached by its parent's mentions and review requests.** Mentioning
  `@acme/engineering` tells the people of `@acme/backend` under it too, and
  asking `@acme/engineering` to review asks them too.

It never works the other way: a team's own people get nothing from its
child teams.

| Rule | |
| --- | --- |
| How deep | At most 8 levels: a team, its child, that child's child, and so on. |
| Secret teams | Cannot have a parent or child teams. |
| Cycles | A team cannot go under itself or one of its own child teams. |
| Deleting a parent | Its child teams move up to its own parent, or to the top if it had none. |

The **Child teams** tab, `g1t.sh/<workspace>/-/teams/<team>/teams`, lists
a team's children. To take a team out from under its parent, clear
**Parent** in its settings.

## Repository access

A team is given a role on a repository the way a person is, with the
same five [roles](/guides/access-and-roles/#the-roles). Everyone in the
team, and in its child teams, has that role there. A team has roles only on
its own workspace's repositories.

From the team:

1. Open the team's **Repositories** tab,
   `g1t.sh/<workspace>/-/teams/<team>/repositories`.
2. Choose a repository and a role, and **Add**.

Or from the repository: someone with Admin opens **Settings → Access**,
`g1t.sh/<workspace>/<repo>/settings/access`, and adds the team, with a role,
under **Teams with access**.

The **Repositories** tab lists the team's own roles and the ones it
inherits, each repository once at the highest role, naming the parent team
an inherited one comes from. Change a role by picking another, or
**Remove** it. A role a team inherits can only be changed on the parent
that gives it.

### How roles combine

Your role on a repository is the highest of everything that gives you one:
ownership, the base permission, roles given to you directly, and the roles
of every team you are in and of their parents. See
[how your role is worked out](/guides/access-and-roles/#how-your-role-is-worked-out).

For example, in a workspace whose base permission is **Read**:

| Where it comes from | Role on `acme/api` |
| --- | --- |
| Base permission | Read |
| `@acme/engineering`, a parent of `@acme/backend` | Write |
| `@acme/backend`, which Ana is in | Maintain |
| Given to Ana directly | Triage |
| **Ana's role** | **Maintain**, from `@acme/backend` |

The repository's **Settings → Access** lists **Teams with access**, each
with its role and how many people are in it, and shows for each person
where their role comes from, such as **Through team backend**. When two give
the same role, a role given directly is shown first, then a team's, so the
one shown is the one you would change.

Taking someone's direct role away leaves what their teams give them. To
take away what a team gives, remove the team's role, or remove the person
from the team.

## Mentions

Write `@<workspace>/<team>`, such as `@acme/backend`, in a comment, or in
the description of an issue or pull request when you open it, and the
people of that team and its child teams are told in their
[notifications](/guides/notifications/), with the reason `team_mention`:

```text
ana mentioned @acme/backend on acme/api#42
```

Comment boxes suggest teams as you type `@acme/`.

| | |
| --- | --- |
| Who is told | Everyone in the team and its child teams, but not whoever wrote it. |
| When | The team's **Notify the team when it is mentioned** setting is on (the default), and the writer can see the team: a member of its workspace, and for a secret team, in it or an owner. Otherwise nobody is told. |
| Not a mention | `@acme/backend` in code, in a quoted line (`>`), inside an address or a path such as `ops@acme/backend` or `@acme/backend/src`, or in a package name such as `@acme/backend@1`. |
| Subscribes them | Yes. Each person told is subscribed to the issue or pull request, as with a mention by name. |

Someone mentioned by name and through a team is told once, as `mention`.
People only see what is about repositories they can read.

To stop a team's mentions telling its people, a maintainer turns off
**Notify the team when it is mentioned** in the team's **Settings**. The team can still be
mentioned; the text links to it, and nobody is told.

## Review requests

A pull request can ask a team to review it. Add the team in the
**Reviewers** box on the pull request, as `@acme/backend`, or have a
[CODEOWNERS file](/guides/codeowners/) ask it. Asking needs what asking a
person needs: the Triage role or higher, or being the pull request's
author.

- Only teams of the repository's own workspace can be asked.
- A secret team can be asked only by its own people and owners.
- A pull request can ask up to 10 teams.

The team stays listed under **Reviewers** as requested. What happens next
depends on its **review assignment**:

| Review assignment | Who is asked |
| --- | --- |
| **Off** (the default) | Everyone in the team and its child teams is told, with the reason `review_requested`, never the pull request's author. Anyone in it can review. |
| **On** | g1t picks people from the team. Each one picked becomes a reviewer in their own right, listed under **Reviewers** beside the team, and is told. |

Removing a team from **Reviewers** takes the request away; people it
picked stay reviewers until you remove them too.

### Review assignment

A maintainer sets it in the team's **Settings**, under **Code review
assignment**:

| Setting | Default | What it does |
| --- | --- | --- |
| **Assign reviewers from the team** | Off | On: pick people instead of asking the whole team. |
| **How many people** | 1 | People to pick, 1 to 10. People from the team who are already reviewers count towards it. |
| **Who goes first** | Round robin | **Round robin** or **Load balance**. See below. |
| **Skip people who are busy** | Off | Leave out anyone with too many pull requests waiting on their review. Beside it, how many waiting pull requests makes someone busy, 1 to 100 (5 by default). |
| **Pick from child teams too** | Off | Also pick from the people of its child teams. |
| **Also tell the rest of the team** | Off | Also tell everyone else in the team when people are picked. |
| **Never pick** | None | Usernames never picked, up to 100. |

A pull request is **waiting on** someone when it is open or a draft, they
are one of its reviewers, and they have not yet approved it or asked for
changes.

g1t never picks the pull request's author (or, for a change g1t made, the
person who asked for it), g1t itself, anyone under **Never pick**, or
anyone already asked. The same facts always pick the same people: ties go
by username.

| Algorithm | Who goes first |
| --- | --- |
| **Round robin** | Whoever this team has had asked least recently. People it has never asked come first of all. Everyone is asked once before anyone is asked twice. |
| **Load balance** | Whoever has the fewest pull requests waiting on their review. Among equals, whoever this team asked least recently. |

For example, `@acme/backend` has five people:

| Person | Last asked by the team | Waiting on them |
| --- | --- | --- |
| ana | 5 October | 1 |
| bo | never | 4 |
| cy | 1 October | 0 |
| dee | 6 October | 0 |
| eve | never | 2 |

zed opens a pull request and asks `@acme/backend` to review it:

| Settings | Picked |
| --- | --- |
| Round robin, how many 1 | bo (never asked; first by name) |
| Round robin, how many 3 | bo, eve, cy |
| Load balance, how many 2 | cy, dee (nothing waiting; cy asked longer ago) |
| Round robin, how many 3, skip busy at 2 | cy, ana, dee (bo and eve are busy) |
| Round robin, how many 2, bo already a reviewer | eve (bo counts towards the 2) |
| Round robin, how many 3, opened by bo | eve, cy, ana (never the author) |

### On the pull request

The timeline records who asked whom: **ana requested a review from
@acme/backend**, and, when people are picked, **requested a review from
cy**. Notifications say **ana asked @acme/backend to review acme/api#42** to
the team's people, and **ana asked you to review acme/api#42** to each
person picked. A request made by a CODEOWNERS file reads **acme/api#42
changes files @acme/backend owns**.

## Settings

A team's **Settings**, `g1t.sh/<workspace>/-/teams/<team>/settings`, holds
its name, slug, description, visibility, parent, **Lead, channel and
budget**, **Notify the team when it is mentioned**, **Code review
assignment**, and **Delete team**.

Changing the slug changes how the team is mentioned and its address. A
CODEOWNERS file that names the old slug no longer resolves it, and shows an
error until you change the file.

Deleting a team takes away every role it gave on repositories, and its
child teams move up to its parent. Its people stay in the workspace.

## Through the API

Every route is in the [API reference](/reference/api/), and each is an
action of the `team` [MCP tool](/reference/mcp/). Reading teams needs the
`workspace:read` scope; changing them `workspace:admin`; giving or taking
a team's role on a repository `access:admin`.

| Route | MCP action | What it does |
| --- | --- | --- |
| `GET /workspaces/{workspace}/teams` | `list` | The teams you can see, yours first. `q` narrows by name or slug. |
| `POST /workspaces/{workspace}/teams` | `create` | Create a team. Body: `name`, and optionally `slug`, `description`, `visibility` (`visible` or `secret`), `parent` (a slug), `notify` and `members` (usernames). |
| `GET /workspaces/{workspace}/teams/{team}` | `get` | One team. |
| `PATCH /workspaces/{workspace}/teams/{team}` | `update` | Change what you give: `name`, `slug`, `description`, `visibility`, `parent` (`""` takes it out from under its parent), `notify`, `review_assignment`. |
| `DELETE /workspaces/{workspace}/teams/{team}` | `delete` | Delete a team. |
| `GET /workspaces/{workspace}/teams/{team}/members` | `list_members` | Its people. `include_child_teams=true` adds its child teams' people, each with `via`. |
| `PUT /workspaces/{workspace}/teams/{team}/members/{username}` | `set_member` | Add someone, or change their place. Body: `role`, `member` or `maintainer`. |
| `DELETE /workspaces/{workspace}/teams/{team}/members/{username}` | `remove_member` | Take someone out, or leave. |
| `GET /workspaces/{workspace}/teams/{team}/teams` | `list_child_teams` | Its child teams. |
| `GET /workspaces/{workspace}/teams/{team}/repos` | `list_repos` | The repositories it has a role on, its own and inherited (`inherited_from`). |
| `PUT /workspaces/{workspace}/teams/{team}/repos/{repo}` | `set_repo` | Give it a role on a repository, or change it. Body: `role`. |
| `DELETE /workspaces/{workspace}/teams/{team}/repos/{repo}` | `remove_repo` | Take its role away. |
| `PUT /workspaces/{workspace}/teams/{team}/review_assignment` | `set_review_assignment` | Set review assignment: `enabled`, `algorithm` (`round_robin` or `load_balance`), `count`, `skip_busy`, `busy_at`, `include_child_teams`, `excluded`, `notify_team`. |
| `GET /workspaces/{workspace}/members/{username}/teams` | `list_user_teams` | The teams someone is in, as you can see them. |

Asking a team to review is on the pull request: `POST
/repos/{owner}/{name}/pulls/{number}/requested_reviewers` with
`team_reviewers` (each as `workspace/team`, or the team's slug), and
`DELETE` on the same route to take a request away
(the `pull_request` tool's `request_reviewers` and
`remove_requested_reviewers` actions, with the `pull_requests:write`
scope). A pull request's `team_reviewers` lists the teams asked, as
`workspace/team`.

```sh
curl -X POST https://api.g1t.sh/workspaces/acme/teams \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Backend", "parent": "engineering", "members": ["ana", "cy"]}'
```

```json
{
  "id": "team_01m4a3k0q6e8pd9h2x7c5vbn1r",
  "workspace": "acme",
  "slug": "backend",
  "name": "Backend",
  "description": null,
  "visibility": "visible",
  "parent": { "slug": "engineering", "name": "Engineering" },
  "notify": true,
  "review_assignment": {
    "enabled": false,
    "algorithm": "round_robin",
    "count": 1,
    "skip_busy": false,
    "busy_at": 5,
    "include_child_teams": false,
    "excluded": [],
    "notify_team": false
  },
  "members_count": 3,
  "repos_count": 0,
  "child_teams_count": 0,
  "viewer_role": "maintainer",
  "can_manage": true,
  "created_at": "2026-10-07T15:04:11.208Z",
  "updated_at": "2026-10-07T15:04:11.208Z"
}
```

```sh
curl -X PUT https://api.g1t.sh/workspaces/acme/teams/backend/repos/api \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"role": "maintain"}'
```

## Webhooks and the audit log

Changes to a team are sent to the workspace's [webhooks](/guides/webhooks/).
The `team.repo_*` events are about a repository, so that repository's
webhooks get them too.

| Event | When |
| --- | --- |
| `team.created`, `team.edited`, `team.deleted` | A team was created, changed or deleted. On `team.edited`, `data.changes` names what changed, such as `name` or `parent`. |
| `team.member_added`, `team.member_role_changed`, `team.member_removed` | Someone joined or left a team, or became a maintainer or a member. `data.username`, `data.role`, `data.previous_role`. |
| `team.repo_added`, `team.repo_role_changed`, `team.repo_removed` | A team was given a role on a repository, had it changed, or lost it. `data.repo`, `data.repo_id`, `data.repo_role`, `data.previous_repo_role`. |

Each has `data.workspace`, `data.team_id`, `data.team` (its slug),
`data.name`, `data.visibility` and, for a child team, `data.parent`.

The workspace's [audit log](/guides/audit-log/) records the same changes
under the same names.
