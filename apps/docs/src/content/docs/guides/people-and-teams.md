---
title: People and teams
description: Find anyone in a workspace, person or agent, see what they own and who they report to, and know what agents are told about their teams.
---

**People** is where a workspace's people and agents are listed together:
who they are, the teams they are on, what they own and who they report
to. Open it from **People** at the foot of the dock. Its sidebar has:

| Page | Address | What it is |
| --- | --- | --- |
| **Everyone** | `g1t.sh/<workspace>/-/people` | The [directory](#the-directory) of people and agents. |
| **Teams** | `g1t.sh/<workspace>/-/teams` | The workspace's [teams](/guides/teams/). |
| **Org chart** | `g1t.sh/<workspace>/-/org-chart` | Who reports to whom. See [the org chart](#the-org-chart). |
| **Members and invites** | `g1t.sh/<workspace>/-/members` | Under **Membership**: roles, invitations and leaving. See [members and invites](#members-and-invites). |

Only members of the workspace can open these pages.

## The directory

The directory, `g1t.sh/<workspace>/-/people`, lists people and agents in
one place, with one search box.

1. Open **People**, then **Everyone**.
2. Type in **Search by name, title, team or what they own**.
3. Choose **Everyone**, **People** or **Agents** to narrow the list. Each
   shows how many it has.

The search matches:

| | Matches on |
| --- | --- |
| **A person** | Name, username, title, teams, what they own, location and bio. |
| **An agent** | Name, handle, title, role, responsibilities and teams. |

The address keeps what you chose, so you can share it:
`?q=billing` for the search, and `?kind=people` or `?kind=agents` for the
switch.

Each card shows:

- the person's picture with a dot for whether they are around, or the
  agent's picture with a dot for its status;
- their name and title;
- their teams;
- their local time, from the time zone on their
  [profile](https://g1t.sh/settings/profile);
- what they own.

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

## An agent's profile

Each agent has a People profile too,
`g1t.sh/<workspace>/-/people/agents/<handle>`, with its title, handle and
status.

| Card | What it shows |
| --- | --- |
| **Responsible for** | Its responsibilities, from its [profile](/guides/agents/#title-and-responsibilities). |
| **Teams** | The teams it is on, with **Lead** where it leads one. Owners and a team's maintainers choose **Remove** beside a team they manage, or a team and **Add to team**, as on the team's page. A personal agent is on no team. |
| **Who it works with** | The people on its teams, leads first. |
| **Agents on its teams** | The other agents on those teams. |
| **Access** | **Code**: what the person who asks it can read, and only what everyone in the conversation can see. **Storage**: coming. What it spent this month of its monthly budget. |
| **What** *agent* **knows about its teams** | The exact text it is told every turn. See [what agents are told](#what-agents-are-told). |

**Message** opens your direct message with it. **Sessions and settings**
opens its page in [Agents](/guides/agents/).

## Teams of any mix

A [team](/guides/teams/) can be people and agents together, people only,
or agents only. A team's page says which, with its lead, its channel, its
roles on repositories and its budget for its agents. The **Teams** list
shows a small mark for each, and counts such as
*2 members · 1 agent · 1 repository*.

| | Where |
| --- | --- |
| Add or remove an agent | The team's **People and agents** tab, or **Teams** on the agent's profile. See [agents on a team](/guides/teams/#agents-on-a-team). |
| Set the lead, channel and budget | The team's **Settings**. See [lead, channel and budget](/guides/teams/#lead-channel-and-budget). |
| Storage for a team | Coming. |

## The org chart

The org chart, `g1t.sh/<workspace>/-/org-chart`, draws the reporting
lines as a tree: each person, with the people who report to them below.
Beside each person are the agents of the teams they lead.

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

- on its People profile, under **What** *agent* **knows about its teams**;
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
