---
title: Workspaces
description: Workspaces, members and roles, and access tokens that belong to a workspace.
---

A workspace owns repositories and is the first part of their address:
`g1t.sh/<workspace>/<repo>`. There is one kind. A workspace for just you and
one for a company are the same thing with a different number of members, so
there is no separate notion of an organization.

## Create a workspace

Your account does not own repositories itself. After confirming your email
the first thing you do is create a workspace, and repositories go in it.

1. Open [g1t.sh/workspaces/new](https://g1t.sh/workspaces/new).
2. Choose its name in URLs: lowercase letters, digits and single hyphens.
   It cannot be changed later, because repository addresses and clones
   depend on it.
3. Optionally give it a display name.

From the API, `POST /workspaces` with `slug` and `name`, or the
`create_workspace` tool:

```sh
curl -X POST https://api.g1t.sh/workspaces \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug": "acme", "name": "Acme"}'
```

You can belong to up to ten workspaces. `GET /user`, or `whoami`, lists the
ones you belong to.

Usernames and workspaces share one set of names, so a name means the same
thing wherever it appears. Your username is reserved for you: only you can
create a workspace with that name, and nobody can register a username that
is already a workspace.

## Members and roles

| Role | Can |
| --- | --- |
| Member | Create repositories, push, manage issues, merge pull requests, plan work, put g1t agents to work, and see the workspace's usage and billing. |
| Owner | Everything a member can, and manage members, the workspace's access tokens, its details, and add credit. |

Whoever creates a workspace is its owner. An owner adds people on the
workspace's **Settings → Members** page by their g1t username; they join as
members. An owner can also remove a member there.

## The workspace's pages

A workspace's page, `g1t.sh/<workspace>`, shows its repositories and the
pull requests in progress across them. In the sidebar, its members also
have **Usage**, what g1t agents have cost (see
[usage and billing](/guides/usage-and-billing/)), and **Settings**, which
slides the sidebar over to the workspace's settings:

| Settings | Who | |
| --- | --- | --- |
| **General** | Owners | The display name and a one-line description. |
| **Members** | Members | Who belongs, and their roles. Owners add and remove people. |
| **Billing** | Members | The balance and statement. Owners add credit. |
| **Integrations** | Members | [Model providers, alerts and trackers](/guides/integrations/). Owners connect and remove them. |
| **Access tokens** | Members | The workspace's own tokens. Owners create and delete them. |

The arrow at the top of the settings goes back.

## Workspace access tokens

A workspace has access tokens of its own, for CI, integrations and agents
that work for a team. They replace the shared "service account" other
forges need: there is no extra account to create, pay for or lose the
password to.

| | Personal token | Workspace token |
| --- | --- | --- |
| Belongs to | You | The workspace |
| Acts as | You | The workspace: its name is the author of what it does |
| Can reach | Every workspace you belong to | That workspace only |
| Can do | Everything you can | What a member can; it cannot manage people, tokens or workspaces |
| When its creator leaves | Stops working | Keeps working |
| Created by | You, in [Settings](https://g1t.sh/settings) | An owner, under the workspace's **Settings → Access tokens** |

They are the same kind of token and are sent the same way; see
[access tokens](/guides/authentication/#access-tokens). With git, any
username works; the token is the password. `GET /user` answers with
`"kind": "workspace"` for one, and `"kind": "user"` for a personal token.

Every member can see a workspace's tokens: the name, who created each and
when it was last used. Only owners can create or delete them.
