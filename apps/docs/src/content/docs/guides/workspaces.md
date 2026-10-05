---
title: Workspaces
description: Workspaces, their names and icons, renaming one, members and roles, and access tokens that belong to a workspace.
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
   An owner can [change it later](#rename-a-workspace), and old addresses
   redirect for 90 days.
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
| **Slug** | `flagon` | Every address: `g1t.sh/flagon/<repo>`, clone URLs, API paths and `g1t.page` app addresses | By an owner, once a day at most; the old one redirects for 90 days. See [rename a workspace](#rename-a-workspace) |

Without a display name, the slug is shown. Where an address is shown, the
slug is in monospace beside the name. Owners change the display name and
description on **Settings → General**; from the API, `update_workspace`.

A workspace also has an icon. Without
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

## Rename a workspace

Renaming changes the slug, the first part of every address under the
workspace. The display name is separate; change it on its own under
**Settings → General → Workspace details**. Only owners can rename a
workspace.

1. Open the workspace's **Settings → General** and go to **Address**.
2. Type the new slug. The field shows the new address, `g1t.sh/<new>`, and
   whether the name is available.
3. Choose **Change address**, read what changes, type the new slug to
   confirm, and choose **Change address** again.

You land on the workspace's settings at its new address. Repositories,
issues and the rest move with it within a few seconds.

### What changes

| | Before | After |
| --- | --- | --- |
| Pages | `g1t.sh/old/<repo>` | `g1t.sh/new/<repo>` |
| Git remotes | `https://g1t.sh/old/<repo>.git` | `https://g1t.sh/new/<repo>.git` |
| API paths | `https://api.g1t.sh/repos/old/<repo>` | `https://api.g1t.sh/repos/new/<repo>` |
| MCP tool arguments | `"owner": "old"` | `"owner": "new"` |
| Production apps | `https://<project>-old.g1t.page` | `https://<project>-new.g1t.page` |
| Previews | `https://<project>-git-<branch>-old.g1t.page` | `https://<project>-git-<branch>-new.g1t.page` |

These stay the same: the display name, description and icon, members and
roles, access tokens, secrets and variables, integrations, webhooks,
issues and pull requests, and billing, plans and credit.

### What redirects, and for how long

For 90 days after a rename, the old name keeps working:

| | Behaviour |
| --- | --- |
| Web pages | Answer with a permanent redirect (301) to the same page under the new name, query string included. |
| `git clone`, `fetch`, `pull` and `push` | Redirected to the new remote. Git follows it, but prints a warning each time until you update the remote. |
| API | Calls to the old paths redirect to the new ones. |
| `g1t.page` apps | Production and preview addresses under the old name redirect to the new ones. |

Update your remotes now rather than relying on the redirect:

```sh
git remote set-url origin https://g1t.sh/<new>/<repo>.git
```

Update anything else that has the old name written into it, too: links in
READMEs and docs, CI configuration, API clients and MCP clients.

### Limits

- A workspace can be renamed once every 24 hours.
- For 90 days the old name is held for the workspace. Nobody else can take
  it, and you can rename back to it.
- After 90 days the redirects stop, and anyone can create a workspace or
  register a username with the old name. Links and remotes that still use
  it then reach whatever has the name, or nothing.
- The new name follows the same rules as a new workspace: lowercase letters,
  digits and single hyphens, up to 39 characters, not a reserved word, and
  not another workspace's slug or someone else's username.

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
| **General** | Owners | The icon, the display name, a one-line description and the address (the slug). |
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
that work for a team. There is no shared service account to create, pay
for or lose the password to.

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

## Profiles

Every person has a profile at `g1t.sh/u/<username>`, apart from the
workspaces at `g1t.sh/<workspace>`. Author names on issues and pull
requests link to it.

**What it shows.** Your picture, name, username, pronouns, bio, location,
website and when you joined; then your work in three tabs:

- **Overview:** pull requests merged, open pull requests and issues
  opened, and your most recent activity.
- **Pull requests** and **Issues:** everything you opened, newest first,
  with filters beside the list for state (open, closed, merged), type,
  repository and sort order. Add `?tab=pulls&state=merged` and the like to
  link to a filtered list.

**Edit it** under **Profile** in [Settings](https://g1t.sh/settings). Every
field is optional. The bio takes up to 160 characters and is also what a
link to your profile says. The website must be an `https://` address;
`example.com` is saved as `https://example.com`. Your email address is
never shown.

**Who sees what.** A profile is public, but the work and workspaces on it
are filtered for whoever is looking:

| On the profile | Shown to a visitor when |
| --- | --- |
| An issue or pull request, and its title | They can read its repository: it is public, or they are a member of its workspace |
| The counts | Only what they could see is counted |
| A workspace | They are a member of it too, or you made a public project in it, whose page shows that already |

Someone signed out sees your public work and the workspaces where you made
a public project; nothing else. The link preview for a profile uses only
public work.
