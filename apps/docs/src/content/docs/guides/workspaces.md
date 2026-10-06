---
title: Workspaces
description: Workspaces, their names and icons, renaming and deleting one, members and roles, and access tokens that belong to a workspace.
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
`workspace` tool's `create` action:

```sh
curl -X POST https://api.g1t.sh/workspaces \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug": "acme", "name": "Acme"}'
```

You can belong to up to ten workspaces. `GET /user`, or the `account` tool's `whoami` action, lists the
ones you belong to.

Usernames and workspaces share one set of names, so a name means the same
thing wherever it appears. Your username is reserved for you: only you can
create a workspace with that name, and nobody can register a username that
is already a workspace. The names `g1t` and `g1t-agent` belong to
[g1t's agent](/guides/working-with-g1t/), and nobody can register them.

## Display name, slug and icon

A workspace has two names:

| | Example | Where it appears | Changes |
| --- | --- | --- | --- |
| **Display name** | `Flagon Industries` | The sidebar, the top of its page, mission control and link previews | Any time, up to 80 characters; spaces and capitals are fine |
| **Slug** | `flagon` | Every address: `g1t.sh/flagon/<repo>`, clone URLs, API paths and `g1t.page` app addresses | By an owner, once a day at most; the old one redirects for 90 days. See [rename a workspace](#rename-a-workspace) |

Without a display name, the slug is shown. Where an address is shown, the
slug is in monospace beside the name. Owners change the display name and
description (up to 160 characters) on **Settings → General**, or with
[`PATCH /workspaces/{workspace}`](/reference/api/workspaces/update-workspace/)
(MCP: `workspace` `update`), which takes `name` and `description` and
changes only the fields given. It needs the `workspace:admin` scope, and
is recorded in the [audit log](/guides/audit-log/):

```sh
curl -X PATCH https://api.g1t.sh/workspaces/flagon \n  -H "Authorization: Bearer $G1T_TOKEN" \n  -H "Content-Type: application/json" \n  -d '{"name": "Flagon Industries", "description": "Rockets, and the software that flies them."}'
```

Neither changes the slug; that is a [rename](#rename-a-workspace).

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
[Settings → Profile](https://g1t.sh/settings/profile).

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
| API and MCP | A call that names the old slug runs under the new one. |
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

## Delete a workspace

Deleting a workspace takes everything in it with it, in one step: its
repositories, projects, apps, members' access and tokens. Only an owner can,
signed in as a person, typing the workspace's slug to confirm.

It is not gone at once. For **30 days** g1t keeps all of it, so that a
deletion you did not mean, or did not make, can be undone: an owner writes
to support@g1t.sh, and support restores the workspace as it was. After 30
days it is purged for good.

1. Open the workspace's **Settings → General** and go to **Danger zone**.
   It lists what will go with the workspace: its repositories, projects,
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

| | |
| --- | --- |
| Money owed | Charged to the workspace's card at once, with no minimum charge. With no card, add one or pay from **Billing** first. |
| An unpaid invoice | Pay it from **Billing** first. |
| Prepaid credit | It would be lost: spend it, or write to support@g1t.sh about a refund, first. |
| Usage this month still being metered | Storage and git operations are charged when the month closes. You can delete the workspace from the 1st of next month. |
| The g1t plan | Ends at Stripe at once, not at the end of the period. |
| An enterprise account | A workspace billed through one is moved off it by g1t first: write to support@g1t.sh. |

A comped workspace owes nothing; only its plan is ended.

### What happens

At once, when an owner deletes it:

| | |
| --- | --- |
| Members | Lose access, and the workspace leaves their list. Their own accounts are not touched: a person with no workspace left can still sign in, and create or join one. |
| Access tokens | The workspace's own tokens stop working. Personal tokens are not affected. |
| Repositories | Deleted with it: git refuses them, and their pages answer 404. Agents and workflow runs stop. Ones deleted on their own earlier stay deleted. |
| Projects and apps | Hidden. Its apps are taken offline and nothing builds. Custom domains are kept for a restore. |
| Its pages | Answer 404, and it drops out of search. |
| Billing | What it owes is charged, and its plan ends, as [billing needs](#what-billing-needs). Nothing more is charged. |
| The audit log | Records the deletion. |

Within 30 days, support can restore it: its members, tokens, repositories,
projects and apps come back as they were, and its apps go back up as its
limit allows. Its plan does not come back by itself: an owner starts it
again from **Billing**. A repository deleted on its own before the
workspace was stays in **Recently deleted**.

After 30 days it is purged:

| | |
| --- | --- |
| Repositories | Purged, their git data with them, including any that were in Recently deleted. |
| Projects, apps and custom domains | Removed. |
| Webhooks, integrations, secrets and variables | The workspace's own are removed. |
| Memory and guardrails | The workspace's own are removed. |
| Statements, invoices and the ledger | Kept, for accounting. |
| The audit log | Kept as [long as its account keeps it](/guides/audit-log/#how-long-it-is-kept), with the purge as its last entry: once the plan ends with the workspace, that is 7 days, unless an enterprise pays for it or longer was arranged. With no owners left, ask support@g1t.sh for an export. |
| Old addresses | Redirects for repositories transferred out keep working. The workspace's own pages answer 404. |

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

| Role | Can |
| --- | --- |
| Member | Create repositories, see the workspace's usage and billing, and get the workspace's [base permission](/guides/access-and-roles/#the-base-permission) on every repository in it: Write unless an owner changes it, which is enough to push, manage issues, merge pull requests, plan work and put g1t to work. |
| Owner | Everything a member can, and manage members, the base permission, the workspace's access tokens, its details, and billing: the plan, card checks, prepayment and limits. Admin on every repository, and the only ones who can transfer and delete them; see [access and roles](/guides/access-and-roles/). |

Whoever creates a workspace is its owner. An owner adds people on the
workspace's **Members** (in the sidebar), `g1t.sh/<workspace>/-/people`:

- **By username**: someone already on g1t joins at once, as a member.
- **By email address**: g1t emails an invite that only that address can
  use. Without a g1t account, accepting it makes the account and joins the
  workspace in one step, and uses one of the workspace's granted invites, or
  else one of yours (see [invites](/guides/authentication/#invites)). With
  an account, it costs nothing, and they join when they accept. The page
  never says which it was.

The email names you and the workspace and links to the invite's page.
Someone new signs up right there, with the invited address filled in and
already confirmed; someone with an account signs in. Either way they land
in the workspace as a member, with a one-time welcome. See
[using an invite](/guides/authentication/#using-an-invite).

Pending invites are listed under the members, with a link to copy and
**Revoke**. An owner can also remove a member there. Through the API, use
[`POST /workspaces/{workspace}/invitations`](/reference/api/invites/invite-member/)
(the `workspace` tool's `invite_member` action over MCP).

To give someone a role on one repository without making them a member,
add them as an [outside collaborator](/guides/access-and-roles/#outside-collaborators).

## The workspace's pages

A workspace's page, `g1t.sh/<workspace>`, shows its repositories and the
pull requests in progress across them. Each person sees the repositories
they can read: a member whose base permission is None, an
[outside collaborator](/guides/access-and-roles/#outside-collaborators)
or a visitor sees the public ones and those shared with them, without the
workspace's members, deployments or settings. Its members also see a
**Usage** card there with this month's spend.

The sidebar is one list, in groups: **Mission control**, the workspace's
**Overview** and **Explore**; its projects; what it builds and runs with
across them (**Agent fleet**, **Context**, **Memory**, **Security**,
**Guardrails**, [**Secrets and variables**](/guides/secrets-and-variables/),
[**Integrations**](/guides/integrations/) and
[**Webhooks**](/guides/webhooks/)); then **Usage**, what g1t's runs have
cost (see [usage and billing](/guides/usage-and-billing/)), **Support** and
**Settings**. An item with an arrow opens a list of its own in the sidebar:
**Settings** slides over to the workspace's settings, and the row at the
top, **‹ Settings**, slides back:

| Settings | Who | |
| --- | --- | --- |
| **General** | Owners | The icon, the display name, a one-line description and the address (the slug). |
| **Members** | Members | Who belongs, and their roles. Owners add and remove people, set the [base permission](/guides/access-and-roles/#the-base-permission), and see the **Outside collaborators** tab. |
| **Repositories** | Members | The workspace's repositories. Owners also see **Recently deleted**, where a [deleted repository](/guides/managing-repositories/#restore-a-repository) can be restored, or purged, for 30 days. |
| **Access tokens** | Members | The workspace's own tokens. Owners create and delete them. |
| **Billing and plans** | Members | [The g1t plan](/guides/usage-and-billing/#the-g1t-plan), [limits](/guides/usage-and-billing/#limits) and the statement. Owners start the plan, check a card, prepay and set limits. |
| **Audit log** | Members | [Every action agents, people and tokens took](/guides/audit-log/). |

Integrations, secrets and variables, webhooks and guardrails are in the
main list. Members see each; owners change them.

Opening a [project](/guides/projects/) slides the sidebar over to the
project's own list, with **‹ All projects** at the top to go back. Its
**Settings** opens one level further: **General**, **Deployments**,
**Domains**, **Agents**, **Guardrails**, **Repository**, **Access**,
**Branches and merging**, **Secrets and variables** and **Webhooks**, each
for the roles that can use it. A link straight to any of these pages opens
the sidebar already there.

## Mission control

Mission control, `g1t.sh` when you are signed in, is your home page. It
shows where you are needed in the workspace you have chosen in the
sidebar, what its agents are doing, and what landed without you.

Under the greeting, one line sums up the week, such as *Agents landed 39
of 47 changes this week without you*. A change landed without you when
g1t merged it, by auto-merge or from the [merge queue](/guides/merge-queue/),
with no person pressing merge. **Review N that need you** jumps to the
list, and **New issue** opens a new issue in the project you pick.

| Across the top | What it counts |
| --- | --- |
| **Projects** | The workspace's projects, and how many were added this month. |
| **Agents** | Agent runs going now, and the hours agents worked in the last 7 days. |
| **Changes this week** | Pull requests merged in the last 7 days, and the change from the 7 days before. The change is left out when g1t cannot read far enough back to count it. |
| **Landed without you** | The share of those changes that g1t merged with no person pressing merge. |
| **Need you** | What is waiting on you, and how many of those block work. |

The list has three tabs. Each row opens to say more; the first is open.

| Tab | What it lists |
| --- | --- |
| **Needs you** | Pull requests g1t stopped seeing through, reviews asked of you, changes ready for you to merge, failed checks, quiet agents, failed production builds, repository invitations and a usage limit that is close or reached. |
| **Waiting on agents** | Pull requests in an agent's hands (making the change, checking, reviewing, revising, catching up or in the merge queue), and runs going now. |
| **Landed today** | Pull requests merged today in your time zone, and whether a person merged them. |

Each row in **Needs you** carries the reason it needs you:

| Reason | Means |
| --- | --- |
| `BLOCKING` | Nothing moves until a person acts: a failed production build, a merge g1t could not make, or the usage limit. |
| `ASKED FOR YOU` | A review or an invitation addressed to you by name. |
| `CHECKS FAILING` | A required check still fails after the agent revised. |
| `OUTSIDE GUARDRAILS` | A run reached a cost or time cap set in [Guardrails](/guides/guardrails/). |
| `NEEDS REVIEW` | The repository wants a person's approval, or the review still asks for changes after the agent revised. |
| `STALLED` | An agent stopped, or has reported nothing for 10 minutes. |
| `READY TO MERGE` | Checks passed and it was approved; the repository lands changes only when a person merges them. |

Opened, a row shows **The ask** (what g1t stopped with, and who the work
was started for), **What the agent already knows** (its checks, the files
and lines it changes, the test files it touches, how often the agent was
sent back, and what its runs cost) and **Why this needs you**. From
there, **Review and respond** opens it, and where it can be done without
leaving the page you can approve the change, merge it or re-run its failed
jobs. **By impact** puts the most urgent first; **Newest** sorts by time.

On the right, **This week** charts the changes landed each day, split
into those agents landed alone and those a person merged, with what
agents and sandboxes cost over the same days. **Activity** lists what
moved across the workspace, agents marked apart from people. The page
refreshes itself while agents are at work.

## Workspace access tokens

A workspace has access tokens of its own, for CI, integrations and agents
that work for a team. There is no shared service account to create, pay
for or lose the password to.

| | Personal token | Workspace token |
| --- | --- | --- |
| Belongs to | You | The workspace |
| Acts as | You | The workspace: its name is the author of what it does |
| Can reach | Every workspace you belong to | That workspace only |
| Can do | What its [scopes](/guides/authentication/#scopes) allow, never more than you can | What its scopes allow, on the workspace's repositories; it cannot manage people, tokens or workspaces |
| Expires | 7, 30 or 90 days (the default), 1 year, or never | The same choices |
| When its creator leaves | Stops working | Keeps working |
| Created by | You, in [Settings → Access tokens](https://g1t.sh/settings/tokens) | An owner, under the workspace's **Settings → Access tokens** |

They are the same kind of token and are sent the same way; see
[access tokens](/guides/authentication/#access-tokens). With git, any
username works; the token is the password. `GET /user` answers with
`"kind": "workspace"` for one, and `"kind": "user"` for a personal token.

Every member can see a workspace's tokens: the name, who created each,
when it was last used and when it expires. Only owners can create or
delete them. An owner creates one with a name, an expiry (No expiry shows
a warning) and the same scope checklist as a personal token, starting on
the CI preset.

## Profiles

Every person has a profile at `g1t.sh/u/<username>`, apart from the
workspaces at `g1t.sh/<workspace>`. Author names on issues and pull
requests link to it.

**What it shows.** Your picture, name, username, pronouns, bio, location,
website and when you joined; then your work in three tabs:

- **Overview:** pull requests merged, open pull requests and issues
  opened, and your most recent activity.
- **Pull requests** and **Issues:** everything you opened, and what g1t
  opened for you, newest first,
  with filters beside the list for state (open, closed, merged), type,
  repository and sort order. Add `?tab=pulls&state=merged` and the like to
  link to a filtered list.

**Edit it** in [Settings → Profile](https://g1t.sh/settings/profile). Every
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
