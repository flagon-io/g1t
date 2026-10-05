---
title: Workspaces
description: Workspaces, their names and icons, members and roles, and access tokens that belong to a workspace.
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

## Display name, slug and icon

A workspace has two names:

| | Example | Where it appears | Changes |
| --- | --- | --- | --- |
| **Display name** | `Flagon Industries` | The sidebar, the top of its page, mission control and link previews | Any time, up to 80 characters; spaces and capitals are fine |
| **Slug** | `flagon` | Every address: `g1t.sh/flagon/<repo>` and clone URLs | Never, so links and clones keep working |

Without a display name, the slug is shown. Where an address is shown, the
slug is in monospace beside the name. Owners change the display name and
description on **Settings → General**; from the API, `update_workspace`.

A workspace also has an icon, as an organization does on GitHub. Without
one, g1t draws its first letter in a colour of its own. To upload one, an
owner opens **Settings → General** and picks an image:

- PNG, JPEG, WebP or GIF, at most 1 MB. Square images look best.
- An image is checked by its contents, not its name. SVG is refused,
  because it can carry script.
- **Remove** goes back to the letter.

The icon then shows wherever the workspace does, and on its link previews
(PNG and JPEG icons only). Each image is served from
`g1t.sh/avatars/<sha256>`, an address named after its contents, so an icon
that changes gets a new address and nothing shows the old one.

You can upload a picture of yourself the same way, under
[Settings → Picture](https://g1t.sh/settings#picture).

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
| **General** | Owners | The icon, the display name and a one-line description. The slug is shown, and cannot be changed. |
| **Members** | Members | Who belongs, and their roles. Owners add and remove people. |
| **Access tokens** | Members | The workspace's own tokens. Owners create and delete them. |
| **Billing and plans** | Members | [Plans](/guides/usage-and-billing/#plans), the balance and the statement. Owners turn plans on and add credit. |
| **Integrations** | Members | [Model providers, alerts and trackers](/guides/integrations/). Owners connect and remove them. |
| **Secrets and variables** | Members | [Rows every repository, or the ones linked, reads](/guides/secrets-and-variables/). Owners change them. |
| **Webhooks** | Members | [Every repository's events](/guides/webhooks/), sent to your addresses. Owners manage them. |

A [project's](/guides/projects/) own settings are under **Settings** in its
sidebar: **General**, **Deployments**, **Secrets and variables**,
**Repository** (merge rules and branch protection) and **Webhooks**.

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
