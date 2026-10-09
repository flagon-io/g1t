---
title: Accounts and authentication
description: Accounts, invites, email addresses, confirming them, two-factor authentication and recovery codes, personal access tokens and their permissions and scopes, a workspace's rules for tokens, OAuth, signing in from a tool, password reset, your security log and deleting your account.
---

## Creating an account

g1t is invite-only for now: to make an account you need an
[invite](#invites). Open the link in your invite, or enter its code at
[g1t.sh/register](https://g1t.sh/register). Without one, ask for access
on the same page.

Usernames are letters, digits and single hyphens, 1 to 39 characters, not
starting or ending with a hyphen. They keep the case you type: choose
`Ana-Lopez` and your profile, menus and cards show `Ana-Lopez`. Case never
makes a different name, though: `ana-lopez` is the same person and can't
be registered by anyone else, signing in works in any case,
`g1t.sh/u/ANA-LOPEZ` opens the same profile, and an `@ana-lopez` mention
reaches you. Addresses and git URLs use the lowercase form. Reserved words
(such as `settings`, `api` or `g1t`) are reserved in every case.

Before you can do anything else, you [confirm your email
address](#confirming-your-email-address) with the code g1t emails you,
unless you signed up from the link in an invite g1t emailed to that address
(see [invites from your inbox](#invites-from-your-inbox)).

Accounts can only be created in a browser. There is no API for it, by
design: it keeps passwords out of scripts and agents, and lets g1t protect
the one place accounts are made.

## Your settings

Your own settings are at [g1t.sh/settings](https://g1t.sh/settings), one
page each. Open them from your account menu at the bottom of the sidebar,
under **Your settings**; the sidebar then lists every page.

| Page | Address | What is on it |
| --- | --- | --- |
| Profile | [`/settings/profile`](https://g1t.sh/settings/profile) | Your picture, and your [public profile](/guides/workspaces/#profiles): name, pronouns, bio, location, website and time zone. |
| Emails | [`/settings/emails`](https://g1t.sh/settings/emails) | Your [email addresses](#email-addresses), the backup address, and [keeping your address private](#keeping-your-address-private). |
| Invites to g1t | [`/settings/invites`](https://g1t.sh/settings/invites) | [Making, copying and revoking invites to g1t](#making-invites), while g1t is invite-only; after that, the invites you made. |
| SSH keys | [`/settings/keys`](https://g1t.sh/settings/keys) | Public keys for [git over SSH](/guides/git/#ssh), each with when it was added and last used. |
| Access tokens | [`/settings/tokens`](https://g1t.sh/settings/tokens) | Your [personal access tokens](#access-tokens): their permissions, where they reach, and when they expire. |
| Integrations | [`/settings/integrations`](https://g1t.sh/settings/integrations) | [Your own integrations](/guides/integrations/#workspace-and-personal): what you have connected for yourself, in every workspace, and what is coming. |
| GitHub | [`/settings/github`](https://g1t.sh/settings/github) | [Linking and unlinking GitHub](/guides/github/#link-and-unlink-github). |
| Connected applications | [`/settings/applications`](https://g1t.sh/settings/applications) | Tools you [signed in to with OAuth](#signing-in-with-oauth), such as an agent using the MCP server. |
| Two-factor authentication | [`/settings/two-factor`](https://g1t.sh/settings/two-factor) | [An authenticator app and recovery codes](#two-factor-authentication). |
| Security log | [`/settings/security-log`](https://g1t.sh/settings/security-log) | [What happened to your account](#security-log). |
| Account | [`/settings/account`](https://g1t.sh/settings/account) | Your username, and [deleting your account](#deleting-your-account). |

`g1t.sh/settings` opens Profile.

## Signing in with GitHub

**Continue with GitHub** on the sign-in and sign-up pages signs you in with
your GitHub account, and makes a g1t account the first time. Link or
unlink GitHub in [Settings → GitHub](https://g1t.sh/settings/github). See
[GitHub](/guides/github/#sign-in-with-github).

Making an account with GitHub needs an invite too: start from your invite
link, or enter the code when g1t asks for it after GitHub.

With [two-factor authentication](#two-factor-authentication) on, signing in
with GitHub asks for a code from your app as well.

## Two-factor authentication

Two-factor authentication asks for a code from an authenticator app on
your phone each time you sign in with your password or with GitHub, so a
stolen password is not enough. Any app that reads a time-based one-time
password (TOTP) QR code works, such as 1Password, Google Authenticator or
Authy.

### Turn it on

1. Open [Settings → Two-factor authentication](https://g1t.sh/settings/two-factor)
   and choose **Set up**. g1t asks for your password if you have not
   signed in in the last 10 minutes.
2. Scan the QR code with your app, or type the key shown under it.
3. Enter the six-digit code the app shows, and choose **Turn on**.
4. Save the ten recovery codes g1t shows. They are shown only then.

### Signing in with it on

After your password (or GitHub), g1t asks for the code from your app. A
code works for 30 seconds, and the one before and after it are accepted
too, for a phone clock a little off. Each code works once. After five wrong
codes, or ten minutes, start the sign-in again.

Lost your phone? Enter a recovery code instead of the app's code. Each
works once, and your security log records its use.

Git over HTTPS never takes your password while two-factor authentication
is on: use a [personal access token](#access-tokens) as the password, or
[SSH](/guides/git/). Access tokens, SSH keys and OAuth applications are
not affected.

### Recovery codes, and turning it off

On the same page:

- **Make new recovery codes** replaces all ten; the old ones stop working.
- **Turn off** needs a code from your app or a recovery code, and your
  password if you have not signed in in the last 10 minutes.

You cannot turn it off while you own a workspace that
[requires it](/guides/workspaces/#require-two-factor-authentication): stop
requiring it there first, or hand the workspace to another owner. In a
workspace that requires it, turning it off holds you out of that workspace
until you turn it on again.

Turning it on or off, and making new recovery codes, are emailed to your
primary and backup addresses, written to your [security log](#security-log),
and recorded in the [audit log](/guides/audit-log/) of each of your
workspaces as `two_factor.enabled` and `two_factor.disabled`.

### Require two-factor authentication

An owner can require it of everyone with access to a workspace. See
[Workspaces](/guides/workspaces/#require-two-factor-authentication).

Passkeys are not supported yet; they are next.

## Invites

There are two kinds of invite, and they do different things:

| | Invite to g1t | Invite to a workspace |
| --- | --- | --- |
| Made from | [Settings → Invites](https://g1t.sh/settings/invites), your own | The workspace's **People** page, by its owners |
| What it gives | One new account. It adds them to no workspace: the account gets a workspace of its own | An invitation to join that workspace, which they accept or decline |
| Someone without an account | Makes their account with it | Makes their account with it too, while g1t is invite-only, then answers the invitation |
| Someone already on g1t | Nothing: they have an account | The invitation, in their inbox and by email |
| Exists | Only while g1t is invite-only | Always |
| What its page and email say | "@syntaqx invited you to g1t" | "@syntaqx invited you to join Flagon, Inc. on g1t" |

So you can invite someone to g1t without inviting them into any
workspace; an invite to g1t only adds them to a workspace when you tick
**Also invite them to a workspace** (see [making invites](#making-invites)).

While g1t is invite-only, every new account needs an invite code, such as
`g1t-k7m2-q9xd-…`. People already on g1t make them, and g1t sends them to
people who [asked for access](#asking-for-access). An invite:

- works once, for one new account;
- works for 30 days;
- when it was made for an email address, works only with that address;
- can be revoked by whoever made it until it is used, and after that until
  the new account [confirms its email address](#confirming-your-email-address).

### Using an invite

Every invite email links to `g1t.sh/invite/<code>`. That one page shows
who sent it and what it is for (joining a workspace, collaborating on a
repository, or just making an account), and finishes the job there:

1. **No account yet**: sign up on the page. When the invite was sent to
   your address, the email field is filled in and locked. Choose a
   username (one is suggested from your address) and a password. If you
   opened the page from the invite email itself, the address is already
   confirmed and you go straight in (see
   [invites from your inbox](#invites-from-your-inbox)); otherwise
   [confirm the address](#confirming-your-email-address) with the code g1t
   emails it. Or select **Continue with GitHub**: the invite rides along,
   and the account uses the invited address when GitHub has verified it
   too, in which case no confirmation is needed.
2. **The address already has an account**: select **Sign in to accept**.
   After you sign in, the invite is accepted for you.
3. **Signed in as someone else**: an invite sent to one address works only
   for an account that has confirmed that address. The page says so and
   offers **Sign out and continue**.

Nobody joins a workspace without saying yes. With an existing account,
accepting on the invite's page is that yes: you land in the workspace (or
the repository) the invite was for, with a one-time "You're in" banner,
and it becomes the workspace your sidebar shows.

A new account made from an invite that names a workspace is invited to
it: once the account's address is confirmed, g1t takes you to
[g1t.sh/invitations](https://g1t.sh/invitations), where you
[accept or decline](#workspace-invitations) it. Until you answer, you have
no workspace of your own, so you never end up with two. An invite that
names no workspace gives the new account a workspace of its own instead;
see [your first workspace](#your-first-workspace).

Signing up spends the invite at once, so nobody else can use it while you
confirm your address. Until you confirm, the invite shows as **confirming
their email** to whoever made it, and they can still revoke it. If the
invite is revoked or expires, or its workspace is deleted, before you
confirm, your address is confirmed all the same and g1t tells you the
invite no longer applies: ask whoever invited you to invite you again. A
code typed at [g1t.sh/register](https://g1t.sh/register) goes to the
same page.

An expired, revoked or used invite says which, and who sent it, so you
can ask them for a new one; or ask for access from the same page.

### Invites from your inbox

When g1t emails an invite to an address (an invite you make for someone,
an owner's invite into a workspace or a repository, or an approved
[request for access](#asking-for-access)), the link in that email carries a
`proof` that only the email has: `g1t.sh/invite/<code>?proof=…`. Opening
the link shows that you can read that inbox, so:

- the invite page says the address is confirmed because you came from the
  invite email, and the email field stays locked to it;
- your new account starts with the address confirmed: no code is sent. A
  repository the invite was for is yours straight away; a workspace it
  names is a [workspace invitation](#workspace-invitations) you accept or
  decline straight away, since nobody joins a workspace without saying yes.

Anything else confirms the address the usual way, after you sign up: the
code typed at [g1t.sh/register](https://g1t.sh/register), an invite link
copied from **Settings → Invites** (whoever made the invite sees the code,
never the proof), an invite made for anyone with the link, or an invite
email sent before this existed. The proof is tied to one invite and its
address, and stops working when the invite is used, revoked or expires.

### Invite links for a group

g1t sometimes hands one link to a group: an event's judges, readers of a
post, a community. It looks like
`https://g1t.sh/register?invite=g1t-k7m2-…` and opens sign-up with the
code filled in and the group named above the form, such as **Invited as
part of Launch week judges**.

- **It makes your own account.** Each person who uses it gets a new
  account, and then makes their own workspace. It does not add you to
  anyone else's workspace; once you are in, a workspace's owners can add
  you from its People page.
- **It may be for some email domains only.** When it is, the email field
  says which, such as `example.com`, and sign-up takes only an address
  there. Use your address at that organization; you confirm it like any
  other.
- **It works a set number of times, until a set day.** Once every place
  is taken, or the day has passed, or g1t has stopped it, the link gets
  the same answer as any invite that cannot be used. Ask whoever shared
  it, or [ask for access](#asking-for-access).

Using the link spends one place in the same step that makes your account,
so two people signing up at the same moment can never take more places
than it has. Anyone with an account can still [make invites](#making-invites)
of their own; group links are made by g1t staff only.

### Making invites

These are invites to g1t. They let one person make an account, and add
them to no workspace unless you say so.

1. Open [Settings → Invites](https://g1t.sh/settings/invites) (**Invites
   to g1t** in your settings and account menu).
2. Optionally enter the email address of the person you are inviting.
   With one, g1t emails them the invite, and only that address can use it.
   Without one, anyone with the link can, once.
3. Optionally tick **Also invite them to a workspace**, then choose the
   workspace and the role (**Member** or **Owner**) they are invited with.
   It is off to start with, and no workspace is chosen for you, not even
   the one you are in.
4. Select **Create invite**, then copy the link.

Left unticked, the invite is to g1t only: the new account gets a
[workspace of its own](#your-first-workspace). Ticked, the new account
gets a [workspace invitation](#workspace-invitations) to the workspace you
chose once its address is confirmed, and is not given a workspace of its
own. The list of workspaces holds the ones you can add members to: the ones
you own that are on the g1t plan. A workspace on the free plan cannot add
people, so it is not offered, and the form says so when it is the one you
are in.

To bring someone into a workspace, you do not need an invite to g1t:
invite them from the workspace's People page instead (see
[inviting someone into a workspace](#inviting-someone-into-a-workspace)).
Settings → Invites links to the People pages of the workspaces you own.

Once anyone can sign up for g1t, there are no invites to g1t to make:
Settings → Invites keeps only the list of invites you already made, and
says that anyone can sign up now and that workspace invitations live on
each workspace's People page. With no invites made, the page is not listed
in your settings or account menu.

Each person can have **5** invites out at a time. Pending and used invites
count; an invite you revoke, or one that expires before anyone uses it,
comes back to you. The list under the form shows each invite's state:
pending, confirming their email (used to sign up by someone who has not
confirmed their address yet), waiting for them to accept (the account is
made and confirmed, and the workspace invitation waits for its answer),
joined (with the username of who joined), declined, expired or revoked. You
must confirm your email before you can make invites. An agent's token and
a workspace's token cannot make them.

### Inviting someone into a workspace

An owner can invite someone into a workspace from its People page, by
username or by email address, with the role they join as; see
[add people](/guides/workspaces/#add-people). Nobody is added without
saying yes: someone on g1t gets a [workspace invitation](#workspace-invitations)
to accept or decline. When an address has no g1t account, the invitation
also lets it make one first, and the invitation is answered once the
account's address is confirmed (at once when it was made from the invite
email's link). While g1t is invite-only, that uses one invite: one of the
workspace's shared invites when it has any, otherwise one of yours. Once
anyone can sign up, it costs nothing. Inviting someone who is already on
g1t never costs anything.

### Workspace invitations

A workspace invitation asks one account to join one workspace, with the
role chosen when it was sent. You hear of it in your inbox and by email,
and answer it at [g1t.sh/invitations](https://g1t.sh/invitations):

- **Accept** joins the workspace with that role, and takes you there.
- **Decline** joins nothing; whoever invited you is told in their inbox.

An invitation works for 30 days, the same as an invite. Until it is
answered, the workspace's owners see it under **Pending invitations** on
its People page and can revoke it. A workspace on the free plan cannot add
people, so an invitation to one cannot be accepted until it starts the
plan. Only you can answer your invitations: an agent's token and a
workspace's token cannot.

### Your first workspace

Everything on g1t lives in a workspace, so every new account gets one:

- An account whose invite brings it into a workspace gets the invitation
  to it, and no workspace of its own.
- Every other account (signed up with a password, with GitHub, from a
  shared invite link or an invite from g1t staff, or with an invite that
  names no workspace) gets a workspace of its own, named for its username,
  on the free plan. Rename it or start the plan on it whenever you like.

Signed in without any workspace (you declined an invitation, or left the
only workspace you were in), g1t shows **Create your workspace or ask to
join one** in place of Mission control: the invitations waiting for you, if
any, and the form to create a workspace. To join a team already on g1t,
ask one of its owners to invite you by your username.

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
| [`POST /user/invites`](/reference/api/invites/create-invite/) | `account` `create_invite` | Make an invite, optionally for one `email`; with `workspace` (a slug), the new account is invited to that workspace |
| [`DELETE /user/invites/{id}`](/reference/api/invites/revoke-invite/) | `account` `revoke_invite` | Revoke a pending invite, or one whose new account has not confirmed its address |
| [`POST /workspaces/{workspace}/invitations`](/reference/api/invites/invite-member/) | `workspace` `invite_member` | Invite a `username` or an `email` into a workspace, with a `role`. Owners only. |
| [`GET /user/invitations`](/reference/api/invites/list-invitations/) | `account` `list_workspace_invitations` | The workspace invitations waiting for your answer |
| [`POST /user/invitations/{id}/accept`](/reference/api/invites/accept-invitation/) | `account` `accept_workspace_invitation` | Join the invitation's workspace with its role |
| [`POST /user/invitations/{id}/decline`](/reference/api/invites/decline-invitation/) | `account` `decline_invitation` | Decline it; whoever sent it is told |

## Confirming your email address

A new account confirms its email address before it can do anything else on
g1t, unless it already has (it was made with GitHub, or from the link in
its invite email). Right after you sign up, g1t emails the address from `noreply@g1t.sh`
with two ways to confirm it, either one enough:

- a **six-digit code**, shown large in the email (and in its subject, so a
  phone's notification shows it). Type it on the **Confirm your email**
  page g1t takes you to. On a phone, the keyboard offers it from the
  message.
- a **link**, for when you would rather click than type. It works whether
  or not you are signed in, in any browser.

The code and the link work for **60 minutes**, once. Using either ends the
other. **Send a new code** on the confirmation page sends a fresh code and
link, at most once a minute and 10 times an hour, and the ones before stop
working.

| On the confirmation page | What it does |
| --- | --- |
| **Confirm email** | Checks the code. A wrong, used or expired code gets the same answer. After 10 wrong codes in an hour, codes for the account are not checked for a while (a minute, then longer); the link in the email still works. Wrong codes from one network are limited the same way. |
| **Send a new code** | A new code and link; the ones before stop working. |
| **Wrong address? Change it** | Replaces the address you signed up with and sends the new one a code. Only while the account has no confirmed address. |
| **Sign out** | Signs out. Sign in again to come back to the page. |

### Until you confirm

An account that has not confirmed its address can only confirm it:

- **The site** sends every page to the confirmation page, and back to where
  you were going once you confirm. Signing in and out, password resets,
  the confirmation link, and g1t's [policies](https://g1t.sh/policies),
  security, support, status and pricing pages stay open.
- **The API** answers `403` with a message saying to confirm your address,
  except for [`GET /user`](/reference/api/accounts/whoami/),
  [`GET /user/emails`](/reference/api/accounts/list-emails/) and
  [`POST /user/emails/confirm`](/reference/api/accounts/confirm-email/).
- **The MCP server** answers `403` with the same message.
- **Git** over HTTPS refuses pushes and fetches with your credentials, with
  the same message. Package registries treat them as wrong credentials.
- You cannot create a workspace, answer the invitation your invite brought, make
  invites or tokens, or approve a tool's sign-in.

You cannot make a token before you confirm, so the API and MCP refusals
matter only for an account that made one before this rule existed.

### Addresses GitHub has confirmed

An account made with **Continue with GitHub** starts confirmed: its address
is one GitHub has verified, so GitHub has already proved the inbox is
yours, and no code is sent.

### Addresses an invite email has confirmed

An account made from the link in the invite g1t emailed to its address
starts confirmed the same way: following that link proved the inbox is
yours. It works only for the address the invite was sent to, and only from
the email's own link; see [invites from your inbox](#invites-from-your-inbox).

### Accounts that never confirmed

Accounts are confirmed once and stay confirmed. An account made before this
rule that never confirmed its address, or whose address another account
confirmed first, is held at the confirmation page the same way the next
time it signs in; **Send a new code** gets it a code, and **Change it**
gives it a new address.

### Confirming through the API

| Route | MCP tool and action | What it does |
| --- | --- | --- |
| [`POST /user/emails/confirm`](/reference/api/accounts/confirm-email/) | `account` `confirm_email` | Confirm an address with the `code` from its email |

The answer says whether the account is now confirmed (`verified`), the
workspace its invite invites it to (`invited_to`: accept or decline it with
[`POST /user/invitations/{id}/accept`](/reference/api/invites/accept-invitation/)
or [`/decline`](/reference/api/invites/decline-invitation/)), or why its
invite no longer applies (`invite_lapsed`). `joined` is always null: nothing
is joined without an answer.

## Email addresses

An account can have up to 10 email addresses. Manage them in
[Settings → Emails](https://g1t.sh/settings/emails).

| An address that is | Can |
| --- | --- |
| Primary | Get account mail and password reset links. Exactly one, always confirmed once any address is. |
| Confirmed | Sign you in (type it instead of your username), ask for a password reset, and mark commits that carry it as yours. |
| Backup | Get security notices as well as the primary. Optional, and a confirmed address other than the primary. |
| Unconfirmed | Nothing yet. It is not yours until you enter the code or follow the link g1t sent it. |

A confirmed address belongs to one account. Anyone can add an address they
have not confirmed; the first account to confirm it keeps it, and the
address leaves every other account that added it. An address another
account has confirmed cannot be added.

### Add an address

1. Open [Settings → Emails](https://g1t.sh/settings/emails).
2. Enter the address under **Add an email address** and select **Add**.
3. Enter the code g1t emails it, or follow the link in the same email.
   Both work for 60 minutes; **Resend link** sends a new code and link, at
   most once a minute and 10 times an hour, and ends the ones before.

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

Adding or removing an address, changing your primary or backup, and
turning two-factor authentication on or off, need proof that it is you: a
sign-in in the last 10 minutes, or your password,
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
commit. See [Commits and your account](/guides/workspaces/#commits-and-your-account)
for setting your noreply address in git.

### Email addresses through the API

| Route | MCP tool and action | What it does |
| --- | --- | --- |
| [`GET /user/emails`](/reference/api/accounts/list-emails/) | `account` `list_emails` | Your addresses and email settings |
| [`POST /user/emails`](/reference/api/accounts/add-email/) | `account` `add_email` | Add an address; takes `email` and `password` |
| [`POST /user/emails/confirm`](/reference/api/accounts/confirm-email/) | `account` `confirm_email` | Confirm an address with the `code` from its email |
| [`DELETE /user/emails/{email}`](/reference/api/accounts/remove-email/) | `account` `remove_email` | Remove an address; takes `password` |
| [`PATCH /user/email-settings`](/reference/api/accounts/update-email-settings/) | `account` `update_email_settings` | Change `primary`, `backup`, `private_email` or `block_private_pushes` |

Through the API, `password` is the proof a sensitive change needs. Without
it, or with the wrong one, the answer is `403` with the code
`reauth_required`. Only a person's own token can use these: an agent's
token and a workspace's token are refused.

## Workspaces

Your account does not own repositories itself: a workspace does. A new
account gets one of its own, named for its username, unless its invite
brings it into one; see [your first workspace](#your-first-workspace). Workspaces,
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

There is one kind of access token. Every token has:

- **Permissions**: a level for each resource, such as Issues: read and
  write, or Code: read. See [permissions](#permissions).
- **A reach**: the workspaces and repositories it works in. See
  [where a token reaches](#where-a-token-reaches).
- **An expiration**: 7 days to 1 year, or none where the workspaces it
  reaches allow that.

It never does more than you could on the website. Your own tokens are
under [Settings → Access tokens](https://g1t.sh/settings/tokens). For CI
and integrations that work for a team, a workspace can have tokens of its
own, made with the same form, that act as the workspace and keep working
when their creator leaves. See [workspace tokens](#workspace-tokens).

### Create a token

1. Open [Settings → Access tokens](https://g1t.sh/settings/tokens) and
   select **New token**.
2. Give it a **Token name** after what will use it, and optionally a
   **Description**, which a workspace's owners see if they review it.
3. Choose its **Expiration**: 7, 30, 60, 90 or 180 days, 1 year, or **No
   expiration**. A workspace it reaches can set a shorter limit, or forbid
   tokens that never expire; the choices follow its rules. No expiration
   shows a warning: the token works until someone deletes it.
4. Under **Where it reaches**, choose **Workspaces**:
   - **All your workspaces**: every workspace you belong to, including
     ones you join later.
   - **One workspace**: then choose its **Repository access**: **All
     repositories** (including ones made later), **Only select
     repositories** (tick up to 50), or **No private repositories**
     (public repositories, read-only, and the workspace's own settings its
     permissions allow).
   - **No workspace**: your account and public repositories only, such as
     a token that reads your inbox.
5. Under **Permissions**, set each resource the token needs to a level.
   **Read only**, **Agent** and **CI** fill in a [preset](#presets);
   **Clear** sets everything back to no access.
6. Select **Generate token**, and copy it. It is not shown again.

When you make a token for one workspace that
[requires approval](#a-workspaces-rules-for-tokens), and you are not one of
its owners, the token is made **Pending approval**: it works at once, but
reads public repositories only until an owner approves it. The owners hear
of it in their [inbox](/guides/inbox/), and you hear of their answer in
yours. An owner's own token never waits.

### Change or delete a token

The list under Settings → Access tokens shows each token's name, status
(pending, denied or revoked, with the owner's note), where it reaches, its
permissions, and when it was made, last used and expires. Select a token to
open its page, where you can change its name, description, repositories
and permissions, and select **Save changes**. The token itself stays the
same; the change applies from its next request. Widening a token made for
a workspace that requires approval asks its owners again. Where it reaches
and when it expires cannot change; make a new token instead.

**Delete token**, at the bottom of its page, stops it working at once.

### Permissions

A permission is a resource and a level. A higher level includes the lower
ones: Issues: read and write includes reading issues. Each level is one of
g1t's [scopes](#scopes), so Issues: read and write is `issues:write`; the
API, the MCP server and git check every token by those scopes.

Repository permissions apply in every repository the token reaches:

| Permission | Levels | Scope names |
| --- | --- | --- |
| Repositories | read, read and write, admin | `repo:read`, `repo:write`, `repo:admin` |
| Code | read, read and write | `code:read`, `code:write` |
| Security | read, read and write | `security:read`, `security:write` |
| Packages | read, read and write, read, write and delete | `packages:read`, `packages:write`, `packages:delete` |
| Issues | read, read and write | `issues:read`, `issues:write` |
| Pull requests | read, read and write | `pull_requests:read`, `pull_requests:write` |
| g1t agents | run | `agents:run` |
| Workflows | read, read and write | `workflows:read`, `workflows:write` |
| Workflow files | write | `workflow_files:write` |
| Checks and statuses | read, read and write | `checks:read`, `checks:write` |
| Deployments | read, read and write | `deployments:read`, `deployments:write` |
| Memory and context | read, read and write | `memory:read`, `memory:write` |
| Who has access | read, admin | `access:read`, `access:admin` |
| Webhooks | read, admin | `webhooks:read`, `webhooks:admin` |
| Secrets and variables | read, admin | `secrets:read`, `secrets:admin` |

Workspace permissions apply to the workspaces the token reaches themselves:

| Permission | Levels | Scope names |
| --- | --- | --- |
| Workspaces | read, admin | `workspace:read`, `workspace:admin` |
| Billing | read, read and write | `billing:read`, `billing:write` |
| Self-hosted runners | read, admin | `runners:read`, `runners:admin` |
| AI Gateway | read, read and write | `models:read`, `models:write` |

Account permissions are about you, wherever you are, and only a personal
token can hold them:

| Permission | Levels | Scope names |
| --- | --- | --- |
| Your account | read, read and write | `account:read`, `account:write` |
| Notifications | read, read and write | `notifications:read`, `notifications:write` |

What each level lets a token do is in [scopes](#scopes). On the form, each
row says it for the level chosen, and admin and delete levels are shown in
red: they change things that are hard to undo, or decide who can reach
what. Give them only to something you trust as much as yourself.

### Where a token reaches

| Made for | Reaches |
| --- | --- |
| All your workspaces | Every workspace you belong to, and repositories you were given, including ones you join later, unless a workspace's [rules](#a-workspaces-rules-for-tokens) keep it out. |
| One workspace, all repositories | That workspace, and every repository of it you can reach. |
| One workspace, select repositories | That workspace, and only the repositories chosen. |
| One workspace, no private repositories | That workspace's own settings its permissions allow, and public repositories. |
| No workspace | Your account, and public repositories. |

Wherever it does not reach, a token reads public repositories, read-only,
as anyone can; it cannot comment, open issues or push there. While a token
made for a workspace is pending, denied or revoked, that is all it does
there too.

A request it cannot make answers `403` naming why: the scope it lacks, or
`This access token is made for the workspace acme: elsewhere it can only
read public repositories, …`. A repository outside its selection answers as
if it did not exist.

### Presets

A preset fills in a starting set of permissions. Select one, then change
any row.

| Preset | Permissions |
| --- | --- |
| Read only | Every resource at read. Changes nothing. |
| Agent | Every resource at read except Self-hosted runners, and Code, Issues, Pull requests, Memory and context and Notifications at read and write, and g1t agents at run. Reads everything, works on issues and pull requests, pushes code, puts g1t to work, and answers your inbox. No admin level. |
| CI | Repositories: read; Code, Packages, Workflows, Checks and statuses, and Deployments: read and write. Clones and pushes code, pushes and pulls packages, runs workflows, and reports [checks](/guides/checks/) and deployments. |

A new personal token starts on Read only; a new workspace token on CI.

## Scopes

A scope is a permission's level, written `resource:level`, such as
`issues:write`. A token stores the highest scope of each resource it
holds, and every check reads them. A higher level includes the lower ones
of the same resource: `repo:admin` includes `repo:write`, which includes
`repo:read`. It never includes another resource: `repo:admin` does not let
a token push, which is `code:write`.

Applications that [sign in with OAuth](#signing-in-with-oauth) ask for
scopes by these names, and you choose them on a checklist when you approve
one.

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
| `packages:write` | Push container images and publish packages; with the Admin role on a package, change its settings |
| `packages:delete` | Delete and restore packages and their versions |
| `issues:read` | Read issues, comments and plans |
| `issues:write` | Open, edit, close and comment on issues |
| `pull_requests:read` | Read pull requests, their changes, sessions and merge queues |
| `pull_requests:write` | Open, review, close and merge pull requests |
| `agents:run` | Put g1t to work and message it, which uses the workspace's money |
| `workflows:read` | Read workflows, runs and logs |
| `workflows:write` | Run, cancel, rerun and turn workflows on or off |
| `workflow_files:write` | Add, change and delete [workflow files](#workflow-files) under `.g1t/workflows` and `.github/workflows`, with git or the API. Not in any preset. |
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
| `billing:write` | Change a workspace's budget and buy AI credit. Only owners, as people: a workspace's own token and g1t's agents never change billing, whatever their scopes. Not in any preset. |
| `access:read` | See who has access to repositories |
| `access:admin` | Give people and teams access to repositories, and take it away |
| `webhooks:read` | See webhooks and their deliveries |
| `webhooks:admin` | Create, change and delete webhooks |
| `secrets:read` | List secrets (never their values) and read variables |
| `secrets:admin` | Set and delete secrets and variables |
| `runners:read` | See [self-hosted runners](/guides/self-hosted-runners/), their groups and where agents run. Not in the Agent preset. |
| `runners:admin` | Register and remove self-hosted runners, change their groups and settings |
| `models:read` | See the workspace's [AI Gateway](/guides/ai-gateway/) requests: their models, tokens, cost and status |
| `models:write` | Send model requests through the [AI Gateway](/guides/ai-gateway/), which uses the workspace's AI credit. Only a workspace's own token can send them. Not in any preset. |

Every operation of the API and the MCP server needs exactly one of these,
except `whoami` (`GET /user`), which any token may use. Each endpoint's page
in the [API reference](/reference/api/) names its scope, and so does each
action in [MCP tools](/reference/mcp/); the MCP server lists only the tools
a token's permissions can use. A few calls need a second scope for what
they ask:

| Call | Also needs |
| --- | --- |
| `delegate` (`POST /repos/{owner}/{name}/issues/delegate`, the `agent` tool's `delegate`), which opens an issue | `issues:write`, beside `agents:run` |
| `apply_plan` or `import_issue` (the `plan` tool's `apply`, the `issue` tool's `import`) with `assign: true` | `agents:run` |
| `update_repo` with `private` or `default_branch` | `repo:admin` |

### What a token can do

What a request may do is where these overlap:

1. **Your role.** A token never does more than you could on the website. A
   token with Repositories: admin still cannot delete a repository unless
   you are an owner of its workspace. See
   [access and roles](/guides/access-and-roles/).
2. **Where it reaches.** All your workspaces, one, or none, and in one, its
   repositories. See [where a token reaches](#where-a-token-reaches).
3. **Its permissions.** What kinds of thing it may do there.

### Git and scopes

Over HTTPS, git checks the same token:

| To | Needs |
| --- | --- |
| Clone or fetch a public repository | No permission |
| Clone or fetch a private repository | Code: read (`code:read`) |
| Push | Code: read and write (`code:write`) |
| Push commits that add, change or delete [workflow files](#workflow-files) | Code: read and write, and Workflow files: write (`workflow_files:write`) |

Your role on the repository applies too, as on the website. A refused push
or clone says which scope is missing.

### Workflow files

A workflow runs with its repository's secrets and a token of its own, so
changing one is as powerful as holding those. A token therefore needs
Workflow files: write (`workflow_files:write`) to add, change or delete any
file under `.g1t/workflows/` or `.github/workflows/`, besides Code: read
and write:

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

A [deploy key](/guides/git/#deploy-keys) with write access may change
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
set. Give the token that permission on its page, or make a new token.

### Tokens made before

Tokens once came in two kinds, with scopes or with permissions for one
workspace. Every one of them is now a token like any other, and does
exactly what it did:

- A token made with scopes is made for **all your workspaces**, with the
  permissions its scopes were.
- A token made for one workspace (or for your account only) is made for
  that workspace (or for **No workspace**), with the repositories it had,
  and with permissions that are the scopes its old permissions gave.
- A token with full access, including one made before tokens had scopes and
  one from [signing in from a tool](#signing-in-from-a-tool) such as the
  g1t CLI, has every permission at its highest level. Narrow it on its page
  to what it needs.

An application signed in with OAuth before applications had scopes keeps
full access too, marked **Legacy · full access**: select **Change access**
in [Connected applications](https://g1t.sh/settings/applications) to narrow
it.

The old addresses of the token settings lead to the list and to each
token's page.

### Workspace tokens

A workspace's own tokens act as the workspace rather than a person. An
owner makes them in the workspace's **Settings → Access tokens**
(`g1t.sh/<workspace>/-/tokens`), with **New token**: the same form as a
personal token, starting on the CI preset. A workspace token reaches all
of that workspace's repositories, or the ones chosen, never another
workspace, and cannot manage people, tokens or workspaces. It holds no
account permissions.

It has the Write role on the workspace's repositories, as a member does:
it pushes, merges and works on issues and pull requests, within its
permissions. Give it **Repositories: admin** to make it an admin of the
workspace's repositories instead, so it can also manage webhooks, secrets,
deploy keys and who has access, and manage teams as an owner would. Only an
owner can make, change or delete one. See
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
| Allow tokens made for the workspace | On | Off: no token can be made for the workspace alone, and existing ones stop reaching it. |
| Require approval of tokens made for the workspace | On | A member's token made for the workspace waits for an owner's approval, and again when it is widened. Owners' own tokens never wait. |
| Allow tokens made for all of a member's workspaces | On | Off: tokens made for all of their owner's workspaces no longer reach this one; members make a token for it alone instead, which the rule above can require approval for. |
| Tokens must expire | Off | On: a token that never expires does not reach the workspace. |
| Longest lifetime | No limit | A token that lasts longer (from when it was made to when it expires), or never expires, does not reach the workspace. Tokens for it cannot be made longer. |

The same page lists:

- **Waiting for approval.** Each pending token with its owner,
  permissions, repositories and expiry. Add an optional note, then select
  **Approve** or **Deny**. Its owner hears of it in their inbox, with the
  note.
- **Tokens that can reach the workspace.** Every token made for it, and
  every token of its members and outside collaborators made for all of
  their workspaces, that has not expired, with its owner, permissions,
  reach, last use and expiry, and whether it reaches the workspace now (and
  if not, why). Never the token itself. Select **Revoke** to take one out:
  a token made for the workspace stops reaching it for good; a token made
  for all of its owner's workspaces keeps working everywhere else, but
  never reaches this workspace again.

Approvals, denials, revocations and rule changes are
[audit log](/guides/audit-log/) entries: `token.approval_requested`,
`token.approved`, `token.denied`, `token.revoked` and
`token.policy_changed`.

### A workspace's rules through the API

Owners, as people (a personal token with the permission works; a
workspace's own token does not):

| Route | MCP tool and action | What it does | Scope |
| --- | --- | --- | --- |
| [`GET /workspaces/{workspace}/personal-access-token-policy`](/reference/api/personal-access-tokens/get-token-policy/) | `workspace` `get_token_policy` | The rules. Members may read them. | `workspace:read` |
| [`PATCH /workspaces/{workspace}/personal-access-token-policy`](/reference/api/personal-access-tokens/set-token-policy/) | `workspace` `set_token_policy` | Change `allow_tokens_for_this_workspace`, `allow_tokens_for_all_workspaces`, `require_approval`, `max_lifetime_days` (0 for no limit) or `forbid_no_expiry` | `workspace:admin` |
| [`GET /workspaces/{workspace}/personal-access-tokens`](/reference/api/personal-access-tokens/list-member-tokens/) | `workspace` `list_member_tokens` | The tokens that can reach it, each with its `permissions` (`{"issues": "write"}`), `scopes`, `workspace` (null when made for all of its owner's), `repository_selection`, `repositories` and `status` | `access:read` |
| [`GET /workspaces/{workspace}/personal-access-token-requests`](/reference/api/personal-access-tokens/list-token-requests/) | `workspace` `list_token_requests` | The tokens waiting for approval | `access:read` |
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
[access token](#create-a-token) with only the scopes it needs instead.

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
primary, your backup and privacy settings, password changes, pauses after
too many wrong passwords, two-factor authentication turned on or off and
recovery codes made or used, personal access tokens created, deleted or
given new scopes, SSH keys added or removed, and applications authorized,
changed or revoked. Changes g1t staff made, such as removing an address
someone else needed, say so and why.

Token, SSH key, application and two-factor changes are also recorded in the
[audit log](/guides/audit-log/) of each workspace you belong to, where its
owners see them.

## Deleting your account

You can delete your account from
[Settings → Account](https://g1t.sh/settings/account), signed in as
yourself. It is not gone at once: for **30 days** g1t keeps it, so that a
deletion you did not mean, or did not make, can be undone through support.
After 30 days it is removed for good.

1. Open **Settings → Account** and go to **Danger zone**. If anything is
   in the way, it says what, instead of offering the button.
2. Choose **Delete account**. The dialog lists what goes with it: your
   workspaces, the repositories you were added to, your access tokens, SSH
   keys and connected applications.
3. Type your username, and your password unless you signed in within the
   last 10 minutes. An account that signs in with GitHub only signs out,
   signs in with GitHub again, and deletes it within 10 minutes.
4. Choose **Delete account** again. You are signed out, and g1t emails your
   primary and backup addresses to say it was deleted.

There is no API route or MCP tool for deleting an account, by design: like
[creating one](#creating-an-account), it happens only in a browser, signed
in as yourself, never with a token or as an agent.

### What stands in the way

| | |
| --- | --- |
| A workspace you own alone | Each live workspace where you are the only owner is listed. [Make someone else an owner](/guides/workspaces/#change-someones-role) of it, or [delete it](/guides/workspaces/#delete-a-workspace), first. Deleting a workspace settles its billing, which can ask for something first: the list says what. A workspace you own with someone else is not in the way. |
| A protected account | `g1t` and the other names g1t uses for itself can never be deleted, by anyone. |

Billing belongs to workspaces, not to accounts, so once no workspace
depends on you alone there is nothing for billing to settle.

When g1t's staff delete an account, on its owner's request or for abuse,
the workspaces it alone owns are not left without an owner. Staff either
wait for another owner to be made, or delete those workspaces together
with the account, each exactly as its owner would: its billing is settled
first, everything in it goes with it, and it is kept 30 days for a
restore like any deleted workspace. Its audit log records the deletion as
g1t's staff. Staff never do this for a workspace whose billing cannot be
settled yet (an unpaid invoice, prepaid credit, usage still being metered),
or for one of the workspaces g1t protects; if any of them stands in the
way, nothing is deleted.

### What happens

At once, when you delete it:

| | |
| --- | --- |
| Signing in | You are signed out everywhere. Signing in with your password, GitHub, a recovery code or from a tool fails, with the same answer a wrong password gets. |
| Access tokens, SSH keys and applications | Your personal access tokens, SSH keys, connected applications and sign-ins from a tool stop working and are removed, and so do the deploy keys you added to repositories. A workspace's own tokens are not affected, even ones you made. |
| Workspaces, teams and repositories | You leave every workspace and team, and lose the roles you were given on single repositories. Repository invitations waiting for you are withdrawn, and invites you made that nobody used are revoked. |
| Your profile | `g1t.sh/<username>` answers 404, and you drop out of search. Nobody can add you to a workspace, team or repository, and nothing more is emailed to you. |
| What you wrote | Stays where it is, under your username for now. Commits made with your confirmed or noreply addresses show as `ghost`, and as yours again if your account is restored. |
| Your username | Held for your account. Nobody else can take it. |

Within 30 days, support can restore it: write to support@g1t.sh from one
of its addresses. You come back to the workspaces, teams and repositories
you were in, where they are still there, and sign in again with your
password. Your old sessions, tokens and keys stay ended: make new ones.

After 30 days it is removed for good:

| | |
| --- | --- |
| Your addresses, keys and profile | Removed: your email addresses, two-factor secret and recovery codes, GitHub link, picture, profile and security log, and your inbox and its settings. |
| What you wrote | Issues, pull requests, comments and reviews keep their place and their words, and show as written by `ghost`. You are taken off issues and pull requests you were assigned to or asked to review. Commits keep the name and address git recorded in them; those made with your [noreply address](#keeping-your-address-private) show as `ghost`. |
| Workspaces you made | Name `ghost` as their creator. |
| Statements, invoices and audit logs | Kept with your username, for the workspaces they belong to. |
| Your username | Never given to another account or workspace, so links, mentions and remotes that use it keep meaning what they meant. `ghost` is reserved for this, and nobody can register it. |

## What g1t stores

Passwords are stored as salted PBKDF2-SHA256 hashes. Sessions and tokens are
stored as SHA-256 hashes. Neither can be read back. A two-factor secret is
encrypted (AES-256-GCM) and bound to your account, and recovery codes are
kept as SHA-256 hashes.
