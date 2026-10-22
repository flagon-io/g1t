---
title: Workspaces
description: Workspaces, their names and icons, renaming and deleting one, members, owners and the roles that add to a member, inviting people, Workspace mode's settings pages, requiring two-factor authentication, access tokens that belong to a workspace, and Getting started, the setup guide for its owners.
---

A workspace owns repositories and is the first part of their address:
`g1t.sh/<workspace>/<repo>`. There is one kind. A workspace for just you and
one for a company are the same thing with a different number of members, so
there is no separate notion of an organization.

## Create a workspace

Your account does not own repositories itself: a workspace does, and
repositories go in it. Every new account gets a workspace of its own, named
for its username and on the free plan, unless its invite brings it into
someone else's workspace; see
[your first workspace](/guides/authentication/#your-first-workspace).
Signed in without a workspace, g1t shows **Create your workspace or ask to
join one** in place of Home: the invitations waiting for you,
and the form below.

To create another:

1. Open [g1t.sh/workspaces/new](https://g1t.sh/workspaces/new).
2. Choose its name in URLs: lowercase letters, digits and single hyphens.
   An owner can [change it later](#rename-a-workspace), and old addresses
   redirect for 90 days.
3. Optionally give it a display name.

From the API, `POST /workspaces` with `slug` and `name`, or the
`workspace` tool's `create` action:

```sh
curl -X POST https://api.g1t.sh/workspaces \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug": "acme", "name": "Acme"}'
```

You can belong to up to ten workspaces. `GET /user`, or the `account` tool's `whoami` action, lists the
ones you belong to.

A new workspace is free, and **each person can own one free workspace**.
While you own a free workspace, the page shows **You already own a free
workspace** in place of the form, with **Start the plan** on it; the API
answers `402` (`payment_required`). Start the plan on it, or delete it,
then create the new one. Several free workspaces from before are kept, but
each needs the plan (or deleting) before you can create another. See
[one free workspace per person](/guides/usage-and-billing/#one-free-workspace-per-person).

Usernames and workspaces share one set of names, so a name means the same
thing wherever it appears. Your username is reserved for you: only you can
create a workspace with that name, and nobody can register a username that
is already a workspace. The names `g1t` and `g1t-agent` belong to g1t,
and nobody can register them.

## Getting started

**Getting started** is a setup guide for a workspace's owners. It opens
by itself on the workspace's [Home](/guides/home/), for each owner, until
that owner finishes or closes it. A workspace made before the guide existed opens it once for each of
its owners too.

It has six steps. Each is ticked from what the workspace has, never from
what you clicked, so a step you did elsewhere is ticked here as well:

| Step                     | Done when                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add an AI provider**   | The workspace has an [AI provider](/guides/ai/) whose key passed its last check. You can add one in the guide: choose a provider, paste its key, and **Add and check the key** saves it and checks it at once, as the AI page does. **Test** checks one again.   |
| **Choose Ask's model**   | [Ask g1t](/guides/ask/) answers with one of the workspace's providers, and has no problem with it. Choose the provider and a model, or Auto, and **Use for Ask**.                                                                                                |
| **Bring your code**      | The workspace has a repository, or [GitHub is connected](/guides/github/). **New repository** starts one; **Connect GitHub** installs g1t's GitHub App in one step, then you choose the repositories to bring across.                                            |
| **Connect your harness** | You signed in the [g1t CLI](/guides/cli/) (`g1t auth login`), or signed in an [AI client](/guides/bring-your-own-agent/) with g1t through MCP. The guide shows the install commands for macOS and Linux and for Windows, ready to copy.                          |
| **Invite your team**     | The workspace has another member, or an invitation waiting for an answer. Workspace invites come with the plan: on a free workspace the step says so, links to the plan, and offers [inviting a friend to g1t](/guides/authentication/#invite-a-friend) instead. |
| **Add a runner**         | The workspace has a [self-hosted runner](/guides/self-hosted-runners/), such as [the desktop app](/guides/desktop/).                                                                                                                                             |

Every step but the AI provider can be skipped with **Skip for now**; a
skipped step counts as settled, and **Don't skip** takes it back. When
every step is done or skipped, the guide says **All set**, and **Finish**
puts it away.

Closing the guide puts it away too: it stops opening by itself for you,
in this workspace, on every device. Nothing else changes. Open it again
any time from the **Getting started** button at the top of Home, from
**Workspace → Profile** (**Getting started**), from the
workspace's **AI** page, or by typing _Getting started_ in the command
palette, which opens Home with `?setup=1`. Each owner has their own:
closing it does not close it for anyone else.

Members who are not owners do not see it.

From the API, `GET /workspaces/{workspace}/onboarding` says whether you
dismissed it (`dismissed_at`) and which steps you skipped (`skipped`), and
`PATCH /workspaces/{workspace}/onboarding` changes them: `dismissed`
true puts it away, false makes it open by itself again, and `skipped`
replaces the skipped steps (any of `ai`, `ask`, `code`, `harness`,
`people`, `runner`). Whether a step is done is not stored: it is read from
the workspace each time.

```sh
curl -X PATCH https://api.g1t.sh/workspaces/acme/onboarding \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dismissed": true}'
```

Reading it takes a token with `workspace:read`; changing it, which
changes only your own, takes `account:write`.

## Display name, slug and icon

A workspace has two names:

|                  | Example             | Where it appears                                                                          | Changes                                                                                                           |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Display name** | `Flagon Industries` | The sidebar, the top of its page, mission control and link previews                       | Any time, up to 80 characters; spaces and capitals are fine                                                       |
| **Slug**         | `flagon`            | Every address: `g1t.sh/flagon/<repo>`, clone URLs, API paths and `g1t.page` app addresses | By an owner, once a day at most; the old one redirects for 90 days. See [rename a workspace](#rename-a-workspace) |

Without a display name, the slug is shown. Where an address is shown, the
slug is in monospace beside the name. Owners change the display name and
description (up to 160 characters) on **Workspace → Profile**, or with
[`PATCH /workspaces/{workspace}`](/reference/api/workspaces/update-workspace/)
(MCP: `workspace` `update`), which takes `name` and `description` and
changes only the fields given. It needs the `workspace:admin` scope, and
is recorded in the [audit log](/guides/audit-log/):

```sh
curl -X PATCH https://api.g1t.sh/workspaces/flagon \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Flagon Industries", "description": "Rockets, and the software that flies them."}'
```

Neither changes the slug; that is a [rename](#rename-a-workspace).

A workspace also has an icon. Without
one, g1t draws its first letter in a colour of its own. To upload one, an
owner opens **Workspace → Profile** and picks an image under **Profile
picture**:

- PNG, JPEG, WebP or GIF, at most 1 MB. Square images look best.
- An image is checked by its contents, not its name. SVG is refused,
  because it can carry script.
- **Remove** goes back to the letter.

The icon then shows wherever the workspace does, and on its link previews
(PNG and JPEG icons only). Each image is served from
`g1tusercontent.com/avatars/<sha256>`, an address named after its contents, so an icon
that changes gets a new address and nothing shows the old one.

You can upload a picture of yourself the same way, under
[Settings → Profile](https://g1t.sh/settings/profile).

### The workspace's profile

**Profile**, `g1t.sh/<workspace>/-/settings/profile`, is the first page of
[Workspace mode](#workspace-mode): **Workspace settings** opens there, and
`g1t.sh/<workspace>/-/settings` leads to it. Every member can read it; only
owners change it. Everything in **Profile** is shown publicly:

| Field               | What it holds                                                 |
| ------------------- | ------------------------------------------------------------- |
| **Display name**    | The workspace's name, as above.                               |
| **Profile picture** | The workspace's icon, as above.                               |
| **Description**     | One line about the workspace, up to 160 characters.           |
| **URL**             | The workspace's website, starting `https://`.                 |
| **Public email**    | An address people can reach the workspace at.                 |
| **Location**        | Where the workspace is.                                       |
| **Social accounts** | Up to four links to the workspace elsewhere, each `https://`. |

Owners also see these on the page:

| Section             | What it is                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Billing email**   | Private. Where invoices and receipts go; g1t gives it to Stripe as the workspace's billing email. Without one, they go to an owner's email. Add more recipients under [Billing and plans](/guides/usage-and-billing/). |
| **Getting started** | Opens the [setup guide](#getting-started) again.                                                                                                                                                                       |
| **Address**         | The slug. See [rename a workspace](#rename-a-workspace).                                                                                                                                                               |
| **Data residency**  | Where new repositories are stored, when g1t offers a choice. See [data residency](#data-residency).                                                                                                                    |
| **Danger zone**     | [Deleting the workspace](#delete-a-workspace).                                                                                                                                                                         |

Requiring two-factor authentication is not here: it is under
[Authentication security](#require-two-factor-authentication).

## Rename a workspace

Renaming changes the slug, the first part of every address under the
workspace. The display name is separate; change it on its own under
**Workspace → Profile**. Only owners can rename a
workspace.

1. Open **Workspace → Profile** and go to **Address**.
2. Type the new slug. The field shows the new address, `g1t.sh/<new>`, and
   whether the name is available.
3. Choose **Change address**, read what changes, type the new slug to
   confirm, and choose **Change address** again.

You land on the workspace's **Profile** at its new address. Repositories,
work items and the rest move with it within a few seconds.

### What changes

|                    | Before                                           | After                                            |
| ------------------ | ------------------------------------------------ | ------------------------------------------------ |
| Pages              | `g1t.sh/old/<repo>`                              | `g1t.sh/new/<repo>`                              |
| Git remotes        | `https://g1t.sh/old/<repo>.git`                  | `https://g1t.sh/new/<repo>.git`                  |
| API paths          | `https://api.g1t.sh/repos/old/<repo>`            | `https://api.g1t.sh/repos/new/<repo>`            |
| MCP tool arguments | `"owner": "old"`                                 | `"owner": "new"`                                 |
| Production apps    | `https://<repository>-old.g1t.page`              | `https://<repository>-new.g1t.page`              |
| Previews           | `https://<repository>-git-<branch>-old.g1t.page` | `https://<repository>-git-<branch>-new.g1t.page` |

These stay the same: the display name, description and icon, members and
roles, access tokens, secrets and variables, integrations, webhooks,
work items and pull requests, and billing, plans and credit.

### What redirects, and for how long

For 90 days after a rename, the old name keeps working:

|                                         | Behaviour                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Web pages                               | Answer with a permanent redirect (301) to the same page under the new name, query string included.        |
| `git clone`, `fetch`, `pull` and `push` | Redirected to the new remote. Git follows it, but prints a warning each time until you update the remote. |
| API and MCP                             | A call that names the old slug runs under the new one.                                                    |
| `g1t.page` apps                         | Production and preview addresses under the old name redirect to the new ones.                             |

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
  digits and single hyphens, up to 39 characters, not a reserved word or a
  well-known GitHub action owner's name (such as `actions` or `docker`), and
  not another workspace's slug or someone else's username.

## Workspace aliases

An alias is a second name for a workspace that leads to it for good,
wherever a workspace's name goes. On g1t.sh, `g1t` is an alias of
`flagon-io`, the workspace of Flagon, Inc., which builds g1t and holds its
repositories: `g1t.sh/g1t/deploy` is the repository `flagon-io/deploy`.

|                                         | Behaviour                                                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web pages                               | Answer with a permanent redirect (301) to the same page under the workspace's slug, query string included.                                                                                         |
| `git clone`, `fetch`, `pull` and `push` | Answered in place, as the repository under the workspace's slug, with the same permissions, and no redirect for git to warn about.                                                                 |
| API and MCP                             | A call that names the alias runs under the workspace's slug, and the answer names the workspace by its slug. A token that reaches one repository reaches it under the alias too, and nothing else. |
| Packages                                | Registry addresses under the alias redirect to the workspace's.                                                                                                                                    |
| Actions                                 | `uses: g1t/deploy@v1` and `g1t/workflows/.g1t/workflows/deploy.yml@v1` are found as `flagon-io/deploy` and `flagon-io/workflows`. See [g1t's own actions](/guides/actions/#g1ts-own-actions).      |

An alias resolves whatever its case (`G1T` is `g1t`), and follows the
workspace through renames: it points at the workspace, not at its slug.
Pages, API answers and links always show the workspace's own slug.

An alias never changes who can see what. A private repository is found
under the alias only by someone who could see it under the workspace's
slug, and the alias gives nobody access they did not have.

Aliases are set and removed by g1t's staff; there is no setting for them.
While an alias exists, nobody can register it as a username, create a
workspace with it, or rename a workspace to it. An alias is never a
person's or a workspace's name, and never one of the site's own routes.
[Contact us](https://g1t.sh/support) if your workspace needs one, such as
for a name it used to trade under.

## Data residency

Data residency says where the git data of the workspace's new repositories
is stored. The section appears on **Workspace → Profile** once g1t can store
repositories in the EU. Until then it is not shown, and every repository is
stored wherever g1t stores repositories.

| Setting  | What it does                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anywhere | New repositories are stored wherever g1t stores repositories. The default.                                                                                                   |
| EU only  | New repositories are stored in the EU. If EU storage cannot take one right now, the repository is not made, and you are told why. It is never stored somewhere else instead. |

To change it:

1. Open **Workspace → Profile**. Only owners see the section.
2. Under **Data residency**, choose **Anywhere** or **EU only**.
3. Select **Save**.

The setting applies to repositories made after you save it, however they
are made: from the site, with the API, by pushing to a new address, or by
importing. Repositories the workspace already has stay where they are. To
move them, contact support; a move keeps each repository's address, history
and settings, and pushes to it wait a few minutes while it happens.

Data residency covers the git data: commits, branches, tags and files,
including pull requests' working copies, which are stored with their
repository. Work items, pull requests, comments and settings are not affected.
A repository [transferred](/guides/transferring-repositories/) to another
workspace stays where it is stored.

Changing the setting is recorded in the
[audit log](/guides/audit-log/) as `workspace.residency_changed`.

## Delete a workspace

Deleting a workspace takes everything in it with it, in one step: its
repositories and their apps, members' access and tokens. Only an owner can,
signed in as a person, typing the workspace's slug to confirm.

It is not gone at once. For **30 days** g1t keeps all of it, so that a
deletion you did not mean, or did not make, can be undone: an owner writes
to support@g1t.sh, and support restores the workspace as it was. After 30
days it is purged for good.

1. Open **Workspace → Profile** and go to **Danger zone**.
   It lists what will go with the workspace: its repositories,
   live apps and members.
2. Choose **Delete workspace**, read what happens, type the workspace's
   slug to confirm, and choose **Delete workspace** again. You are taken
   back to your own home.

The one thing that can stand in the way is billing: see
[what billing needs](#what-billing-needs). Repositories you want to keep in
another workspace, [transfer](/guides/transferring-repositories/) first;
their old addresses keep redirecting after the workspace is gone.

From the API, call
[`DELETE /workspaces/{workspace}`](/reference/api/workspaces/delete-workspace/)
with the slug in `confirm`; over MCP, the `workspace` tool's `delete`
action.

Some workspaces can never be deleted, by anyone, such as Flagon's, which
runs g1t. Their Danger zone says so instead of offering the button.

### What billing needs

|                                      |                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Money owed                           | Charged to the workspace's card at once, with no minimum charge. With no card, add one or pay from **Billing** first.  |
| An unpaid invoice                    | Pay it from **Billing** first.                                                                                         |
| Prepaid credit                       | Spend it, or write to support@g1t.sh for a refund, first.                                                              |
| Usage this month still being metered | Storage and git operations are charged when the month closes. You can delete the workspace from the 1st of next month. |
| The g1t plan                         | Ends at Stripe at once, not at the end of the period.                                                                  |
| An enterprise account                | A workspace billed through one is moved off it by g1t first: write to support@g1t.sh.                                  |

A comped workspace owes nothing; only its plan is ended.

### What happens

At once, when an owner deletes it:

|               |                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Members       | Lose access, and the workspace leaves their list. Their own accounts are not touched: a person with no workspace left can still sign in, and create or join one. |
| Access tokens | The workspace's own tokens stop working. Personal tokens are not affected.                                                                                       |
| Repositories  | Deleted with it: git refuses them, and their pages answer 404. Workflow runs stop. Ones deleted on their own earlier stay deleted.                               |
| Apps          | Hidden. Its apps are taken offline and nothing builds. Custom domains are kept for a restore.                                                                    |
| Its pages     | Answer 404, and it drops out of search.                                                                                                                          |
| Billing       | What it owes is charged, and its plan ends, as [billing needs](#what-billing-needs). Nothing more is charged.                                                    |
| The audit log | Records the deletion.                                                                                                                                            |

Within 30 days, support can restore it: its members, tokens, repositories
and apps come back as they were, and its apps go back up as its
limit allows. Its plan does not come back by itself: an owner starts it
again from **Billing**. A repository deleted on its own before the
workspace was stays in **Recently deleted**.

After 30 days it is purged:

|                                               |                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repositories                                  | Purged, their git data with them, including any that were in Recently deleted.                                                                                                                                                                                                           |
| Apps and custom domains                       | Removed.                                                                                                                                                                                                                                                                                 |
| Webhooks, integrations, secrets and variables | The workspace's own are removed.                                                                                                                                                                                                                                                         |
| Guardrails                                    | The workspace's own are removed.                                                                                                                                                                                                                                                         |
| Statements, invoices and the ledger           | Kept, for accounting.                                                                                                                                                                                                                                                                    |
| The audit log                                 | Kept as [long as its account keeps it](/guides/audit-log/#how-long-it-is-kept), with the purge as its last entry: once the plan ends with the workspace, that is 7 days, unless an enterprise pays for it or longer was arranged. With no owners left, ask support@g1t.sh for an export. |
| Old addresses                                 | Redirects for repositories transferred out keep working. The workspace's own pages answer 404.                                                                                                                                                                                           |

### The name afterwards

A deleted workspace's slug is never given to another workspace or used as
someone else's username. While it can still be restored, the slug is held
for it. Links and git remotes that still use it keep
meaning what they meant: a transferred repository's old address keeps
redirecting to it, and nobody can take the name in the meantime.

The one exception: when the slug is your own username, you may create a
workspace with that name again once the old one is purged. It starts empty, on standard billing terms,
and a repository made in it at an old address ends that address's redirect.

## Members and roles

<a id="members-and-owners"></a>

| Role   | Can                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member | Create repositories (as the [member privileges](#member-privileges) allow), see the workspace's usage and billing, and get the workspace's [base permission](/guides/access-and-roles/#the-base-permission) on every repository in it: Read for a new workspace, which an owner can raise to Write to let members push and merge pull requests. Admin on the repositories they create.                         |
| Owner  | Everything a member can, and manage members and owners, the base permission, the member privileges, two-factor requirement, the workspace's access tokens, its details, and billing: the plan, card checks, prepayment and limits. Admin on every repository, and the only ones who can transfer and delete them unless the member privileges allow admins; see [access and roles](/guides/access-and-roles/). |

A workspace can have any number of owners, and always has at least one.

### Roles that add to a member

An owner can give a member one or both of these roles. Each adds to what
the member already has; an owner has both already.

| Role                 | Adds                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Billing manager**  | Manages the workspace's billing as an owner does: the plan, budget and spend limit, prepaying, the card, billing details and invoices. Gives nothing on repositories.                                                                    |
| **Security manager** | Read on every repository, and seeing and managing every security alert and security setting on them: dismissing and reopening alerts, custom patterns, reviewing push protection bypass requests, and the workspace's security settings. |

### Change someone's role

On **Members**, `g1t.sh/<workspace>/-/settings/members` (**Workspace → Access →
Members**), an owner opens the **⋯** menu beside a member:

1. **Make owner** or **Make member** changes their role.
2. **Billing manager** and **Security manager** turn each role on or off.
3. **Transfer ownership…** hands the workspace to that member: they become
   an owner and you a member, in one step. To add an owner without stepping
   down, choose **Make owner** instead.
4. **Remove from {workspace}…** takes them out. Their roles on its
   repositories and their place in its teams go too.

Owners see a shield beside each member: green when two-factor
authentication is on, amber when it is off. Above the list, a search box
finds a member by username or name, and the filters narrow the list by
role, by two-factor authentication (owners only) and by team; each is kept
in the address (`?q=`, `?role=`, `?2fa=`, `?team=`), so a filtered list can
be shared.

The last owner cannot be made a member, removed, or leave: make someone
else an owner first, or [delete the workspace](#delete-a-workspace).

### Leave a workspace

Anyone can leave a workspace they belong to: at the bottom of **Members**,
choose **Leave {workspace}** and confirm. Your roles on its repositories
and your place in its teams go with you at once. The only owner cannot
leave.

### Add people

Whoever creates a workspace is its owner. Nobody is added to a workspace
without saying yes: an owner invites people, and each person accepts or
declines.

Anyone can make a g1t account without an invite, so to bring someone in
you invite them to the workspace; someone without an account signs up from
the invitation. To tell a friend about g1t without adding them to a
workspace, use [Invite a friend](/guides/authentication/#invite-a-friend)
in your account menu instead.

On the workspace's **Members** page, `g1t.sh/<workspace>/-/settings/members`
(**Workspace → Access → Members** in the sidebar), or on **Invitations**
under it:

1. Select **Invite**. A dialog opens.
2. Under **Who**, type a username, a name or an email address. As you
   type, people on g1t are offered by username and name, with their
   pictures; hover over one for their card. Only usernames, names and
   pictures are shown, never anyone's email address. An email address is
   taken as written.
3. Choose the **Role** they join with: **Member** or **Owner**.
4. Write a **Message** if you like: a line quoted in the invitation email,
   under your name. Up to 500 characters.
5. Select **Invite**. The dialog closes and the page says who was invited.

- **By username**: they get a
  [workspace invitation](/guides/authentication/#workspace-invitations) in
  their notifications and by email, and join with that role when they accept at
  [g1t.sh/invitations](https://g1t.sh/invitations). If they decline, you
  are told in your notifications. It costs nothing.
- **By email address**: g1t emails an invite that only that address can
  use. With a g1t account, it is a workspace invitation like the one above
  and costs nothing. Without one, the invitation also lets them make the
  account first, and costs nothing (see
  [invites](/guides/authentication/#invites)). The new account is then
  invited to the workspace, and joins when it accepts. The page never says which it was.

The email names you and the workspace and links to the invite's page.
Someone new signs up right there, with the invited address filled in; once
the address is confirmed (straight away when they opened the page from
that email, which proves the address is theirs, otherwise with the code g1t
emails them), they are asked to accept or decline the invitation. Someone
with an account signs in and accepts on the page. Accepting lands them in
the workspace, with a one-time welcome. See
[using an invite](/guides/authentication/#using-an-invite).

#### When someone joins

A person becomes a member by accepting an invitation or by using an
invite code that names the workspace. The join is an event,
`workspace.member_joined`, for the workspace's
[webhooks](/guides/webhooks/#events).

Every invitation sent is on **Invitations**,
`g1t.sh/<workspace>/-/settings/members/invitations` (**Workspace → Access →
Invitations**, owners only): a table of who it is for, who sent it, the
role, when it was sent and where it stands, newest first. The chips above
it narrow the table, each with its count:

| Chip         | Shows                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All**      | Every invitation, however it ended.                                                                                                                                        |
| **Pending**  | The ones still waiting: to be used, for the new account to confirm its email, or for the person to accept. Each says the day it stops working (30 days after it was sent). |
| **Accepted** | The people who joined.                                                                                                                                                     |
| **Declined** | The people who said no.                                                                                                                                                    |
| **Expired**  | The ones nobody used in time. g1t does not yet know whether an invitation's email was delivered, so one that bounced ends up here too.                                     |
| **Revoked**  | The ones an owner took back.                                                                                                                                               |

The **⋯** menu on a pending invitation has **Copy link** (the invitation's
page, while it waits to be used), **Send again** (the same email, and the
inbox notice again for someone on g1t; the invitation itself does not
change) and **Revoke**. Through the API, the invitation is sent again with
nothing yet; revoke it and invite again instead. Converting an outside
collaborator to a member sends them an invitation the same way. The
Members page says how many invitations are waiting, and leads here.
Through the API, use
[`POST /workspaces/{workspace}/invitations`](/reference/api/invites/invite-member/)
with a `username` or an `email` and a `role` (the `workspace` tool's
`invite_member` action over MCP); the person answers with
[`POST /user/invitations/{id}/accept`](/reference/api/invites/accept-invitation/)
or [`/decline`](/reference/api/invites/decline-invitation/).

To give someone a role on one repository without making them a member,
add them as an [outside collaborator](/guides/access-and-roles/#outside-collaborators).

**A free workspace cannot add people.** Until it starts the g1t plan, it
cannot add members, send invites, or invite outside collaborators, and an
invite sent before waits until the plan is on. Its members stay. Members and
Invitations show **Start the plan to invite people** with the button in place of
**Invite**, and the API and MCP answer `402` (`payment_required`). See
[who a free workspace can add](/guides/usage-and-billing/#who-a-free-workspace-can-add).

### Members through the API

| Route                                               | MCP tool and action              | What it does                                                                                                                                | Who     |
| --------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `GET /workspaces/{workspace}/members`               | `workspace` `list_members`       | Its members, owners first: `role` (`owner` or `member`), `org_roles` (`billing_manager`, `security_manager`) and, for owners, `two_factor`. | Members |
| `PATCH /workspaces/{workspace}/members/{username}`  | `workspace` `update_member`      | Change `role` and `org_roles` (a list that replaces theirs).                                                                                | Owners  |
| `DELETE /workspaces/{workspace}/members/{username}` | `workspace` `remove_member`      | Remove someone. Your own username is leaving.                                                                                               | Owners  |
| `POST /workspaces/{workspace}/transfer_ownership`   | `workspace` `transfer_ownership` | Hand it to `username`: they become an owner, you a member.                                                                                  | Owners  |
| `DELETE /user/memberships/{workspace}`              | `workspace` `leave`              | Leave it.                                                                                                                                   | You     |

Each is for people, signed in or with a personal access token; never a
workspace token. A change that would leave no owner answers `409`.

```sh
curl -X PATCH https://api.g1t.sh/workspaces/acme/members/grace \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -d '{"org_roles": ["security_manager"]}'
```

## Member privileges

What members can do beyond their role on each repository. Owners set them
under **Workspace → Access → [Permissions](/guides/permissions/#code)**,
`g1t.sh/<workspace>/-/settings/permissions`, in the **Code** card, and can always do
all of it themselves.

| Setting                                                                                          | Default | When on                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------- |
| **Members can create public repositories** (`members_can_create_public_repositories`)            | On      | Any member can create a public repository.                                                                  |
| **Members can create private repositories** (`members_can_create_private_repositories`)          | On      | Any member can create a private repository.                                                                 |
| **Repository admins can change visibility** (`members_can_change_repo_visibility`)               | On      | A member with Admin on a repository can make it public or private, if they could create one of that kind.   |
| **Repository admins can delete and transfer repositories** (`members_can_delete_repositories`)   | Off     | A member with Admin on a repository can delete it, or transfer it to a workspace where they can create one. |
| **Repository admins can add outside collaborators** (`members_can_invite_outside_collaborators`) | On      | A member with Admin on a repository can give a role on it to someone outside the workspace.                 |

When one is off, only owners can do it; the refusal says so. Someone who is
not a member, an outside collaborator with Admin, never gets these.
Forking private repositories is not a setting: g1t has no personal forks
to allow or refuse.

Through the API, `GET /workspaces/{workspace}` returns each by its name,
and [`PATCH /workspaces/{workspace}`](/reference/api/workspaces/update-workspace/)
sets any of them (`workspace` `update` over MCP). Each change is in the
[audit log](/guides/audit-log/) as `workspace.member_privileges_changed`.

## Workflows the workspace manages

An owner can run a workflow in every repository of the workspace, or in
those whose names match, without committing it to each: a security scan, a
licence check, a release policy. Add it under **Workspace → Code, planning,
and automation → Actions**, `g1t.sh/<workspace>/-/settings/actions`, from a workflow file in one of
the workspace's repositories, as **Required** (repositories cannot take its
place or turn it off, so a ruleset can require its check) or **Default**
(a repository's own workflow of the same name runs instead, and its admins
can turn it off). Each repository's Actions page lists it as managed by the
workspace. [Workflows a workspace manages](/guides/actions/#workflows-a-workspace-manages)
has the details, and the API.

## Require two-factor authentication

An owner can require everyone with access to the workspace, its members
and its outside collaborators, to have
[two-factor authentication](/guides/authentication/#two-factor-authentication)
on.

1. Turn it on for your own account first.
2. Open **Workspace → Security → Authentication security**,
   `g1t.sh/<workspace>/-/settings/authentication`. Owners only. Under
   **Two-factor authentication**, it says how many members do not have it
   on, and who.
3. Turn on **Require two-factor authentication** and choose **Save**.

From then on, someone without it keeps their place but cannot use the
workspace: its private repositories, pages and API answer as if they were
not a member, and every page shows them a notice with a link to turn it
on. Turning it on gives everything back at once. Nobody can join or accept
an invitation to the workspace without it.

Through the API, `two_factor_requirement_enabled` on
`PATCH /workspaces/{workspace}`. Recorded as `workspace.two_factor_required`
and `workspace.two_factor_not_required`.

A workspace on a paid plan can also require
[single sign-on](/guides/single-sign-on/) through its own identity
provider.

## The workspace's page

A workspace's own page, `g1t.sh/<workspace>`, is Code's front page, as an
organization's page is on GitHub, for members and visitors alike. It has
the workspace's [profile](#the-workspaces-profile) at the top: its
picture, name, address, description, location and links. Then how many
repositories it has, how many are in production, its open work items and
the pull requests in progress; your
[pinned repositories](#pinned-and-recent-repositories), then the most active ones,
and **All repositories**; the pull requests in progress across them; and,
beside them, its members. **Code** in the app bar opens it. Where you are
needed and what happened while you were away are on [Home](/guides/home/).

The workspace's other pages each have a heading of their own and a row in
[the sidebar](#the-sidebar), lit while you are on them. The trail in the
top bar, such as _acme / Repositories_, leads back to the workspace's page.

| Page                                    | Address                | Who      |                                                                                                                                                                       |
| --------------------------------------- | ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**                            | `g1t.sh/<workspace>`   | Everyone | The page above.                                                                                                                                                       |
| **Repositories**                        | `/-/code/repositories` | Everyone | Every repository you can see. See [the Repositories page](#the-repositories-page).                                                                                    |
| [**Packages**](/guides/packages/)       | `/-/packages`          | Everyone | What the workspace publishes. A visitor opens it from **Packages** on the workspace's page.                                                                           |
| [**Teams**](/guides/teams/)             | `/-/teams`             | Members  | Groups of members given roles on repositories together, mentioned as `@workspace/team` and asked to review together. Each team has its own page at `/-/teams/<team>`. |
| [**People**](/guides/people-and-teams/) | `/-/people`            | Members  | The workspace's people, with their titles, teams and what they own. Each has a profile at `/-/people/<username>`.                                                     |
| **Members and invites**                 | `/-/settings/members`  | Members  | Who belongs. Owners invite, change roles and remove people here.                                                                                                      |
| **Insights**                            | `/-/insights`          | Members  | How the workspace delivers, what waits and what it costs. See [Insights](#insights).                                                                                  |
| [**Spend**](/guides/spend/)             | `/-/spend`             | Members  | What your agent sessions cost, by day and by what they went into, and how much of it landed. Others' only as the workspace allows.                                    |
| **Settings**                            | `/-/settings/profile`  | Members  | How the workspace is set up and connected, opening on its [profile](#the-workspaces-profile). See [Workspace mode](#workspace-mode).                                  |

Each person sees the repositories they can read: a member whose base permission
is None, an [outside collaborator](/guides/access-and-roles/#outside-collaborators)
or a visitor sees the public ones and those shared with them, without the
workspace's people, deployments or settings.

`g1t.sh/<workspace>?tab=repositories` (or `packages`,
`teams`, `people`, `members`, `insights` or `settings`) opens that page.

### The Repositories page

The Repositories page, `g1t.sh/<workspace>/-/code/repositories`, is made for workspaces with hundreds of repositories. Its old address, `g1t.sh/<workspace>/-/projects`, still leads there.

- **Find a repository** matches every word you type in a repository's name, its
  address or its description. Press <kbd>/</kbd> anywhere on the page to
  start typing.
- **Filters**: public or private; [what it is](/guides/repositories/#what-a-repository-is)
  (apps, libraries, and tools, docs or other when the workspace has any); the language its
  manifests say it is written in; only repositories with
  [Deployments](/guides/deployments/) on; and archived repositories, which are
  left out unless you ask for them. Each choice shows how many repositories it
  holds.
- **Sort** by recently updated (its settings or its last push, whichever is
  later), recently pushed, most active, or name. Most active counts each
  push, work item or pull request opened or closed, review, comment and
  deployment, and what happened a week ago counts half as much.
- **List** or **grid**, 30 repositories to a page.
- The arrow keys (or <kbd>j</kbd> and <kbd>k</kbd>) move between repositories,
  and <kbd>Enter</kbd> opens one.

Everything you choose is in the address, so a filtered list can be
bookmarked or shared.

### Insights

Insights, `g1t.sh/<workspace>/-/insights`, puts the workspace's repositories
side by side: how much they ship, how long changes take, what is waiting
now, and what the work cost. Choose the last 7, 30 or 90 days and all
repositories or one; both are in the address (`?period=7d&project=api`).

|                                              | What it counts                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Merged changes**                           | Pull requests merged in the period, with a bar for each day. The daily values are in a table under the chart.                                                                                                                                                       |
| **Average lead time**                        | From a pull request's opening to its merge, for those merged in the period.                                                                                                                                                                                         |
| **Average first review** (per repository)    | From opening to the first approval or request for changes by a person other than its owner, for first reviews given in the period. Reviews by g1t and by workspace agents do not count.                                                                             |
| **Opened** and **Open now** (per repository) | Pull requests opened in the period, and those open or in draft now.                                                                                                                                                                                                 |
| **Awaiting a first review**                  | Open pull requests (not drafts) no person has reviewed yet.                                                                                                                                                                                                         |
| **In the merge queue**                       | Open pull requests waiting, being tested or passed in the [merge queue](/guides/merge-queue/).                                                                                                                                                                      |
| **Checks running** and **Checks failed**     | Open pull requests by their latest commit's checks: statuses, check runs and g1t Actions jobs, as the pull request shows them. One with a failed check counts as failed, else one with a check still going counts as running; one with no checks counts in neither. |
| **Usage at price** and **Cost**              | [Usage](/guides/usage-and-billing/#the-usage-page) at price, before what the plan, credit or discounts paid. A repository's cost is its usage; with all repositories shown, the total also holds usage that is no repository's.                                     |
| **Cost per merged change**                   | The period's usage divided by its merged changes: an average, not what any one change cost.                                                                                                                                                                         |

The days are UTC days, and the waiting counts are as of now and can
overlap. Each person sees only the repositories they can read. When part of
it cannot be read, such as one service being briefly unavailable, Insights
says so and shows a dash in place of numbers it cannot vouch for. **Explore
costs** opens [Usage](/guides/usage-and-billing/#the-usage-page) with the same period and repository.

### The workspace overview

The workspace's own figures are on [Home](/guides/home/#the-workspace),
for every member, under [This week](/guides/home/#this-week). What the
work says is for members who can see Code, worked out the same way as
Home's week, and each person sees only the repositories they can read.
Figures in dollars are for owners and billing managers only.

1. **Spend, threaded to the work** (owners and billing managers): the
   quarter's work in four columns:
   each milestone, its work items, each work item's change set in each
   repository, and that change set's pull requests (with no milestones in
   the workspace, it starts at the work items). Each box is sized by
   what agents cost on its pull requests (g1t's metered usage, and each
   pull request's share of its sessions' cost estimated at list price),
   and shaded by how many were an agent's (**Agent use**, less to more). Choose a box to
   open what is under it. Work with no milestone or work item has its own
   box. Sessions that opened no pull request, such as ones that pushed
   straight to the default branch, count in their work item's change set
   in their repository, which says **No PRs** and what they cost: the work
   item a session claimed, said it works on, or landed with a push whose
   commit names it in a `G1t-Session` trailer, else its repository alone.
   When usage can't be read, boxes are sized by pull requests.
   Above it, with a [provider's cost report](/guides/usage-and-billing/)
   connected, is what Anthropic or OpenAI reported for the quarter and how
   much of it is threaded to the work. Their figure holds everything the
   organization ran, so it is never added to g1t's.
2. **What's moving and what's waiting**: each team's last two weeks, day
   by day, by the repositories the team works on (each repository, when the
   workspace has no teams). Above the line are changes (pull requests
   opened and merged, and commits agents pushed outside one) and agent
   sessions started; below it, reviews and comments and
   requests for changes. Turn each layer on or off above the rows, point
   at a day for its numbers, or open **The numbers, as a table**. Each
   row is drawn to its own scale. Beside it, **Waiting on a first
   review** lists the oldest open pull requests no one has reviewed. An
   agent's pull request has the agent mark here and in the spend columns:
   point at it to see [why it's an agent's](/guides/home/#whose-work-is-an-agents).
3. **Quiet changes**: places to look, not verdicts.
   - **Knowledge silos**: repositories where one person merged three quarters
     or more of the last 90 days' changes (six or more), and whoever has
     started there this month. Only in a workspace where three people or
     more merged lately: with fewer, every repository rests on someone.
   - **New ground**: people who merged to a repository for the first time in
     the last two weeks, after three or more merges elsewhere.
   - **Spreading**: a harness two or more people in a team started using
     this month, at least two weeks after the first person did (across
     the workspace, when it has no teams).
   - **New habits**: people whose first agent-made change merged in the
     last two weeks, after three or more of their own.

At the end of Home are the workspace's members, for everyone, and, for
owners and billing managers, the month's usage against the plan.

## The app bar, the sidebar and the page

Signed in, g1t is always about one workspace: the one you are in. On a
workspace's pages, and on a repository in one of your workspaces, that is the
workspace the page belongs to, so opening a repository in another of your
workspaces switches you to it; anywhere else, even on public pages such as
[Explore](https://g1t.sh/explore), someone's profile or another
workspace's public repository, it stays the one you chose last.

Those pages beyond your workspaces are browsing g1t: the app bar lights
**Explore**, and Explore's sidebar sits beside them. It has **Back to**
your workspace at the top, which goes to its [Home](/guides/home/); then
**Recently active**, **New repositories** and **Search**; **Your stars** and
**Your profile**; and under **You are viewing**, whose page this is: a
workspace with its overview and **Repositories**, or a person with their
profile and **Stars**. In one of their public repositories, the sidebar is
that repository's own list, as in Code, with **Repositories** at its top to go
back to the rest of theirs. A repository shared with you stays in Code, under
**Shared with you**. On a phone, the button at the top left opens the same
sidebar, and **More** starts with **Explore**.

Each page has three parts:

| Part            | Where                                            | What it holds                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The app bar** | Across the top of the window                     | g1t's mark, which goes to [Home](/guides/home/); the workspace, with **People** and **Workspace settings** in its menu; the built-in apps, **Home**, **Chat**, **Work**, **Code**, **Library** and **Routines**, named from 1280px wide and icons alone below; the apps you pinned, **Apps** and **Explore**; then search, **Ask**, the bell, **Create new** and your account. |
| **The sidebar** | Under the app bar, from the window's left edge   | The lists of the app you are in, in named groups; Ctrl B (⌘B on a Mac) folds it away. Home has none.                                                                                                                                                                                                                                                                           |
| **The page**    | The rest of the window, flat against the sidebar | Its header: the button that shows or hides the sidebar, where you are, **Search or jump to** (<kbd>/</kbd>) when the sidebar is hidden or has a search of its own, the [notifications](/guides/notifications/) bell and **Create new**. Then the page itself.                                                                                                                  |

### The app bar

The built-in apps are always in the app bar, in this order from the left,
each a tab with what is unread on it (named from 1280px wide, an icon with
its name on hover below that):

| App          | Opens                                                                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Home**     | Where the workspace opens: [Home](/guides/home/), where you're needed across the workspace, what happened while you were away, and how the workspace is doing.                                                                                                                            |
| **Chat**     | The conversation you were last in, else #general. Beside it, **Needs attention**, the workspace's [sessions](/work/sessions/) (what agents are doing, at `g1t.sh/<workspace>/-/chat/sessions`), your channels, your direct messages, and your recent sessions. See [Chat](/guides/chat/). |
| **Work**     | The workspace's work items, their [Board](/work/board/), and its labels and milestones, at `g1t.sh/<workspace>/-/work`.                                                                                                                                                                   |
| **Code**     | Repositories, pull requests and checks. Not shown to a member without Code access.                                                                                                                                                                                                        |
| **Library**  | Your artifacts: documents, decks and pages, at `g1t.sh/<workspace>/-/library/artifacts`. See [artifacts](/guides/artifacts/).                                                                                                                                                             |
| **Routines** | Standing work g1t will run by itself, on a schedule or when something happens. Not available yet: the page shows what it will hold.                                                                                                                                                       |

After them come the apps you pinned, then:

| App           | Opens                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Apps**      | Every app the workspace has, to open one or pin it to the app bar.                                                                                                                                        |
| **Explore**   | g1t beyond your workspaces: public repositories, people and other workspaces.                                                                                                                             |
| **People**    | In the workspace's menu: everyone in the workspace, and its [teams](/guides/teams/). See [people and teams](/guides/people-and-teams/).                                                                   |
| **Workspace** | In the workspace's menu, as **Workspace settings**: the workspace's settings, opening on its profile: who has access, billing, and how each part of g1t is set up. See [Workspace mode](#workspace-mode). |

[Notifications](/guides/notifications/) are the bell at the app bar's end.

The app you are in sits on a filled pill. Your account is the
avatar at the app bar's end: your status, your profile and settings,
[appearance](#appearance), the documentation, support, status, the
keyboard's shortcuts, and signing out. Press <kbd>Ctrl</kbd> <kbd>K</kbd>
(<kbd>⌘</kbd> <kbd>K</kbd> on a Mac), or <kbd>?</kbd>, anywhere outside a
text field to see the keyboard's shortcuts; <kbd>/</kbd> is search. In
Chat, <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>O</kbd> (<kbd>⇧</kbd>
<kbd>⌘</kbd> <kbd>O</kbd> on a Mac) starts a [new chat with
g1t](/guides/chat/#start-a-conversation-with-g1t). On a work item's
page, single keys change its properties: see
[its keys](/work/work-items/#keys).

### Appearance

g1t comes in a dark theme and a light one. Until you choose, it follows
your system's setting.

| Choice    | What you see                                                           |
| --------- | ---------------------------------------------------------------------- |
| **Auto**  | Follows your system's light or dark setting, and changes when it does. |
| **Light** | A near-white page with white panels and a deeper lavender accent.      |
| **Dark**  | g1t's very dark gray with the lavender accent.                         |

To change it:

1. Select your avatar at the end of the app bar. On a phone, open **More**,
   then **You and help**.
2. Under **Appearance**, select **Auto** (the screen icon), **Light** (the
   sun) or **Dark** (the moon).

The page changes at once. You can also choose under
[Settings → Account](https://g1t.sh/settings/account), or press
<kbd>/</kbd> and run
**Use light theme**, **Use dark theme** or **Use auto theme**. Signed out,
the same commands are in search (<kbd>/</kbd>), and the phone's menu has the switch.

Your choice is kept in this browser, in a `g1t_theme` cookie, so every page
is drawn in it from the start; another browser or device starts on Auto.
Product screenshots on g1t.sh's home page stay dark in either theme.

These docs and [status.g1t.sh](https://status.g1t.sh/) also follow your
system's setting, each with its own switch for this browser: here, the
**Auto**, **Light** and **Dark** menu at the end of the header (at the foot
of the menu on a phone); on the status page, the three icons at the top.

### Developer mode

When a page fails, g1t says only that something went wrong. To see why,
turn on **Developer mode** under
[Settings → Account](https://g1t.sh/settings/account#developer). From then
on, a page that fails shows the error itself: its message and stack, the
address, the time, the routes the page was drawn from, the site's build
and your browser (and the desktop app's version, inside it). **Copy
details** copies all of it as one report, ready to paste into a support
request or a bug report.

Signed in, errors from g1t's side come through in full too, where
otherwise they read _Unexpected Server Error_. They are only ever about
your own requests. Like Appearance, the setting is kept in this browser, in
a `g1t_dev` cookie; turn it off the same way.

### The sidebar

The workspace you are in is named in the app bar, after g1t's mark. Select
it to open the workspace, its people or its settings, switch to another of
your workspaces, or make a new one; your own profile and settings are your
account's menu. The button at the left of the page's header hides the
sidebar, leaving the page wider, and brings it back; <kbd>Ctrl</kbd> <kbd>B</kbd> (<kbd>⌘</kbd> <kbd>B</kbd> on
a Mac) does both, except while you type. g1t remembers which you chose.
When the sidebar is hidden, or the app has none, the page's header starts
with the same switcher. Under the top row, **Search or jump to** opens the
same palette as <kbd>/</kbd>; in Chat and Artifacts, whose
sidebars search their own lists, it stays in the page's header.

Below it are the lists of the app you are in, each group under a small
heading. Code's lists the workspace's
[repositories](#pinned-and-recent-repositories), and drills into a repository's own
list when you open one, with **‹ All repositories** at the top to go back. Its
**Settings** opens one level further: **General**, **Deployments**,
**Domains**, **Guardrails**, **Repository**, **Access**,
**Branches and merging**, **Secrets and variables** and **Webhooks**, each
for the roles that can use it. A link straight to any of these pages opens
the sidebar already there.

Workspace's sidebar is the [workspace's settings area](#workspace-mode):
its **Profile**, then every settings page under its section's heading.

Below 1024px wide, the sidebar opens over the page from the left, from the
header's button, and closes when you open a page.

### Workspace mode

**Workspace settings**, in the workspace's menu in the app bar, is everything about the workspace
itself: who has access, what it spends, and how each part of g1t is set up
for it. It opens on the workspace's [Profile](#the-workspaces-profile).
There is no second Settings inside it: the sidebar is laid out like
GitHub's organization settings, with **Profile** at the top, then each
section under its heading. A page's own pages show under it while you are
on one of them. A page only owners open is left out for members.

| Section                            | Page                                                                     | Who     |                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|                                    | [**Profile**](#the-workspaces-profile)                                   | Members | The display name, picture, description and public details; for owners the billing email, Getting started, the address, [data residency](#data-residency) and deleting the workspace. Owners change it. `-/settings/profile`  |
| **Access**                         | [**Billing and plans**](/guides/usage-and-billing/)                      | Members | The plan, the spend limit and budget alerts, prepaying and every charge. Statements are at `-/settings/billing/entries`. `-/settings/billing`                                                                                |
|                                    | ↳ [**Usage**](/guides/usage-and-billing/#the-usage-page)                 | Members | What the workspace used, by product, repository and day. `-/settings/usage`                                                                                                                                                  |
|                                    | ↳ [**Provider costs**](/guides/usage-and-billing/#provider-cost-reports) | Members | Your AI providers' own cost reports, day by day and per person. `-/settings/provider-costs`                                                                                                                                  |
|                                    | **Members**                                                              | Members | Who is in the workspace and their roles, with search and filters; owners [invite people](#add-people), change roles, and see **Outside collaborators**. `-/settings/members`                                                 |
|                                    | ↳ **Invitations**                                                        | Owners  | Every invitation to join, filtered by where it stands; send one again, revoke it, copy its link. `-/settings/members/invitations`                                                                                            |
|                                    | [**Permissions**](/guides/permissions/)                                  | Owners  | Who may do what, part by part: the base permission, repositories, teams and chat. `-/settings/permissions`                                                                                                                   |
| **Code, planning, and automation** | **Repositories**                                                         | Members | Every repository, and for owners **Recently deleted**, where a [deleted repository](/guides/managing-repositories/#restore-a-repository) can be restored, or purged, for 30 days. `-/settings/repositories`                  |
|                                    | ↳ [**Rules**](/guides/rules/)                                            | Members | Rulesets across repositories, and their insights. `-/settings/rules`                                                                                                                                                         |
|                                    | [**Work**](/work/cycles/#turn-cycles-on)                                 | Members | Cycles on or off, their length, start day and cooldown, which those who can manage milestones change; and who sees each person's [spend](/guides/spend/#who-sees-each-persons-spend), which owners change. `-/settings/work` |
|                                    | [**AI**](/guides/ai/)                                                    | Members | The workspace's AI providers and models. `-/settings/ai`                                                                                                                                                                     |
|                                    | ↳ [**Guardrails**](/guides/guardrails/)                                  | Members | How long checks, the merge queue and merge checks may run. `-/settings/guardrails`                                                                                                                                           |
|                                    | [**Actions**](/guides/actions/)                                          | Members | How workflows run in the workspace: what jobs' tokens may do, and for owners the [workflows the workspace manages](#workflows-the-workspace-manages) in its repositories. `-/settings/actions`                               |
|                                    | ↳ [**Runners**](/guides/self-hosted-runners/)                            | Owners  | The workspace's self-hosted machines, their groups and registration tokens. `-/settings/runners`                                                                                                                             |
|                                    | [**Webhooks**](/guides/webhooks/)                                        | Members | Where the workspace's events are sent. Owners add and change them. `-/settings/webhooks`                                                                                                                                     |
|                                    | [**Chat**](/guides/chat/#workspace-chat-settings)                        | Members | Renaming and archiving channels, default channels. Owners change it. `-/settings/chat`                                                                                                                                       |
|                                    | ↳ **Emoji**                                                              | Members | The workspace's own emoji. `-/settings/emoji`                                                                                                                                                                                |
| **Security**                       | **Authentication security**                                              | Owners  | [Requiring two-factor authentication](#require-two-factor-authentication). `-/settings/authentication`                                                                                                                       |
|                                    | ↳ [**Single sign-on**](/guides/single-sign-on/)                          | Owners  | Your identity provider over SAML 2.0, OpenID Connect or OAuth 2.0, the people linked to it, and requiring it. Every paid plan. `-/settings/sso`                                                                              |
|                                    | **Code security**                                                        | Members | The workspace's security policies. `-/settings/security`                                                                                                                                                                     |
|                                    | [**Secrets and variables**](/guides/secrets-and-variables/)              | Members | What runs and deployments are given. Owners change them. `-/settings/secrets`                                                                                                                                                |
| **Third-party access**             | [**Access tokens**](#workspace-access-tokens)                            | Members | The workspace's own tokens. Owners create and delete them. `-/settings/tokens`                                                                                                                                               |
|                                    | **Personal access tokens**                                               | Owners  | The workspace's rules for members' tokens, and approving them. `-/settings/personal-access-tokens`                                                                                                                           |
| **Integrations**                   | [**Integrations**](/guides/integrations/)                                | Members | The tools connected for everyone. `-/settings/integrations`                                                                                                                                                                  |
| **Archive**                        | [**Audit log**](/guides/audit-log/)                                      | Members | Every change, by whom, to what. `-/settings/audit`                                                                                                                                                                           |

↳ marks a page that shows under the one above it. Each page's address is
under `g1t.sh/<workspace>/`. The page's header shows where you are:
**Profile**, **Members / Invitations**, **Permissions**.

`g1t.sh/<workspace>/-/settings` opens on the Profile. Code's
security alerts (`-/security`), Work, Packages, Insights, Spend, Teams, People,
Apps and Routines are pages of their own, not settings, and stay where
they were. To find someone, and what they work on, use the
[People directory](/guides/people-and-teams/#the-directory).

### Pinned and recent repositories

However many repositories a workspace has, Code's sidebar lists a few:

- **Pinned**: the repositories you pinned, in your order, up to eight a
  workspace. Pin one with **Pin** on its page, or the pin on its row of the
  Repositories page or its card on the Overview. Drag a pinned repository to move
  it, or hold <kbd>Alt</kbd> and press the up or down arrow.
- **Recent**: the repositories you opened last that you have not pinned, up to
  five.
- **All repositories**, with how many there are, opens the Repositories page.

Pins and recent repositories are yours: nobody else sees them, and each
workspace has its own. Search (<kbd>/</kbd>) finds any repository in the workspace, pinned or not.
From the API, use
[`GET /user/pinned_projects/{workspace}`](/reference/api/pinned-projects/list-pinned-projects/)
and the other [pinned repositories](/reference/api/pinned-projects/list-pinned-projects/)
operations, or the `workspace` tool's `list_pinned_projects`,
`pin_project`, `unpin_project` and `reorder_pinned_projects` actions
over MCP.

### On your phone

On a screen narrower than a tablet, g1t keeps the same places and moves
them within reach of your thumb:

|                                                          | What it does                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The bar along the bottom**                             | **Home**, **Work**, **Chat** and **Notifications**, each with what is unread, and **More**. Work is there for every member, with Code access or not. It runs flat along the bottom edge, and the page fills the screen above it. The app you are in is marked as in the app bar. It steps aside while the keyboard is up and inside a conversation.       |
| **More**                                                 | A panel above the bar with **Explore** first, then **Code** (for members with Code access), **All apps** and the apps you pinned, **Library**, **Routines**, **People**, **Workspace**, and **You and help**: your status, profile and settings, [appearance](#appearance), the documentation, support, status, the keyboard's shortcuts and signing out. |
| **The sidebar button**, at the left of the page's header | Opens the sidebar of the app you are in from the left, most of the screen wide: the same lists and links as on a computer. Tap outside it, or open a page, and it closes.                                                                                                                                                                                 |
| **The tab you are already on**                           | Tap it again to open that app's sidebar too: for **Work**, its views (**New work item**, **Plan**, **Board**, **Triage**, **All open**, **Assigned to you**, **Closed**, **Labels** and **Milestones**) and **Projects** (each project under way, and **New project**).                                                                                   |
| **The workspace's name** in the page's header            | Switches workspace, or opens your profile or settings.                                                                                                                                                                                                                                                                                                    |

Inside a [repository](/guides/repositories/), its pages (**Overview**, **Code**,
**Work**, **Pull requests**, **Workflows**, **Deployments**,
**Insights** and, for the roles that see them, **Security** and
**Settings**) run in a row under its name that scrolls sideways, with the
page you are on kept in view, so work items and pull requests are one tap
away. Pages with more than one view, such as **Files**, **Commits** and
**Branches**, show those as a second row of tabs.

Menus stay inside the screen, dialogs rise from the bottom and sit on top
of the keyboard while you type, and nothing scrolls the page sideways: a
wide file, diff or table scrolls within its own box.

### Signed out, and signing in

Signing in, signing up, an invite link, the two-factor step, choosing a new
password and making your first workspace each stand on their own: the g1t
logo, the form, and links to the terms, privacy policy, docs, status and
support at the foot. Someone who is not signed in reads public pages, such
as Explore, a profile or a public repository, under a plain header with
**Explore**, **Docs**, **Sign in** and **Sign up**; a repository's pages run in
the row under its name.

## Code's front page

Code opens on [the workspace's page](#the-workspaces-page),
`g1t.sh/<workspace>`: the workspace as an organization, its repositories
and its people. What needs you in the workspace's code (reviews asked of
you, changes ready to merge, failing checks, failed production builds,
repository invitations and a usage limit that is close or reached) is in
[Home's Your move](/guides/home/#your-move), with everything else waiting
on you; what landed is under
[Since you were last here](/guides/home/). Signed in, `g1t.sh` itself
opens [Home](/guides/home/) in the workspace you are in.

## Workspace access tokens

A workspace has access tokens of its own, for CI, integrations and coding
agents that work for a team. There is no shared service account to create, pay
for or lose the password to.

|                         | Personal token                                                                                                     | Workspace token                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Belongs to              | You                                                                                                                | The workspace                                                                                                                                                                            |
| Acts as                 | You                                                                                                                | The workspace: its name is the author of what it does                                                                                                                                    |
| Can reach               | All your workspaces, one of them, or none ([where a token reaches](/guides/authentication/#where-a-token-reaches)) | That workspace only: all of its repositories, or the ones chosen                                                                                                                         |
| Can do                  | What its [permissions](/guides/authentication/#permissions) allow, never more than you can                         | What its permissions allow, with Write on the workspace's repositories (Admin with Repositories: admin); it cannot manage people, tokens or workspaces, and holds no account permissions |
| Expires                 | 7 days to 1 year, or never where the workspaces it reaches allow                                                   | 7 days to 1 year, or never                                                                                                                                                               |
| When its creator leaves | Stops working                                                                                                      | Keeps working                                                                                                                                                                            |
| Created by              | You, in [Settings → Access tokens](https://g1t.sh/settings/tokens)                                                 | An owner, under the workspace's **Settings → Access tokens**                                                                                                                             |

They are the same kind of token and are sent the same way; see
[access tokens](/guides/authentication/#access-tokens). With git, any
username works; the token is the password. `GET /user` answers with
`"kind": "workspace"` for one, and `"kind": "user"` for a personal token.

Every member can see a workspace's tokens: the name, who created each,
its permissions and repositories, when it was last used and when it
expires. Only owners can create, change or delete them. An owner selects
**New token** and fills in the same form as a personal token: a name, an
expiration (No expiration shows a warning), its repositories (all, or the
ones chosen) and its permissions, starting on the CI preset. Each token
shows **Write** or **Admin**: give it **Repositories: admin** to let it
manage webhooks, secrets, deploy keys and who has access, and teams as an
owner would. Select a token to change its permissions or repositories, or
to delete it.

Which of your members' own personal tokens reach the workspace is set under
**Settings → Personal access tokens**; see
[a workspace's rules for tokens](/guides/authentication/#a-workspaces-rules-for-tokens).

## Profiles

Every person has a profile at `g1t.sh/u/<username>`, apart from the
workspaces at `g1t.sh/<workspace>`. Author names on work items and pull
requests link to it.

**What it shows.** Your picture, name, username, pronouns, bio, location,
website and when you joined; then your work in three tabs:

- **Overview:** your contribution calendar, then pull requests merged,
  open pull requests and work items opened, and your most recent activity.
- **Pull requests** and **Work items:** everything you opened, and what g1t
  opened for you, newest first,
  with filters beside the list for state (open, closed, merged), type,
  repository and sort order. Each tab has its own address, such as `g1t.sh/u/<username>/pulls`;
  add `?state=merged` and the like to
  link to a filtered list.

**The contribution calendar.** The last year as a square a day, a column a
week, shaded more strongly the more you did that day, with the total
above it ("128 contributions in the last year"). A contribution is a
commit you pushed, a work item or pull request you opened (or g1t opened for
you), and a review you gave. Days are counted in UTC. Hover over a square,
or tap it, to see its day, its count and how many were commits ("5
contributions on Oct 4, 2026, 3 of them commits"). On a narrow screen the
calendar scrolls sideways inside its card, starting at today.

Commits count like this:

- **Pushed to the default branch, or to `gh-pages`.** Commits on other
  branches count once they reach the default branch, which is usually a
  pull request, and the pull request is counted already.
- **Credited to whoever pushed,** on the day of the push, not to the
  commits' authors. Pushes with a workspace's or a workflow job's token are
  not counted on anyone's calendar.
- **The new commits along the branch's own line,** at most 50 a push. A
  merge commit counts once. The first push of a branch counts one, so
  importing a long history doesn't fill a single day.
- **Only from the time this was added:** pushes before 9 October 2026 are
  not counted.

**Edit it** in [Settings → Profile](https://g1t.sh/settings/profile). Every
field is optional. The bio takes up to 160 characters and is also what a
link to your profile says. The website must be an `https://` address;
`example.com` is saved as `https://example.com`. Your email address is
never shown.

**Time zone.** Pick the time zone you are in, by city or region (such as
`America/Denver`), and the [card over your name](#the-card-over-a-name)
shows your local time, so people can tell whether it is a good moment to
ask you something. If your browser's time zone differs from the one
saved, the field offers **Use my browser's time zone**. Choose **Not
shown** to clear it.

**Who sees what.** A profile is public, but the work and workspaces on it
are filtered for whoever is looking:

| On the profile                            | Shown to a visitor when                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A pull request, and its title             | They can read its repository: it is public, or they are a member of its workspace                 |
| A work item, and its title                | They are a member of its workspace, or can read the repository it was filed in                    |
| The counts, and the contribution calendar | Only what they could see is counted                                                               |
| A workspace                               | They are a member of it too, or you made a public repository in it, whose page shows that already |

Someone signed out sees your public work and the workspaces where you made
a public repository; nothing else, and their calendar counts only work in
public repositories. The link preview for a profile uses only public work.

**How it is laid out.** Signed out, a profile, Explore and Search are
shown with g1t's public header (search, Explore, Docs, signing in) and the page
at full width, with no workspace sidebar. Signed in, the app bar stays with
**Explore** lit, and Explore's sidebar opens beside these pages, with the
person you are looking at under **You are viewing** (see
[The app bar, the sidebar and the page](#the-app-bar-the-sidebar-and-the-page)).
Your own profile is browsing too, with **Your profile** lit.

### The card over a name

Hold the pointer over a person's name or picture anywhere on g1t, or move
the keyboard focus to their name, and a card opens with their profile at a
glance:

| On the card                                                             | Shown when                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Picture, name, username and pronouns                                    | Always                                                                                                       |
| Bio and location                                                        | They filled them in                                                                                          |
| Their local time, such as **3:42 PM local time**                        | They set a [time zone](#profiles)                                                                            |
| **Member of**                                                           | The same workspaces their profile shows you, at most three named                                             |
| **Committed to this repository in the past day**, **week** or **month** | You opened it inside a repository you can read, and their latest commit on its default branch is that recent |

On a touch screen no card opens: a tap goes to the profile. `@g1t` has a
card of its own, about putting g1t to work. `ghost`, which stands in for
deleted accounts, has no card.

### Commits and your account

A commit shows as yours, with your username, picture, profile link and
card, when its author address is one of your
[confirmed addresses](/guides/authentication/#email-addresses) or your
noreply address. This holds everywhere a commit appears: the Files page,
history, a commit, blame, branches, tags, comparisons and the
Contributors list, which counts every address of yours as one person.

To have commits made on your own machine show as yours without publishing
your address, commit with your noreply address:

1. Open [Settings → Emails](https://g1t.sh/settings/emails) and copy your
   noreply address. It looks like
   `<8 characters of your account id>+<username>@users.noreply.g1t.sh`.
2. Set it for every repository, or leave out `--global` for one:

   ```sh
   git config --global user.email "6c1d0efg+sam@users.noreply.g1t.sh"
   ```

3. Commit and push as usual. Commits you made before keep the address they
   were made with; add that address to your account and confirm it to have
   them show as yours.

| A commit's address                                                                                           | Shown as                                                          |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| One of your confirmed addresses, or your noreply address                                                     | You                                                               |
| An address added to an account but not confirmed                                                             | The name in the commit                                            |
| An address no account has                                                                                    | The name in the commit, with a plain picture, no link and no card |
| A deleted account's noreply address, or any of its confirmed addresses during the 30 days it can be restored | `ghost`                                                           |
| g1t's own (`g1t@users.noreply.g1t.sh`)                                                                       | `g1t`                                                             |

`Co-authored-by` trailers are matched the same way, and their pictures sit
beside the author's. An address itself is never shown on g1t.
