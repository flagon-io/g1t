---
title: GitHub
description: Sign in with GitHub, link your account, and import, mirror or move repositories from GitHub through g1t's GitHub App.
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

- **Username**: your GitHub login, lowercased, if it is free and follows
  g1t's rules (lowercase letters, digits and single hyphens, up to 39
  characters). Otherwise you choose one.
- **Email**: the primary address on your GitHub account, if GitHub says it
  is verified. Only verified addresses count, and GitHub's
  `@users.noreply.github.com` relay addresses are not used. Your email is
  confirmed already, so there is no link to follow.
- **Password**: none. Sign in with GitHub, or set a password later with
  [Forgot your password](https://g1t.sh/forgot).

g1t is invite-only for now. To create an account with GitHub, open the
invite link you were given and choose **Continue with GitHub** there, or
enter your invite code when g1t asks for it after GitHub. Signing in to an
account you already have needs no invite.

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

## Import, mirror or move a repository

1. Choose **New project**, then **Import from GitHub**. You can also go to
   `g1t.sh/new/github`.
2. If your GitHub account is not linked yet, choose **Connect GitHub**.
3. If no GitHub account is connected to the workspace, a workspace owner
   chooses **Install on GitHub**, picks the GitHub account or organization,
   and chooses which repositories the app may see. GitHub returns you to
   g1t, which records the installation for the workspace.
4. Tick the repositories to bring across. You see only repositories that
   both you and the app can reach.
5. Choose how they come across, and whether to copy their issues.
6. Choose **Bring to g1t**.

Each repository becomes a repository on g1t with the same name, private if
it is private on GitHub, and a [project](/guides/projects/) of its own.

| Choice | What happens | Where you push |
| --- | --- | --- |
| **Import** | Copied once. The g1t repository is then its own. | g1t |
| **Standby mirror** | Copied, then every push to GitHub is copied in within seconds. On g1t it's a read-only copy that runs nothing, until you take over. | GitHub |
| **Move to g1t** | Copied, then g1t leads: every push to g1t is pushed to GitHub, so people still working there see it. Branches that exist only on GitHub are left alone. | g1t |

A standby mirror is a backup you can switch to: if GitHub is down, or
whenever you want to work on g1t for a while, **take over** in its
**Settings → Mirroring**, and **hand back** when you're done. You can also
run its GitHub workflows on g1t while GitHub's don't run, or move it to g1t
for good. See [mirroring](/guides/mirroring/).

### What comes across

| | |
| --- | --- |
| Every branch and tag | Yes, with full history |
| Issues | When **Copy issues too** is ticked: up to 200, oldest first, open or closed as on GitHub, with their labels (up to 10 each) |
| Who opened an issue | Named in the issue: by their g1t username if they have linked GitHub, otherwise by their GitHub login. The issue itself is opened by you. |
| Milestones | Named in each issue; g1t has no milestones |
| Issue numbers | New numbers on g1t; each issue links to the original |
| Comments on issues | No |
| Pull requests | No. Their branches come across; open pull requests stay on GitHub. |
| GitHub Actions workflows | Yes, as files. A mirror runs them on g1t in CI failover and when taken over; otherwise rename `.github` to `.g1t` to run them on g1t: see [GitHub Actions](/guides/actions/). |
| Releases, wikis, Git LFS objects | No |

A repository is copied in one piece of at most 40 MB, after compression.
Push a larger one with git instead: see [git](/guides/git/).

### Keep a mirror in step

The repository's **Settings → Mirroring** shows the link: its state,
whether GitHub is answering, and when it last synced. **Sync now** copies
at once. **Take over**, **Hand back**, **Move to g1t** and **Remove** are
there too: see [mirroring](/guides/mirroring/). A standby mirror stops,
keeping its copy, when:

- the repository is deleted on GitHub,
- the app is uninstalled from its GitHub account, or
- a workspace owner removes that GitHub account from the workspace.

If GitHub stops letting the app see a repository, its settings say so; add
it back to the installation on GitHub to carry on. Renaming or
transferring a repository on GitHub keeps the mirror working.

## What g1t's GitHub App can do

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read and write | Read: clone the repositories you choose. Write: to push for **Move to g1t**, and to hand a takeover back. |
| Metadata | Read | Required by GitHub for every app: names, visibility, and whether a branch is protected. |
| Issues | Read | Copy issues when you ask. |
| Pull requests | Read and write | When a takeover is handed back, open a pull request for a branch GitHub protects. Without it, g1t pushes the commits to `g1t/handback/<branch>` and tells you to open the pull request yourself. |
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
  its settings). Mirrors stop; the copies on g1t stay.
- **Change which repositories it sees**: **Choose repositories on GitHub**
  beside the account on the import page.

## The webhook

GitHub tells g1t about pushes, installations and repository changes at
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
