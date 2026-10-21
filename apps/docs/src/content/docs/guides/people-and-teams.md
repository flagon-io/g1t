---
title: People and teams
description: Find anyone in a workspace, see their teams and what they own, and edit a profile's title and ownership.
---

**People** is where a workspace's people are listed: who they are, the
teams they are on and what they own. Open it from **People** in the
workspace's menu, in the app bar. Its sidebar has:

| Page         | Address                       | What it is                                                 |
| ------------ | ----------------------------- | ---------------------------------------------------------- |
| **Everyone** | `g1t.sh/<workspace>/-/people` | The [directory](#the-directory) of the workspace's people. |
| **Teams**    | `g1t.sh/<workspace>/-/teams`  | The workspace's [teams](/guides/teams/).                   |

Only members of the workspace can open these pages. Who belongs, and
inviting people, is the workspace's own business: **Members**,
**Invitations** and **Permissions** are under **Workspace → Access**; see
[members, invitations and permissions](#members-invitations-and-permissions).

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

Owners see **Invite people**, which opens the workspace's
[Members](#members-invitations-and-permissions) page, where **Invite** is.

## A person's profile

Choose someone in the directory to open their profile,
`g1t.sh/<workspace>/-/people/<username>`. It shows their title, username,
pronouns, whether they are around and their status, location and local
time, their bio and what they own. Their name, pronouns, bio, location and
time zone come from their account's
[profile settings](/guides/authentication/); their title and what they own
are set for this workspace.

| Card       | What it shows                                                                                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Teams**  | The teams they are on, with **Lead** or **Maintainer** beside each where it applies.                                                                                                                                                                                         |
| **Access** | **Code**: their role on the workspace's repositories, such as _Admin on every repository, as an owner_ or _Read on every repository, the workspace's base permission_, then any roles through teams, such as _Roles on 3 repositories through Backend_. **Storage**: coming. |

**Message** opens your direct message with them in [Chat](/guides/chat/).

### Edit a profile

You can edit your own profile; owners can edit anyone's.

1. Open the profile, `g1t.sh/<workspace>/-/people/<username>`.
2. Choose **Edit profile**.
3. Change what you need, and save.

| Field             | Who sets it             | Limits                                                                                                   |
| ----------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| **Title**         | The person, or an owner | Their job here, such as _Staff Engineer_. Up to 80 characters.                                           |
| **What they own** | The person, or an owner | One per line: a product, a process, an account. Up to 8, each up to 60 characters. Repeats are left out. |

What you set here is shown in the directory and on their profile. Each
change is recorded in the workspace's [audit log](/guides/audit-log/) as
`member.profile_edited`.

When someone leaves the workspace, any team they led has no lead.

## Members, invitations and permissions

Who is in the workspace is a setting of the workspace, so it lives in
[Workspace mode](/guides/workspaces/#workspace-mode), under **Access**:

| Page            | Address                                    | What it is                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Members**     | `g1t.sh/<workspace>/-/members`             | Everyone in the workspace and their roles, with search and filters; **Invite** (a dialog), changing roles, transferring ownership, outside collaborators and leaving. See [add people](/guides/workspaces/#add-people) and [change someone's role](/guides/workspaces/#change-someones-role). |
| **Invitations** | `g1t.sh/<workspace>/-/members/invitations` | Every invitation to join, by where it stands: pending, accepted, declined, expired, revoked. Owners only.                                                                                                                                                                                     |
| **Permissions** | `g1t.sh/<workspace>/-/permissions`         | Who may do what, part by part, [the base permission](/guides/access-and-roles/#the-base-permission) included. Owners only. See [permissions](/guides/permissions/).                                                                                                                           |

## Next

- [Teams](/guides/teams/): roles on repositories, mentions, review
  requests, and a team's lead and channel.
