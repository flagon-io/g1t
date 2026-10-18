---
title: GitHub
description: Sign in with GitHub, link your account, and import repositories from GitHub through g1t's GitHub App.
---

g1t has one GitHub App, [g1t-sh](https://github.com/apps/g1t-sh). It does two
things: it signs you in with your GitHub account, and, once you install it
on a GitHub account or organization, it lets g1t read the repositories you
choose there and bring them across.

## Sign in with GitHub

1. On [g1t.sh/login](https://g1t.sh/login) or
   [g1t.sh/register](https://g1t.sh/register), choose **Continue with GitHub**.
2. GitHub asks you to authorize g1t. Choose **Authorize**.
3. You are back on g1t, signed in.

The first time, g1t makes your account:

- **Username**: your GitHub login, in its own case, if it is free in any
  case and follows g1t's rules (letters, digits and single hyphens, up to
  39 characters; see [creating an account](/guides/authentication/#creating-an-account)).
  Otherwise you choose one.
- **Email**: the primary address on your GitHub account, if GitHub says it
  is verified. Only verified addresses count, and GitHub's
  `@users.noreply.github.com` relay addresses are not used. Your email is
  confirmed already, so there is no link to follow.
- **Password**: none. Sign in with GitHub, or set a password later with
  [Forgot your password](https://g1t.sh/forgot).

Anyone can create an account with GitHub: choose **Continue with GitHub**
on [g1t.sh/register](https://g1t.sh/register). If someone invited you into
a workspace or onto a repository, open their invite link and choose
**Continue with GitHub** there instead, so the new account gets the
invitation.

Signing in with GitHub does not start a trial or give your workspace
compute. That works as it does for any account: see
[usage and billing](/guides/usage-and-billing/).

### If an account already has your email

If one of your verified GitHub addresses belongs to a g1t account that is
not linked to GitHub, g1t does not link them on its own: owning the GitHub
account does not prove you own the g1t one. g1t shows **An account with
this email exists. Sign in to link GitHub**. Sign in to that account with
its password, and GitHub is linked to it. From then on, **Continue with
GitHub** signs you in to it.

The offer lasts 30 minutes. If you sign in to a different account in that
time, GitHub is linked to the account you signed in to.

## Link and unlink GitHub

In [Settings → GitHub](https://g1t.sh/settings/github):

- **Link GitHub** sends you to GitHub and links the account you authorize.
  One GitHub account links to one g1t account, and the other way round.
- **Unlink** removes the link and ends g1t's authorization on GitHub. It is
  refused while GitHub is the only way you sign in: set a password first.
- **Link again** appears when g1t's access to your GitHub account has
  ended, for example because you revoked it on GitHub. Linking again is
  needed to import repositories, not to sign in.

g1t identifies your GitHub account by its numeric id, not its login, so
renaming yourself on GitHub keeps the link. Signing in, linking and
unlinking are recorded in the [audit log](/guides/audit-log/) of each
workspace you belong to, as `github.sign_in`, `github.linked` and
`github.unlinked`.

## Import a repository

1. Choose **New project**, then **Import from GitHub**. You can also go to
   `g1t.sh/new/github`.
2. A workspace owner chooses **Connect GitHub**. In one trip to GitHub,
   g1t links your GitHub account (if it is not linked yet) and installs
   its GitHub App on the account or organization you pick, with the
   repositories you let it see. GitHub then returns you to the import page
   with that account connected to the workspace. If the app is installed
   on your GitHub account already, g1t adds that installation instead of
   asking you to install again; with several, you choose which to add.
3. Members who are not owners choose **Connect GitHub** to link their own
   GitHub account, and import from the accounts an owner connected.
4. Tick the repositories to bring across. You see only repositories that
   both you and the app can reach.
5. Choose whether to copy their issues, as [work items](/work/work-items/).
6. Choose **Bring to g1t**.

Each repository becomes a repository on g1t with the same name, private if
it is private on GitHub, and a [project](/guides/projects/) of its own. It
is copied once: the g1t repository is then its own, and you push to g1t.
Nothing on GitHub changes.

### Already installed the app on GitHub?

g1t adds an installation to a workspace when GitHub sends you back to g1t
after you install the app. If you installed it on GitHub directly, in
another browser, or the return to g1t was lost, add it from g1t instead:

1. Open `g1t.sh/new/github?workspace=<workspace>` and choose **Connect
   GitHub**. With one installation, g1t adds it straight away.
2. With several, choose **Add to** the workspace beside the GitHub account
   or organization under **Already installed on GitHub**.

Only a workspace owner can add one, and only an installation your own
GitHub account can see: on your account, or on an organization you belong
to.

If GitHub sends you to g1t after an installation that did not start from
g1t, g1t adds it to the workspace you own, or asks which one if you own
several, linking your GitHub account on the way if needed. It is the same
check: the installation must be one your GitHub account can see.

**Choose repositories on GitHub**, beside a connected account, opens the
installation's settings on GitHub; saving there brings you back to the
import page.

### What comes across

| | |
| --- | --- |
| Every branch and tag | Yes, with full history |
| Its description | Yes, as its [project's](/guides/projects/) description, since a repository on g1t has none of its own. Change it later in the project's **Settings → General**. |
| Issues | When **Copy issues too** is ticked: up to 200, oldest first, open or closed as on GitHub, with their labels (up to 10 each). Each becomes a work item of the workspace, with the new repository as its origin |
| Who opened an issue | Named in the work item: by their g1t username if they have linked GitHub, otherwise by their GitHub login. The work item itself is opened by you. |
| Milestones | Named in each work item; not copied |
| Issue numbers | New numbers on g1t, the workspace's next; each work item links to the original issue |
| Comments on issues | No |
| Pull requests | No. Their branches come across; open pull requests stay on GitHub. |
| GitHub Actions workflows | Yes, as files. Rename `.github` to `.g1t` to run them on g1t: see [GitHub Actions](/guides/actions/). |
| Releases, wikis, Git LFS objects | No |

A repository is copied in one piece of at most 40 MB, after compression.
Push a larger one with git instead: see [git](/guides/git/).

## What g1t's GitHub App can do

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read | Clone the repositories you choose. |
| Metadata | Read | Required by GitHub for every app: names, visibility, and whether a branch is protected. |
| Issues | Read | Copy issues, as work items, when you ask. |
| Email addresses (account) | Read | Find your verified email when you sign in. |

The app only ever sees the repositories you or your organization's owners
choose on GitHub. g1t keeps your GitHub user token, which expires every 8
hours, and its refresh token, encrypted at rest, and uses them only to list
your installations and repositories. Repository access uses short-lived
installation tokens, which g1t gets as the app when it needs one.

## Revoke or uninstall

- **Stop signing in with GitHub**: unlink it in Settings, or revoke **g1t**
  in GitHub under **Settings → Applications → Authorized GitHub Apps**.
  Revoking on GitHub ends g1t's access at once; you can still sign in with
  GitHub afterwards, which authorizes g1t again.
- **Stop g1t reading repositories**: uninstall the app in GitHub under
  **Settings → Applications → Installed GitHub Apps** (for an organization,
  its settings). Repositories already imported stay on g1t.
- **Change which repositories it sees**: **Choose repositories on GitHub**
  beside the account on the import page.

## The webhook

GitHub tells g1t about installations and repository changes at
`POST https://api.g1t.sh/hooks/github`. g1t checks each delivery's
`X-Hub-Signature-256` against the app's webhook secret, ignores a delivery
id it has already seen (`X-GitHub-Delivery`), and answers `202` before
acting on it.

| Answer | When |
| --- | --- |
| `202` | Received; acted on afterwards |
| `200` | A delivery already received |
| `400` | No `X-GitHub-Delivery`, or a body that is not JSON |
| `401` | Not signed with the app's webhook secret |
| `404` | No GitHub App is configured on this g1t |
| `413` | A body over 10 MB |

On your own g1t, register an app of your own: see
[run g1t yourself](/guides/self-hosting/#sign-in-with-github-and-import-from-github).
