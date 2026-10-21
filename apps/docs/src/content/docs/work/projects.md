---
title: Projects
description: Give a body of work a home in Work, with its brief, lead and people, its work items, the repositories it lands in, its dates and how it is going.
---

A project is a home for a body of work with an outcome: a release, a
redesign, a migration. It holds the brief people and agents work from, a
lead and its people, the work items toward it, the repositories its work
lands in, its dates and its health. How far along it is comes from the
record, never from someone typing a status.

A work item is in one project or none. Use [labels](/work/labels/) for
themes that cut across projects, and [milestones](/work/milestones/) for
dated goals; a project's home shows the milestones its work items are in.

Projects are Work's. What Code calls a project is a repository: its
**Projects** in Code's sidebar are repositories, and have nothing to do
with these.

## Find projects

**Projects** in Work's sidebar lists the projects under way, active ones
first, then those being shaped and those paused, each with a dot for its
health. **All projects** opens the projects page, at
`g1t.sh/<workspace>/-/work/projects`: every project as a card with its
health, state, summary, how much of its work is done, its lead and how long
is left before its target date. Done and dropped projects are listed under
them, and archived ones on the **Archived** tab.

## Make a project

1. In Work's sidebar, under **Projects**, choose **New project** (or **New
   project** on the projects page).
2. Give it a name, and if you like an icon (an emoji), a one-line summary
   and a color.
3. Choose its state, its lead (you, unless you choose someone), its start
   and target dates, and its appetite: how much the work is worth.
4. Choose **Create project**. Its home opens.

Making and changing a project needs the Write role in the workspace, the
same as [milestones](/work/milestones/). Its address is
`g1t.sh/<workspace>/-/work/projects/<slug>`; the slug is made from its name
and is unique in the workspace.

| Field        | Is                                                                                      |
| ------------ | --------------------------------------------------------------------------------------- |
| State        | **Shaping** (its brief is not settled), **Active**, **Paused**, **Done** or **Dropped** |
| Lead         | The person responsible for it. They are in its people, marked **Lead**                  |
| Start/target | The days it starts and should be done. The target can't be before the start             |
| Appetite     | Small, medium or large: what the work is worth, not a guess at how long it takes        |
| Health       | **On track**, **At risk** or **Off track**, as its lead says. None until someone does   |

## A project's home

A project's page has two tabs, **Overview** and **Items**. Its header
shows its name, state, lead, dates and how long is left, and its health:
whoever has the Write role changes the health from the menu there. **New
work item** files one into the project; **Edit** changes its fields; the
**⋯** menu archives it.

**Overview** shows:

- **Brief**: the pitch, in Markdown. Write the problem, the appetite, the
  solution, the rabbit holes and what is out. **Edit brief** changes it in
  place.
- **Now in this project**: its work items in the plan's
  [Now](/work/plan/), in the plan's order, each with where it is on its
  hill, then how many more are open in Next, Later and Triage.
- **Progress**: how many of its work items are done, how far through its
  dates it is, and every open work item as a dot on one hill. Where each
  sits is read from its record, as Now's hill is: **Figuring it out**
  (nothing decided), **Decided** (a decision recorded), **Building** (a
  draft pull request or commits) and **Landing** (a pull request in review,
  merged, or landed in some of its targets). Point at a dot to see which
  work item it is; select it to open it.
- **Milestones**: the workspace milestones its work items are in, each
  counting only this project's.
- **People** and **Repositories**: add and take them off here.

**Items** is the [Work list](/work/#the-work-list) of the project's work
items alone, with the same filters, kept in the address.

## Put work items in a project

- **Filing one**: choose the project in **Project** on the new work item
  form. **New work item** on a project's page starts with it chosen.
- **Moving one**: **Project** in the work item page's sidebar puts it in
  another project, or takes it out.

Either needs the Triage role on the work item, as a milestone does, and
an archived project takes no new work items. A move is noted in the work
item's conversation.

A project's repositories each say whether they are a **default target**.
A work item filed into the project with no targets of its own is linked
to every default target the person filing it can see, so its work is
meant to land there.

The [Work list](/work/#the-work-list) filters by project too:
`?project=<slug>`, or `project:<slug>` in `?q=`.

## Archive a project

**Archive project**, in the **⋯** menu on its page, takes it out of the
lists and the sidebar. Its work items stay in it, and its page still
opens; **Bring it back** undoes it.

## From the CLI

```sh
g1t project list
g1t project create --name "Work overhaul" --summary "Plan, track and ship" --target-on 2026-12-12 --add-repo flagon-io/g1t
g1t project view work-overhaul
g1t project edit work-overhaul --health at-risk --add-member ana
g1t work new --title "Cycles migration" --project work-overhaul
g1t work edit 318 --project work-overhaul
g1t work list --project work-overhaul
```

See the [CLI reference](/reference/cli/#g1t-project-list).

## From the API

| To                       | REST                                                                        | MCP                                 |
| ------------------------ | --------------------------------------------------------------------------- | ----------------------------------- |
| List projects            | `GET /workspaces/{workspace}/work/projects`, `state` or `archived`          | `work_item` `list_projects`         |
| Get one, with its home   | `GET /workspaces/{workspace}/work/projects/{project}`                       | `work_item` `get_project`           |
| Make one                 | `POST /workspaces/{workspace}/work/projects`                                | `work_item` `create_project`        |
| Change one               | `PATCH /workspaces/{workspace}/work/projects/{project}`                     | `work_item` `update_project`        |
| Archive or bring it back | `POST /workspaces/{workspace}/work/projects/{project}/archive`              | `work_item` `archive_project`       |
| Add someone, or a lead   | `PUT /workspaces/{workspace}/work/projects/{project}/members/{username}`    | `work_item` `add_project_member`    |
| Take someone out         | `DELETE /workspaces/{workspace}/work/projects/{project}/members/{username}` | `work_item` `remove_project_member` |
| Add a repository         | `POST /workspaces/{workspace}/work/projects/{project}/repos`                | `work_item` `add_project_repo`      |
| Take a repository off    | `DELETE /workspaces/{workspace}/work/projects/{project}/repos?repo=…`       | `work_item` `remove_project_repo`   |

`{project}` is its slug. A project has `slug`, `name`, `icon`, `color`,
`summary`, `brief`, `instructions` (what agents are told for every work
item in it), `lead`, `state`, `appetite`, `start_on`, `target_on`,
`health`, `open_items`, `closed_items` and `member_count`. On a change, an
empty string clears `icon`, `lead`, `start_on` and `target_on`, and `null`
clears `appetite` and `health`.

```sh
curl -X POST https://api.g1t.sh/workspaces/acme/work/projects \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Work overhaul", "target_on": "2026-12-12"}'
```

`project`, a project's slug, files a work item into it on
`POST /workspaces/{workspace}/work` and moves it on
`PATCH /workspaces/{workspace}/work/{number}` (`null` or `""` takes it
out). Every work item says the `project` it is in, and
`GET /workspaces/{workspace}/work?project=<slug>` lists one project's.
Reading projects needs `work:read`; changing them, `work:write`.
