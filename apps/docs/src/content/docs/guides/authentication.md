---
title: Accounts and authentication
description: Accounts, invites, email addresses, confirming them, fine-grained and classic personal access tokens, scopes and permissions, a workspace's rules for tokens, OAuth, signing in from a tool, password reset and your security log.
---

## Creating an account

g1t is invite-only for now: to make an account you need an
[invite](#invites). Open the link in your invite, or enter its code at
[g1t.sh/register](https://g1t.sh/register). Without one, ask for access
on the same page. Usernames are lowercase letters, digits and single
hyphens, up to 39 characters.

Accounts can only be created in a browser. There is no API for it, by
design: it keeps passwords out of scripts and agents, and lets g1t protect
the one place accounts are made.

## Your settings

Your own settings are at [g1t.sh/settings](https://g1t.sh/settings), one
page each. Open them from your account menu at the bottom of the sidebar,
under **Your settings**; the sidebar then lists every page.

| Page | Address | What is on it |
| --- | --- | --- |
| Profile | [`/settings/profile`](https://g1t.sh/settings/profile) | Your picture, and your [public profile](/guides/workspaces/#profiles): name, pronouns, bio, location and website. |
| Emails | [`/settings/emails`](https://g1t.sh/settings/emails) | Your [email addresses](#email-addresses), the backup address, and [keeping your address private](#keeping-your-address-private). |
| Invites | [`/settings/invites`](https://g1t.sh/settings/invites) | [Making, copying and revoking invites](#invites). |
| SSH keys | [`/settings/keys`](https://g1t.sh/settings/keys) | Public keys for [git over SSH](/guides/git/#ssh), each with when it was added and last used. |
| Access tokens | [`/settings/tokens`](https://g1t.sh/settings/tokens) | Your [personal access tokens](#access-tokens): fine-grained and classic. |
| GitHub | [`/settings/github`](https://g1t.sh/settings/github) | [Linking and unlinking GitHub](/guides/github/#link-and-unlink-github). |
| Connected applications | [`/settings/applications`](https://g1t.sh/settings/applications) | Tools you [signed in to with OAuth](#signing-in-with-oauth), such as an agent using the MCP server. |
| Security log | [`/settings/security-log`](https://g1t.sh/settings/security-log) | [What happened to your account](#security-log). |

`g1t.sh/settings` opens Profile.

## Signing in with GitHub

**Continue with GitHub** on the sign-in and sign-up pages signs you in with
your GitHub account, and makes a g1t account the first time. Link or
unlink GitHub in [Settings → GitHub](https://g1t.sh/settings/github). See
[GitHub](/guides/github/#sign-in-with-github).

Making an account with GitHub needs an invite too: start from your invite
link, or enter the code when g1t asks for it after GitHub.

## Invites

While g1t is invite-only, every new account needs an invite code, such as
`g1t-k7m2-q9xd-…`. People already on g1t make them, and g1t sends them to
people who [asked for access](#asking-for-access). An invite:

- works once, for one new account;
- works for 30 days;
- when it was made for an email address, works only with that address;
- can be revoked by whoever made it until it is used.

### Using an invite

Every invite email links to `g1t.sh/invite/<code>`. That one page shows
who sent it and what it is for (joining a workspace, collaborating on a
repository, or just making an account), and finishes the job there:

1. **No account yet**: sign up on the page. When the invite was sent to
   your address, the email field is filled in and locked, and the address
   is confirmed already, so no confirmation email follows. Choose a
   username (one is suggested from your address) and a password, or select
   **Continue with GitHub**: the invite rides along, and the account uses
   the invited address when GitHub has verified it too.
2. **The address already has an account**: select **Sign in to accept**.
   After you sign in, the invite is accepted for you.
3. **Signed in as someone else**: an invite sent to one address works only
   for an account that has confirmed that address. The page says so and
   offers **Sign out and continue**.

Once the account exists or you have signed in, you land in the workspace
(or the repository) the invite was for, already a member, with a one-time
"You're in" banner, and it becomes the workspace your sidebar shows. A
code typed at [g1t.sh/register](https://g1t.sh/register) goes to the
same page.

An expired, revoked or used invite says which, and who sent it, so you
can ask them for a new one; or ask for access from the same page.

### Making invites

1. Open [Settings → Invites](https://g1t.sh/settings/invites).
2. Optionally enter the email address of the person you are inviting.
   With one, g1t emails them the invite, and only that address can use it.
   Without one, anyone with the link can, once.
3. Select **Create invite**, then copy the link.

Each person can have **5** invites out at a time. Pending and used invites
count; an invite you revoke, or one that expires before anyone uses it,
comes back to you. The list under the form shows each invite's state:
pending, joined (with the username of who joined), expired or revoked. You
must confirm your email before you can make invites. An agent's token and
a workspace's token cannot make them.

### Inviting someone into a workspace

An owner can invite an email address straight into a workspace from its
People page; see [members and roles](/guides/workspaces/#members-and-roles).
When the address has no g1t account, accepting makes the account and joins
the workspace in one step, and it uses one invite. Inviting someone who is
already on g1t costs nothing.

### Need more invites?

Write to [hey@flagon.io](mailto:hey@flagon.io?subject=%5Bg1t%20Invites%5D%20)
with the subject `[g1t Invites]` and say who you would like to bring. g1t
can give more invites to you, or to a workspace, whose owners then share
them. Invites given to a workspace appear under
[Settings → Invites](https://g1t.sh/settings/invites) for
each of its owners, as a choice of whose invites to use.

### Asking for access

Without an invite, [g1t.sh/register](https://g1t.sh/register) asks for your
email address and, if you like, what you will build. g1t emails that
address once to confirm you are on the list, and staff see the request
straight away. When they approve it, the invite comes to the same address,
sometimes with a note, and its link opens sign-up with the address filled
in. There is no fixed date: g1t opens up a few people at a time. Asking
again with the same address updates your request without another email; it
does not move you down the list.

### Invites through the API

| Route | MCP tool and action | What it does |
| --- | --- | --- |
| [`GET /user/invites`](/reference/api/invites/list-invites/) | `account` `list_invites` | Your invites and how many you have left |
| [`POST /user/invites`](/reference/api/invites/create-invite/) | `account` `create_invite` | Make an invite, optionally for one `email` |
| [`DELETE /user/invites/{id}`](/reference/api/invites/revoke-invite/) | `account` `revoke_invite` | Revoke a pending invite |
| [`POST /workspaces/{workspace}/invitations`](/reference/api/invites/invite-member/) | `workspace` `invite_member` | Invite an address into a workspace. Owners only. |

## Confirming your email

g1t sends a confirmation link from `noreply@g1t.sh`. It works for 24 hours.

Until you follow it you can sign in and look around, but you cannot create
repositories, push, or open issues and pull requests. Those requests fail with `403` and a
message telling you to confirm your address. To get a new link, sign in and
use the banner at the top of the site.

## Email addresses

An account can have up to 10 email addresses. Manage them in
[Settings → Emails](https://g1t.sh/settings/emails).

| An address that is | Can |
| --- | --- |
| Primary | Get account mail and password reset links. Exactly one, always confirmed once any address is. |
| Confirmed | Sign you in (type it instead of your username), ask for a password reset, and mark commits that carry it as yours. |
| Backup | Get security notices as well as the primary. Optional, and a confirmed address other than the primary. |
| Unconfirmed | Nothing yet. It is not yours until you follow the link g1t sent it. |

A confirmed address belongs to one account. Anyone can add an address they
have not confirmed; the first account to follow its link keeps it, and the
address leaves every other account that added it. An address another
account has confirmed cannot be added.

### Add an address

1. Open [Settings → Emails](https://g1t.sh/settings/emails).
2. Enter the address under **Add an email address** and select **Add**.
3. Follow the link g1t sends it. The link works for 24 hours; **Resend
   link** sends a new one, at most once a minute and 10 times an hour.

If your account had no confirmed address yet, the first one you confirm
becomes your primary.

### Choose your primary and backup

Select **Make primary** beside a confirmed address. Under **Backup
address**, choose a confirmed address to get security notices too, or
**Primary address only**.

### Remove an address

Select **Remove** beside it. You cannot remove your primary address (make
another one primary first) or your last confirmed address.

### Confirming it is you

Adding or removing an address, and changing your primary or backup, need
proof that it is you: a sign-in in the last 10 minutes, or your password,
which g1t asks for on the page. After you enter it, g1t does not ask again
for 10 minutes. An account that signs in only with GitHub signs out and in
with GitHub again, or sets a password with
[Forgot your password](https://g1t.sh/forgot).

Each of these changes is emailed to every confirmed address on the account,
including an address that was just removed, and written to your
[security log](#security-log).

### Keeping your address private

**Keep my email address private** is on for every account unless you turn
it off. While it is on, commits g1t makes for you (merging a pull request
on the web, catching a branch up, and commits an agent makes for you) carry
your noreply address instead of your primary:

```
<8 characters of your account id>+<username>@users.noreply.g1t.sh
```

The page shows yours. It never receives mail. Turn the setting off to put
your primary address on those commits instead.

**Block pushes that expose my email** refuses a push that would publish one
of your addresses while you keep it private. When both settings are on,
g1t reads the new commits in each push you make, and declines the push if
any of them has one of your confirmed addresses as its author or committer
address. git shows why, with the address masked:

```
remote: push declined: commit 3f9a1c2 would publish s***@gmail.com while your email is private.
remote: Commit with 6c1d0efg+sam@users.noreply.g1t.sh (git config user.email 6c1d0efg+sam@users.noreply.g1t.sh) and amend,
remote: or change this in g1t.sh/settings/emails.
```

To push those commits:

1. Set your noreply address for the repository:
   `git config user.email <your noreply address>`.
2. Rewrite the commits with it. For the last commit,
   `git commit --amend --reset-author --no-edit`; for several,
   `git rebase <base> --exec "git commit --amend --reset-author --no-edit"`.
3. Push again.

Only your own addresses are checked: commits by other people in the same
push go through, and so does your noreply address. A push an agent makes
for you follows your settings.

### How commits are attributed

g1t shows a commit as yours, with your picture and a link to your profile,
when its author address is one of your confirmed addresses or your noreply
address. Commits that g1t made for you before noreply addresses existed
(`<username>@users.g1t.sh`) count as yours too. An unconfirmed address
never attributes a commit, so nobody can claim your commits by adding your
address. Commits whose address matches no account show the name in the
commit.

### Email addresses through the API

| Route | MCP tool and action | What it does |
| --- | --- | --- |
| [`GET /user/emails`](/reference/api/accounts/list-emails/) | `account` `list_emails` | Your addresses and email settings |
| [`POST /user/emails`](/reference/api/accounts/add-email/) | `account` `add_email` | Add an address; takes `email` and `password` |
| [`DELETE /user/emails/{email}`](/reference/api/accounts/remove-email/) | `account` `remove_email` | Remove an address; takes `password` |
| [`PATCH /user/email-settings`](/reference/api/accounts/update-email-settings/) | `account` `update_email_settings` | Change `primary`, `backup`, `private_email` or `block_private_pushes` |

Through the API, `password` is the proof a sensitive change needs. Without
it, or with the wrong one, the answer is `403` with the code
`reauth_required`. Only a person's own token can use these: an agent's
token and a workspace's token are refused.

## Workspaces

Your account does not own repositories itself: a workspace does. After
confirming your email, the first thing you do is create one. Workspaces,
their members and roles, and the access tokens that belong to a workspace
are covered in [workspaces](/guides/workspaces/).

## Access tokens

A token stands in for your password everywhere outside the website:

| Where | How to send it |
| --- | --- |
| git | As the password, with your username. |
| API | `Authorization: Bearer g1t_…` |
| MCP | The same header, set when you add the server. |

A token is shown once, when it is created; g1t stores only a hash of it.
If you lose one, delete it and create another. Delete a token the moment
you think someone else has seen it.

There are two kinds of personal access token, on two tabs of
[Settings → Access tokens](https://g1t.sh/settings/tokens):

| | Fine-grained token | Classic token |
| --- | --- | --- |
| Reaches | One resource owner: one workspace you belong to, or your own account | Every workspace and repository you can reach, including ones you join later |
| Repositories | All of the workspace's, the ones you choose (up to 50), or public ones only | All you can reach |
| What it may do | A level for each [permission](#permissions) | Its [scopes](#scopes) |
| Expires | Always, within 366 days | 7 days to 1 year, or never |
| A workspace can | Require an owner's approval first, or keep them out | Keep them out |

Both never do more than you could on the website, and both are sent the
same way. Prefer a fine-grained token: it reaches only what it needs.

For CI and integrations that work for a team, a workspace can have tokens
of its own that act as the workspace and keep working when their creator
leaves. See [workspace tokens](#workspace-tokens).

### Create a fine-grained token

1. Open [Settings → Access tokens](https://g1t.sh/settings/tokens). The
   **Fine-grained tokens** tab is first.
2. Under **New fine-grained token**, give it a **Token name** after what
   will use it, and optionally a **Description**, which a workspace's
   owners see if they review it.
3. Choose the **Resource owner**: a workspace you belong to, or **Your
   account**. A workspace that does not allow fine-grained tokens cannot be
   chosen.
4. Choose its **Expiration**: 7, 30, 60, 90 or 180 days, or 1 year, or
   less when the workspace sets a shorter limit.
5. Under **Repository access**, choose **Public repositories** (read-only),
   **All repositories** of the workspace (including ones made later), or
   **Only select repositories**, and tick up to 50.
6. Under **Permissions**, set each one the token needs to **Read-only** or
   **Read and write** (and **Admin** for packages). **Metadata** is always
   read-only. Each row shows the g1t scopes its level gives.
7. Select **Generate token**, and copy it. It is not shown again.

When the workspace [requires approval](#a-workspaces-rules-for-tokens) and
you are not one of its owners, the token is made **Pending approval**: it
works at once, but reads public repositories only until an owner approves
it. The owners hear of it in their [inbox](/guides/inbox/), and you hear of
their answer in yours. An owner's own token never waits.

Select **Edit** on a token to change its name, description, repositories
or permissions. The token stays the same. Widening it in a workspace that
requires approval asks again. Its resource owner and expiry cannot change;
make a new token instead.

The list shows each token's status (pending, denied or revoked, with the
owner's note), what it reaches, its permissions, and when it was made, last
used and expires.

### Permissions

Each level of a fine-grained token's permissions gives g1t
[scopes](#scopes), and the token is checked by those scopes
exactly as a classic token is. Where two permissions give the same scopes
(Checks and Commit statuses; Secrets and Variables; Deployments and Pages),
giving either gives both.

Repository permissions, for a workspace as the resource owner:

| Permission | Levels | What it covers | g1t scopes it gives |
| --- | --- | --- | --- |
| `actions` (Actions) | read, write | Workflow runs, jobs, logs and artifacts: reading them, and running, cancelling and rerunning workflows | read: `workflows:read`; write: `workflows:write` |
| `administration` (Administration) | read, write | Repository settings, rulesets, who has access and deploy keys; renaming, archiving, transferring and deleting | read: `repo:read`, `access:read`; write: `repo:admin`, `access:admin` |
| `agents` (g1t agents) | write | Putting g1t's agents to work and messaging them, which uses the workspace's money | write: `agents:run` |
| `checks` (Checks) | read, write | Check runs and check suites on commits. Shares its scopes with Commit statuses | read: `checks:read`; write: `checks:write` |
| `contents` (Contents) | read, write | Code, branches, commits and releases: cloning and fetching, pushing, and publishing releases | read: `code:read`; write: `code:write`, `repo:write` |
| `deployments` (Deployments) | read, write | Deployments and their statuses | read: `deployments:read`; write: `deployments:write` |
| `environments` (Environments) | read, write | Environments, and their secrets and variables | read: `deployments:read`, `secrets:read`; write: `secrets:admin` |
| `issues` (Issues) | read, write | Issues, their comments, labels and milestones, and plans | read: `issues:read`; write: `issues:write` |
| `memory` (Memory and context) | read, write | Recalling memory and searching the workspace's context, and saving memory for the next agent | read: `memory:read`; write: `memory:write` |
| `metadata` (Metadata) | read | Seeing repositories and searching them. Always read | read: `repo:read` |
| `packages` (Packages) | read, write, admin | Pulling private packages, publishing them, and (admin) deleting packages and versions | read: `packages:read`; write: `packages:write`; admin: `packages:delete` |
| `pages` (Pages) | read, write | Deployments on g1t.page. Shares its scopes with Deployments | read: `deployments:read`; write: `deployments:write` |
| `pull_requests` (Pull requests) | read, write | Pull requests, their reviews, changes, sessions and merge queues | read: `pull_requests:read`; write: `pull_requests:write` |
| `secrets` (Secrets) | read, write | Actions secrets: listing them (never their values), setting and deleting them. Shares its scopes with Variables | read: `secrets:read`; write: `secrets:admin` |
| `security_events` (Security events and alerts) | read, write | Code scanning, secret scanning and vulnerability alerts, SARIF uploads and security settings | read: `security:read`; write: `security:write` |
| `statuses` (Commit statuses) | read, write | Statuses on commits. Shares its scopes with Checks | read: `checks:read`; write: `checks:write` |
| `variables` (Variables) | read, write | Actions variables: reading, setting and deleting them. Shares its scopes with Secrets | read: `secrets:read`; write: `secrets:admin` |
| `webhooks` (Webhooks) | read, write | Webhooks and their deliveries | read: `webhooks:read`; write: `webhooks:admin` |
| `workflows` (Workflows) | write | Adding, changing and deleting workflow files under .g1t/workflows and .github/workflows. Write only | write: `workflow_files:write` |

Workspace permissions, for a workspace as the resource owner:

| Permission | Levels | What it covers | g1t scopes it gives |
| --- | --- | --- | --- |
| `members` (Members) | read, write | The workspace's people, invitations and teams | read: `workspace:read`; write: `workspace:admin` |
| `workspace_administration` (Administration) | read, write | The workspace's settings, integrations, rulesets and base permission | read: `workspace:read`, `access:read`; write: `workspace:admin`, `access:admin` |
| `workspace_billing` (Billing) | read, write | Usage, budget, AI credit and invoices, and (write) changing the budget and buying credit | read: `billing:read`; write: `billing:write` |
| `models` (AI Gateway) | read, write | AI Gateway requests: seeing them, and sending requests, which uses the workspace's AI credit | read: `models:read`; write: `models:write` |
| `self_hosted_runners` (Self-hosted runners) | read, write | Runners, their groups and settings | read: `runners:read`; write: `runners:admin` |
| `workspace_secrets` (Secrets) | read, write | The workspace's Actions secrets. Shares its scopes with the repository Secrets permission | read: `secrets:read`; write: `secrets:admin` |
| `workspace_webhooks` (Webhooks) | read, write | The workspace's webhooks. Shares its scopes with the repository Webhooks permission | read: `webhooks:read`; write: `webhooks:admin` |

Account permissions, for your own account as the resource owner:

| Permission | Levels | What it covers | g1t scopes it gives |
| --- | --- | --- | --- |
| `email_addresses` (Email addresses) | read, write | Your email addresses and email settings, invites and invitations | read: `account:read`; write: `account:write` |
| `starring` (Starring) | read, write | Stars and pinned projects. Shares its scopes with Email addresses | read: `account:read`; write: `account:write` |
| `notifications` (Notifications) | read, write | Your inbox, subscriptions and watched repositories | read: `notifications:read`; write: `notifications:write` |

### What a fine-grained token reaches

- **In its workspace**, what your role allows, in the repositories it
  reaches, and only what its permissions give.
- **Elsewhere**, public repositories, read-only, as anyone can. It cannot
  comment, open issues or push there.
- **With your account as its resource owner**, public repositories,
  read-only, and what its account permissions give.
- **While pending, denied or revoked**, public repositories, read-only.

A request it cannot make answers `403` naming why: the scope it lacks, or
`This fine-grained token's resource owner is the workspace acme: it can only
read public repositories elsewhere, …`. A repository outside its selection
answers as if it did not exist.

### Create a classic token

1. Open [Settings → Access tokens](https://g1t.sh/settings/tokens), and
   select the **Tokens (classic)** tab.
2. Under **New classic token**, give it a **Name** after what will use it.
3. Choose when it **Expires**: 7 days, 30 days, 90 days (the default),
   1 year, or No expiry. An expired token stops working; make a new one.
   No expiry shows a warning: the token works until someone deletes it.
4. Under **Scopes**, tick the boxes for what it may do. They are grouped
   by area. The form starts on the **Agent** [preset](#presets); select
   another preset to tick its boxes instead.
5. Select **Create token**, and copy the token. It is not shown again.

The list shows each token's name, when it was made and last used, when it
expires, and its access: a preset's name, its scopes, or Full access. To
change what a token may do, select **Edit access**, tick or untick boxes,
and select **Save access**. The token stays the same; the change applies
from its next request.

A classic token reaches every workspace you belong to unless the
workspace's [rules](#a-workspaces-rules-for-tokens) keep it out: one that
does not allow classic tokens, one whose longest lifetime this token
exceeds, or one whose owner revoked it there. It keeps working everywhere
else.

## Scopes

A scope is a resource and a level, written `resource:level`, such as
`issues:write`. A higher level includes the lower ones of the same
resource: `repo:admin` includes `repo:write`, which includes `repo:read`.
It never includes another resource: `repo:admin` does not let a token push,
which is `code:write`.

On the form, scopes are a checklist grouped by area:

| Group | Scopes |
| --- | --- |
| Repositories & code | `repo:read`, `repo:write`, `code:read`, `code:write` |
| Packages | `packages:read`, `packages:write` |
| Issues & pull requests | `issues:read`, `issues:write`, `pull_requests:read`, `pull_requests:write` |
| Agents | `agents:run` |
| Workflows | `workflows:read`, `workflows:write`, `workflow_files:write` |
| Checks | `checks:read`, `checks:write` |
| Deployments | `deployments:read`, `deployments:write` |
| Memory & search | `memory:read`, `memory:write` |
| Account | `account:read`, `account:write` |
| Notifications | `notifications:read`, `notifications:write` |
| Security | `security:read`, `security:write` |
| Workspace | `workspace:read`, `access:read`, `webhooks:read`, `secrets:read` |
| Billing | `billing:read`, `billing:write` |
| Runners | `runners:read` |
| AI Gateway | `models:read`, `models:write` |
| Dangerous | `repo:admin`, `packages:delete`, `workspace:admin`, `access:admin`, `webhooks:admin`, `secrets:admin`, `runners:admin` |

Ticking a higher level ticks the lower ones of its resource and greys
them out: tick `issues:write` and `issues:read` is ticked too. Untick
`issues:write` and `issues:read` stays ticked.

| Scope | What it lets a token do |
| --- | --- |
| `repo:read` | See repositories, their settings, labels, timelines, releases, languages, contributors and security alerts, and search |
| `repo:write` | Create repositories, rename branches, change how pull requests merge and publish releases |
| `repo:admin` | Rename, archive, transfer, delete or change who can see a repository, and dismiss security alerts |
| `code:read` | Clone and fetch private repositories with git |
| `code:write` | Push commits with git |
| `security:read` | See [secret scanning](/guides/security/secret-protection/), [code scanning](/guides/security/code-scanning/) and vulnerability alerts, custom patterns, the dependency graph and SBOM, and security settings |
| `security:write` | Dismiss and reopen alerts, bypass push protection, review bypass requests, manage custom patterns, upload SARIF and change security settings |
| `packages:read` | Pull container images and install private [packages](/guides/packages/). Public ones need no scope. |
| `packages:write` | Push container images and publish packages |
| `packages:delete` | Delete packages and their versions |
| `issues:read` | Read issues, comments and plans |
| `issues:write` | Open, edit, close and comment on issues |
| `pull_requests:read` | Read pull requests, their changes, sessions and merge queues |
| `pull_requests:write` | Open, review, close and merge pull requests |
| `agents:run` | Put g1t to work and message it, which uses the workspace's money |
| `workflows:read` | Read workflows, runs and logs |
| `workflows:write` | Run, cancel, rerun and turn workflows on or off |
| `workflow_files:write` | Add, change and delete [workflow files](#workflow-files) under `.g1t/workflows` and `.github/workflows`, with git or the API. Not in any preset but full access. |
| `checks:read` | Read commits' statuses, check runs, check suites and annotations |
| `checks:write` | Report [statuses and check runs](/guides/checks/) on commits, and ask for checks to run again |
| `deployments:read` | See [deployments](/guides/deployments-api/), their statuses and environments |
| `deployments:write` | Report deployments and their statuses, from any CI |
| `memory:read` | Recall memory and search the workspace's context |
| `memory:write` | Save memory for the next agent |
| `account:read` | Read your email addresses, invites, invitations, pinned projects and stars |
| `account:write` | Change your email addresses, make invites, answer invitations, pin projects and star repositories |
| `notifications:read` | See your [inbox](/guides/inbox/), its threads, and what you subscribe to and watch |
| `notifications:write` | Mark notifications read, done, saved or snoozed, subscribe to threads and watch repositories |
| `workspace:read` | Read workspace settings, invites, integrations, model routes and [teams](/guides/teams/) |
| `workspace:admin` | Create and delete workspaces, invite members, manage teams, connect integrations |
| `billing:read` | See a workspace's [usage, budget, AI credit and invoices](/guides/usage-and-billing/) |
| `billing:write` | Change a workspace's budget and buy AI credit. Only owners, as people: a workspace's own token and g1t's agents never change billing, whatever their scopes. Not in any preset but full access. |
| `access:read` | See who has access to repositories |
| `access:admin` | Give people and teams access to repositories, and take it away |
| `webhooks:read` | See webhooks and their deliveries |
| `webhooks:admin` | Create, change and delete webhooks |
| `secrets:read` | List secrets (never their values) and read variables |
| `secrets:admin` | Set and delete secrets and variables |
| `runners:read` | See [self-hosted runners](/guides/self-hosted-runners/), their groups and where agents run. Not in the Agent preset. |
| `runners:admin` | Register and remove self-hosted runners, change their groups and settings |
| `models:read` | See the workspace's [AI Gateway](/guides/ai-gateway/) requests: their models, tokens, cost and status |
| `models:write` | Send model requests through the [AI Gateway](/guides/ai-gateway/), which uses the workspace's AI credit. Only a workspace's own token can send them. Not in any preset but full access. |

Every operation of the API and the MCP server needs exactly one of these,
except `whoami` (`GET /user`), which any token may use. Each endpoint's page
in the [API reference](/reference/api/) names its scope, and so does each
action in [MCP tools](/reference/mcp/). A few calls need a second scope for
what they ask:

| Call | Also needs |
| --- | --- |
| `delegate` (`POST /repos/{owner}/{name}/issues/delegate`, the `agent` tool's `delegate`), which opens an issue | `issues:write`, beside `agents:run` |
| `apply_plan` or `import_issue` (the `plan` tool's `apply`, the `issue` tool's `import`) with `assign: true` | `agents:run` |
| `update_repo` with `private` or `default_branch` | `repo:admin` |

### What a token can do

What a request may do is where these overlap:

1. **Your role.** A token never does more than you could on the website. A
   token with `repo:admin` still cannot delete a repository unless you are
   an owner of its workspace. See [access and roles](/guides/access-and-roles/).
2. **What it reaches.** A classic token, every workspace and repository you
   can reach, including ones you join later, unless a workspace's
   [rules](#a-workspaces-rules-for-tokens) keep it out. A fine-grained
   token, its [resource owner](#what-a-fine-grained-token-reaches) only.
3. **Its scopes.** What kinds of thing it may do: chosen directly on a
   classic token, given by its permissions on a fine-grained one.

To keep a token away from other workspaces, make a fine-grained one, or use
a [workspace token](#workspace-tokens): it reaches only its own workspace.

### Presets

A preset ticks a starting set of boxes. Select one, then tick or untick
any box.

| Preset | Scopes |
| --- | --- |
| Read only | Every `read` scope. Changes nothing. |
| Agent | Every `read` scope except `runners:read`, and `code:write`, `issues:write`, `pull_requests:write`, `agents:run`, `memory:write` and `notifications:write`. Reads everything, works on issues and pull requests, pushes code, puts g1t to work, and answers your inbox. No admin scope. |
| CI | `repo:read`, `code:read`, `code:write`, `packages:read`, `packages:write`, `workflows:read`, `workflows:write`, `checks:read`, `checks:write`, `deployments:read` and `deployments:write`. Clones and pushes code, pushes and pulls packages, runs workflows, and reports [checks](/guides/checks/) and deployments. |
| Full access | Everything you can do, including deleting repositories and changing who has access. Marked **Dangerous**. |

Admin scopes change things that are hard to undo, or decide who can reach
what. They are under **Dangerous**, with a warning. Give them only to
something you trust as much as yourself.

### Git and scopes

Over HTTPS, git checks the same token:

| To | Needs |
| --- | --- |
| Clone or fetch a public repository | No scope |
| Clone or fetch a private repository | `code:read` |
| Push | `code:write` |
| Push commits that add, change or delete [workflow files](#workflow-files) | `code:write` and `workflow_files:write` |

Your role on the repository applies too, as on the website. A refused push
or clone says which scope is missing.

### Workflow files

A workflow runs with its repository's secrets and a token of its own, so
changing one is as powerful as holding those. A token therefore needs
`workflow_files:write` (a fine-grained token's **Workflows** permission) to
add, change or delete any file under `.g1t/workflows/` or
`.github/workflows/`, besides `code:write`:

- **With git**, every commit a push adds is compared with its parent, and a
  push that changes a workflow file is declined, naming it:

  ```text
  remote: This access token cannot change the workflow file .github/workflows/ci.yml: it needs the workflow_files:write scope.
  remote: Push with a token that has the workflow_files:write scope, or make the change signed in on g1t.sh.
  ```

  A push too large for g1t to read whole is declined for such a token too,
  since it cannot be checked; push it in smaller parts.
- **Through g1t**, a file written for a token (such as a starter workflow)
  is refused the same way.
- **A workflow job's token** never may, whatever its `permissions:` say.
  See [the job's token](/guides/actions/#the-jobs-token).
- **Signed in on g1t.sh**, your role decides, as for any file.

Full-access tokens, and tokens made before scopes, include it. A
[deploy key](/guides/git/#deploy-keys) with write access may change
workflow files.

### When a token lacks a scope

The API answers `403` with the scope that was missing in `needed_scope`:

```json
{
  "error": {
    "code": "forbidden",
    "message": "This access token needs the issues:write scope to use create_issue.",
    "needed_scope": "issues:write"
  }
}
```

Through MCP the same message comes back as a tool result with `isError`
set. Give the token that scope with **Edit access**, or make a new token.

### Tokens made before scopes

Tokens and OAuth sign-ins made before tokens had scopes keep full access,
so nothing that uses them stops working. Settings marks each one
**Legacy · full access**, and says to narrow it to what it needs. For a
token, select **Narrow this token**; for an application, **Change access**
in [Connected applications](https://g1t.sh/settings/applications). Then
tick its scopes. A token you make with Full access on purpose is not marked
legacy.

A token from [signing in from a tool](#signing-in-from-a-tool), such as the
g1t CLI, has full access.

### Workspace tokens

A workspace's own tokens act as the workspace rather than a person. An
owner makes them in the workspace's **Settings → Access tokens**, with the
same checklist and expiry choices; the form starts on the CI preset. A
workspace token reaches all of that workspace's repositories, never
another workspace, and cannot manage people, tokens or workspaces.

It has the Write role on the workspace's repositories, as a member does:
it pushes, merges and works on issues and pull requests, within its scopes.
Tick **Admin on the workspace's repositories** when making it to give it
Admin instead, so it can also manage webhooks, secrets, deploy keys and who
has access, and manage teams as an owner would. Only an owner can, and only
when making it. See
[workspace access tokens](/guides/workspaces/#workspace-access-tokens).

## A workspace's rules for tokens

An owner decides which of the members' own personal tokens reach the
workspace, under its **Settings → Personal access tokens**
(`g1t.sh/<workspace>/-/personal-access-tokens`). The rules apply from each
token's next request, to tokens made before them too. A token they keep out
keeps working everywhere else, and reads the workspace's public
repositories as anyone can.

| Rule | Default | What it does |
| --- | --- | --- |
| Allow fine-grained personal access tokens | On | Off: no fine-grained token can name the workspace as its resource owner, and existing ones stop reaching it. |
| Require approval of fine-grained tokens | On | A member's fine-grained token naming the workspace waits for an owner's approval, and again when it is widened. Owners' own tokens never wait. |
| Allow classic personal access tokens | On | Off: classic tokens no longer reach the workspace. |
| Tokens must expire | Off | On: a token that never expires does not reach the workspace. |
| Longest lifetime | No limit | A token that lasts longer (from when it was made to when it expires), or never expires, does not reach the workspace. Fine-grained tokens for it cannot be made longer. |

The same page lists:

- **Waiting for approval.** Each pending fine-grained token with its owner,
  permissions, repositories and expiry. Add an optional note, then select
  **Approve** or **Deny**. Its owner hears of it in their inbox, with the
  note.
- **Tokens that can reach the workspace.** Every fine-grained token naming
  it, and every classic token of its members and outside collaborators that
  has not expired, with its owner, permissions or scopes, last use and
  expiry, and whether it reaches the workspace now (and if not, why). Never
  the token itself. Select **Revoke** to take one out: a fine-grained token
  stops reaching the workspace for good; a classic token keeps working
  everywhere else, but never reaches this workspace again.

Approvals, denials, revocations and rule changes are
[audit log](/guides/audit-log/) entries: `token.approval_requested`,
`token.approved`, `token.denied`, `token.revoked` and
`token.policy_changed`.

### A workspace's rules through the API

Owners, as people (a personal token with the scope works; a workspace's own
token does not):

| Route | MCP tool and action | What it does | Scope |
| --- | --- | --- | --- |
| [`GET /workspaces/{workspace}/personal-access-token-policy`](/reference/api/personal-access-tokens/get-token-policy/) | `workspace` `get_token_policy` | The rules. Members may read them. | `workspace:read` |
| [`PATCH /workspaces/{workspace}/personal-access-token-policy`](/reference/api/personal-access-tokens/set-token-policy/) | `workspace` `set_token_policy` | Change `allow_classic`, `allow_fine_grained`, `require_approval`, `max_lifetime_days` (0 for no limit) or `forbid_no_expiry` | `workspace:admin` |
| [`GET /workspaces/{workspace}/personal-access-tokens`](/reference/api/personal-access-tokens/list-member-tokens/) | `workspace` `list_member_tokens` | The tokens that can reach it; `kind` is `classic` or `fine_grained` | `access:read` |
| [`GET /workspaces/{workspace}/personal-access-token-requests`](/reference/api/personal-access-tokens/list-token-requests/) | `workspace` `list_token_requests` | The fine-grained tokens waiting for approval | `access:read` |
| [`POST /workspaces/{workspace}/personal-access-token-requests/{id}`](/reference/api/personal-access-tokens/review-token-request/) | `workspace` `review_token_request` | `decision` is `approve` or `deny`, with an optional `reason` | `access:admin` |
| [`POST /workspaces/{workspace}/personal-access-tokens/{id}`](/reference/api/personal-access-tokens/revoke-member-token/) | `workspace` `revoke_member_token` | Revoke a token in the workspace, with an optional `reason` | `access:admin` |

## Signing in with OAuth

Applications that can open your browser, such as an agent connecting to the
[MCP server](/guides/bring-your-own-agent/), sign you in with OAuth 2.1.
You see a page on g1t naming the application and where it will send you
back, and you approve or deny. The application never sees your password and
there is no token to copy.

The page lists what the application will be able to do, as the same
checklist a token has, with only the scopes it asked for, all ticked.
Untick anything you would rather it could not do, leaving at least one;
you cannot give it more than it asked for. Like a token, it reaches
everything you can.

An application that asks for no scopes in particular gets the
[Agent preset](#presets): every `read` scope except `runners:read`, and `code:write`,
`issues:write`, `pull_requests:write`, `agents:run`, `memory:write` and
`notifications:write`.
It never gets an admin scope unless it asks for one and you leave it
ticked.

Applications you have approved are listed in
[Settings → Connected applications](https://g1t.sh/settings/applications),
each with its access. Select **Change access** to tick or untick its
scopes, then **Save access**: it stays signed in, the change applies at
once, and its next refresh keeps it. Select **Sign out** to end its access
at once.

For people building a client:

| | |
| --- | --- |
| Metadata | `https://api.g1t.sh/.well-known/oauth-authorization-server` |
| Authorization | `https://g1t.sh/oauth/authorize` |
| Token | `https://api.g1t.sh/oauth/token` |
| Registration | `https://api.g1t.sh/oauth/register` |

- The flow is authorization code with PKCE. `S256` is required.
- Clients are public: there are no client secrets.
- Register with `client_name` and `redirect_uris`. A redirect address is an
  `https` URL, `http` on `localhost`, or the application's own scheme. A
  client on `localhost` may use any port.
- Registration stores nothing. The client id it returns encodes what was
  registered, so it cannot be used to fill g1t with junk.
- Ask for scopes with `scope` on the authorization request, separated by
  spaces, such as `scope=repo:read issues:write pull_requests:write`.
  Names g1t does not know are left out. Leave `scope` out for the Agent
  preset. The authorization server's metadata and
  `https://mcp.g1t.sh/.well-known/oauth-protected-resource` list every
  scope in `scopes_supported`.
- The token response's `scope` holds the scopes the person granted,
  separated by spaces, or `*` for a sign-in with full access. Refreshing
  keeps them.
- An access token lasts 30 days. The refresh token returned with it works
  once and returns the next pair; the previous access token stops working.
- An authorization code lasts five minutes and works once.

## Signing in from a tool

A tool that cannot receive a redirect, such as a script on a remote machine,
gets a token without ever handling your password:

1. The tool asks g1t for a code and shows you a link and a short code such
   as `WDJB-MJHT`.
2. You open the link, sign in (or create an account), check that the code
   matches, and approve.
3. The tool collects its token.

```sh
# 1. The tool starts a sign-in.
curl -X POST https://api.g1t.sh/device/code   -H "Content-Type: application/json"   -d '{"client_name": "my-tool"}'

# 2. You open verification_uri_complete from the response and approve.

# 3. The tool polls, no faster than "interval" seconds, until it is approved.
curl -X POST https://api.g1t.sh/device/token   -H "Content-Type: application/json"   -d '{"device_code": "…"}'
```

The poll answers with a `status` of `pending`, `approved`, `denied` or
`expired`. An approved answer carries the token, once. Codes expire after 15
minutes. The token appears in
[Settings → Access tokens](https://g1t.sh/settings/tokens) under the tool's name, where you
can delete it.

Only approve a code you asked for. The token has full access: it can do
everything you can. To give a tool less, make an
[access token](#create-a-fine-grained-token) with only the scopes it needs instead.

## Resetting your password

Use [g1t.sh/forgot](https://g1t.sh/forgot) and enter any confirmed
address of your account. The link goes to that address and works for one
hour; your primary and backup addresses are told a reset was asked for
when it went elsewhere. A new account that has not confirmed its address
yet can use that address, and following the link confirms it.

The page answers the same way whether or not the address has an account.
g1t sends at most 5 reset links an hour to one address. If g1t cannot
take the request at all, the page says so and keeps what you typed, so you
can try again.

Setting a new password signs you out everywhere and emails your primary
and backup addresses.

## Too many attempts

g1t counts wrong passwords, on the sign-in page, for git over HTTPS and
when confirming it is you, against the account and against where they come
from. After 10 wrong passwords for one account in an hour, or 30 from one
place, g1t stops checking passwords for it for a minute, then twice as long
after each further wrong password, up to an hour. While it waits, every
attempt gets the same answer: "Too many attempts". The account's primary
and backup addresses are told the first time. Signing in with the right
password, or resetting it, clears the count. Access tokens, SSH keys and
GitHub sign-in are not affected.

## Security log

[Settings → Security log](https://g1t.sh/settings/security-log) lists what
happened to your account: addresses added, confirmed, removed or made
primary, your backup and privacy settings, password changes, SSH keys
added and removed, and pauses after too many wrong passwords. Changes g1t staff made, such as removing an
address someone else needed, say so and why.

## What g1t stores

Passwords are stored as salted PBKDF2-SHA256 hashes. Sessions and tokens are
stored as SHA-256 hashes. Neither can be read back.
