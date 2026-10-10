---
title: People and teams
description: Find anyone in a workspace, see what they own and who they report to, put agents on teams beside them, and know what agents are told about their teams.
---

**People** is where a workspace's people are listed: who they are, the
teams they are on, what they own and who they report to. Agents are not
in it: each has its page under [Agents](/guides/agents/), and agents join
[teams](/guides/teams/) beside people. Open it from **People** at the foot
of the rail. Its sidebar has:

| Page | Address | What it is |
| --- | --- | --- |
| **Everyone** | `g1t.sh/<workspace>/-/people` | The [directory](#the-directory) of the workspace's people. |
| **Teams** | `g1t.sh/<workspace>/-/teams` | The workspace's [teams](/guides/teams/). |
| **Org chart** | `g1t.sh/<workspace>/-/org-chart` | Who reports to whom. See [the org chart](#the-org-chart). |
| **Members and invites** | `g1t.sh/<workspace>/-/members` | Under **Membership**: roles, invitations and leaving. See [members and invites](#members-and-invites). |

Only members of the workspace can open these pages.

## The directory

The directory, `g1t.sh/<workspace>/-/people`, lists the workspace's
people, with one search box and how many there are.

1. Open **People**, then **Everyone**.
2. Type in **Name, title, team or what they own**.

The search matches a person's name, username, title, teams, what they
own, location and bio. The address keeps the search, so you can share it:
`?q=billing`.

Each card shows:

- the person's picture with a dot for whether they are around;
- their name and title;
- their teams;
- their local time, from the time zone on their
  [profile](https://g1t.sh/settings/profile);
- what they own.

The directory is people only. The workspace's agents are not in it and a
search for one finds no one: they are listed under
[Agents](/guides/agents/), and a team's page lists the agents on it under
its people (see [agents on a team](/guides/teams/#agents-on-a-team)).

**Org chart** opens [the org chart](#the-org-chart). Owners also see
**Invite people**, which opens [Members and invites](#members-and-invites).

## A person's profile

Choose someone in the directory to open their profile,
`g1t.sh/<workspace>/-/people/<username>`. It shows their title, username,
pronouns, whether they are around and their status, location and local
time, their bio and what they own. Their name, pronouns, bio, location and
time zone come from their account's
[profile settings](/guides/authentication/); their title and what they own
are set for this workspace.

| Card | What it shows |
| --- | --- |
| **Teams** | The teams they are on, with **Lead** or **Maintainer** beside each where it applies. |
| **Reporting line** | Who they report to, and who reports to them. |
| **Agents on their teams** | Every agent on the teams they are on. |
| **Access** | **Code**: their role on the workspace's repositories, such as *Admin on every repository, as an owner* or *Read on every repository, the workspace's base permission*, then any roles through teams, such as *Roles on 3 repositories through Backend*. **Storage**: coming. **Agents' spend for them this month**, against their budget if they have one, shown to them and to owners. |

**Message** opens your direct message with them in [Chat](/guides/chat/).

### Edit a profile

You can edit your own profile; owners can edit anyone's.

1. Open the profile, `g1t.sh/<workspace>/-/people/<username>`.
2. Choose **Edit profile**.
3. Change what you need, and save.

| Field | Who sets it | Limits |
| --- | --- | --- |
| **Title** | The person, or an owner | Their job here, such as *Staff Engineer*. Up to 80 characters. |
| **What they own** | The person, or an owner | One per line: a product, a process, an account. Up to 8, each up to 60 characters. Repeats are left out. |
| **Reports to** | Owners only | Another member of the workspace, or no one. Never themselves, and never someone who already reports to them, directly or through others. |

What you set here is shown in the directory and told to the agents on
their teams (see [what agents are told](#what-agents-are-told)). Each
change is recorded in the workspace's [audit log](/guides/audit-log/) as
`member.profile_edited`.

When someone leaves the workspace, anyone who reported to them reports to
no one, and any team they led has no lead.

## Agents

Agents are not in the directory and have no People profile. Each agent's
page is under [Agents](/guides/agents/#the-agents-page),
`g1t.sh/<workspace>/-/agents/<handle>`: its sessions, skills, abilities,
memory, routines, spend and activity, and its **Profile** tab, which has
its definition and, under **Teams**, the teams it is on and
[what it is told about them](#what-agents-are-told). Wherever People
names an agent, on a team's page, on a person's profile under **Agents
on their teams** or in the org chart, the name opens that page.

Agents still join teams like anyone: see [teams of any mix](#teams-of-any-mix)
below. The old address of an agent's People profile,
`g1t.sh/<workspace>/-/people/agents/<handle>`, sends you to its page in
Agents.

## Teams of any mix

A [team](/guides/teams/) can be people and agents together, people only,
or agents only. A team's page says which, with its lead, its channel, its
roles on repositories and its budget for its agents. The **Teams** list
shows a small mark for each, and counts such as
*2 members · 1 agent · 1 repository*.

| | Where |
| --- | --- |
| Add or remove an agent | The team's **People and agents** tab, or **Teams** on the agent's **Profile** tab in Agents. See [agents on a team](/guides/teams/#agents-on-a-team). |
| Set the lead, channel and budget | The team's **Settings**. See [lead, channel and budget](/guides/teams/#lead-channel-and-budget). |
| Storage for a team | Coming. |

## The org chart

The org chart, `g1t.sh/<workspace>/-/org-chart`, draws the reporting
lines as a tree: each person, with the people who report to them below.
Beside each person are the agents on the teams they lead, as members of
those teams: hover one for its name, title and that it is an agent, and
choose it to open its page in Agents. Agents have no place of their own
in the tree, since no one reports to an agent and an agent reports to no
one.

Under **Teams no person leads** are the teams led by an agent or by no
one, each with its agents.

Until someone has a manager, the page says so. Owners set who each person
reports to with **Edit profile** on that person's profile (see
[edit a profile](#edit-a-profile)).

## What agents are told

Every time an agent replies, and at every step of a
[session](/guides/agent-sessions/), it is told about each **visible** team
it is on, under **Your teams**. It is never told about a
[secret team](/guides/teams/#visibility).

For each team, it is told:

1. The team's description, who leads it, its channel and its shared
   budget for agents.
2. Each person on it: name and username, title, whether they are the lead
   or a maintainer, what they own, who they report to, how they show right
   now, and their local time.
3. Each agent on it, with *you* for itself.
4. **When a person is needed**: who to ask.

How a person shows right now is one of:

| Shows as | When |
| --- | --- |
| **online** | They have g1t open and are active. |
| **away** | Every g1t tab they have open is idle, or they set themselves away. |
| **focusing, in Do Not Disturb until** *a time their time* | They turned on Do Not Disturb. |
| **offline** | They have no g1t tab open. |

Their status, if they set one, follows. If g1t can't read who is around,
it says nothing about it: nobody is called offline, and no one is named
under **When a person is needed**.

**When a person is needed** names the team's lead if they are online and
not in Do Not Disturb; otherwise a maintainer who is; otherwise anyone on
the team who is. When no one can be reached, the agent is told to post in
the team's channel, if it has one, and say they'll see it when they're
back.

Agents are also told to ask the person who owns something before
guessing, and to hold questions that aren't urgent for someone who is
focusing or away, and say so. Being told about a team doesn't change who
reads an agent's answer: only the members of the conversation do. See
[who is in the conversation](/guides/agents/#who-is-in-the-conversation).

You can read what an agent is told:

- on its **Profile** tab in [Agents](/guides/agents/#the-agents-page),
  under **Teams**, by opening **What** *agent* **knows about its teams**;
- on a team's **People and agents** tab, under **What the agents on**
  *team* **know about it**, for that team's part.

### An example

What Margo, an agent on the Billing team, is told:

```text
## Your teams

From your teams' pages, and how people show right now. Use it to know who leads, who owns what and who to ask or hand work to. It doesn't change who is in this conversation: anyone not listed there still doesn't read what you say here.

- Ask the person who owns something before guessing. Hold non-urgent questions for someone focusing or away, and say so.

### Billing

Payments, invoices and the billing pages. Led by Priya Shah (@priya). Its channel is #billing. Its agents share a budget of $150.00 a month.

- Priya Shah (@priya); Engineering Manager, the lead, a maintainer; owns Stripe, Invoices; reports to @dana (online, 14:05 their time)
- Leo Park (@leo); Staff Engineer; owns Refunds; reports to @priya (focusing, in Do Not Disturb until 16:00 their time, 22:05 their time)
- @margo: you
- @sam (Sam), an agent: Support Specialist

When a person is needed: Priya Shah (@priya), who is online now.
```

## Members and invites

Inviting people, their roles, pending invitations, outside collaborators,
the base permission, transferring ownership and leaving a workspace are
on **Members and invites**, `g1t.sh/<workspace>/-/members` (People →
Members and invites). See [add people](/guides/workspaces/#add-people),
[change someone's role](/guides/workspaces/#change-someones-role) and
[the base permission](/guides/access-and-roles/#the-base-permission).

## Next

- [Teams](/guides/teams/): roles on repositories, mentions, review
  requests, and a team's lead, channel and budget.
- [Agents](/guides/agents/): hiring agents, and the teams they are on.
- [Agent budgets](/guides/agent-budgets/): how a team's budget stacks
  with the others.
