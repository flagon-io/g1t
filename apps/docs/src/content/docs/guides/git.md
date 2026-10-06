---
title: Git
description: Remotes, credentials, private repositories and limits.
---

g1t speaks git's smart HTTP protocol. Any git client works.

## Remotes

```text
https://g1t.sh/<workspace>/<repo>.git
```

Public repositories can be cloned without signing in:

```sh
git clone https://g1t.sh/flagon-io/g1t.git
```

If the workspace is [renamed](/guides/workspaces/#rename-a-workspace), the
old remote redirects to the new one for 90 days. Git follows the redirect
and warns about it; point the remote at the new address:

```sh
git remote set-url origin https://g1t.sh/<new-workspace>/<repo>.git
```

## Authentication

Pushing, and reading private repositories, needs credentials. Use your
username, and as the password either your account password or an
[access token](https://g1t.sh/settings/tokens). Tokens are recommended: they can be revoked
individually and they also work for the API.

To avoid typing it each time, let git store it:

```sh
git config --global credential.helper store
```

## Creating a repository by pushing

Pushing to a repository that does not exist, in a workspace you belong to,
creates it as a public repository.

```sh
git push https://g1t.sh/<workspace>/new-repo.git main
```

## Private repositories

A private repository is visible only to people with a
[role](/guides/access-and-roles/) on it. Cloning and fetching need
Read, and pushing needs Write. To
everyone else it looks exactly like a repository that does not exist, both
on the site and to git.

On the site, an address you cannot see gives the same page either way, with
status 404:

| You are | The page says |
| --- | --- |
| Signed out | **Nothing here**: this page doesn't exist, or it's private; sign in if it's yours. **Sign in** brings you back to the same address. |
| Signed in | **Nothing here**: this page doesn't exist, or you don't have access to it, with which account you are signed in as and a link to switch account. If you should have access, ask someone with the Admin role on it to add you. |

Issues, pull requests and workspace pages work the same way. The sidebar
does not open the project or workspace the address names, so nothing on
the page hints at whether it exists; a missing file, commit or issue in a
project you can see keeps that project's sidebar. A profile that does not
exist says **No one on g1t goes by that name**, since profiles are public.

## Browsing without an account

Public projects, Explore, Search and profiles are open to everyone, in the
same sidebar members use. Signed out, the sidebar has Explore and Search,
and in a project its Code, Issues, Pull requests, Agents, Workflows and
Deployments; pages only people with a role on the repository see, such as
Security and Settings, are left out. **Sign in** and **Sign up** sit at the bottom, and both bring you
back to the page you were on.

## Protected branches

A repository can protect its default branch under **Settings → Branches and
merging**. Pushing to it is then refused for everyone, whatever their role, and for agents, and
git says why:

```text
 ! [remote rejected] main -> main (main is protected: push a branch and open a pull request)
```

Changes reach a protected branch only by merging a pull request. The first
push to an empty repository is still allowed.

The same page sets what a merge needs: the
[required status checks](/guides/pull-requests/#required-status-checks)
and approvals.

## Branches

Push any branch to a repository you can write to, and open a
[pull request](/concepts/overview/#pull-requests) from it on the
repository's **Pull requests** tab.

```sh
git switch -c my-change
git push origin my-change
```

## Pull request forks

A pull request that was not opened from a branch has its own remote:

```text
https://g1t.sh/pulls/<pull request id>.git
```

Only whoever opened the pull request can push to it. Pushes to a fork
update the pull request's head commit on its page.

## Limits

Repositories are stored in Cloudflare Artifacts, which limits a repository to
1 GB and a single file to 32 MB. A single push is limited to 100 MB.

Each clone, fetch and push is a git operation. Every workspace has 50,000
a month included. Past that, a workspace on the g1t plan pays $0.18 per
1,000, and a free workspace is never charged: past 50,000 in a month, its
git requests past 60 in an hour are answered `429` with when to try again,
until the month turns. Counting starts on 2026-10-14. See
[git operations](/guides/usage-and-billing/#git-operations).

What these limits mean in practice, and what to do instead, is on
[What g1t can't do yet](/about/limitations/#git).

## Where a slow request's time went

Every answer g1t gives git carries a `Server-Timing` header: how many
milliseconds each step of the request took. To see it, run git with its
HTTP trace on:

```sh
GIT_TRACE_CURL=1 git ls-remote https://g1t.sh/<owner>/<repo>.git 2>&1 | grep -i server-timing
```

| Step | What it is |
| --- | --- |
| `repo` | Finding the repository, and checking your credentials if you sent any |
| `moved` | Only for an address with no repository: looking for a renamed workspace or a transferred repository to send you to |
| `access` | Deciding whether you may fetch from or push to it |
| `kept` | A free workspace's limits, and looking for a ref listing and a store credential made a moment ago |
| `mint` | Only when no credential was kept: the git store making one for the request |
| `store` | The git store's answer; for a push, checking it for secrets first |
| `refs` | Only for a push: recording that the repository's refs changed |
| `total` | Everything g1t did |
| `repos` | The same, measured where your request arrived |

Two entries say how a step went rather than how long it took:

| Entry | Values |
| --- | --- |
| `refs;desc=` | `hit-colo` or `hit-shared` when the ref listing came from g1t's cache, `miss` when the git store was asked |
| `cred;desc=` | `isolate` or `shared` for a store credential made a moment ago, `mint` for a new one |

The ref listing git asks for first on every clone and fetch is kept for up
to a minute, and only the same question about the same refs gets the same
answer: a push, a merge or any other change to a repository's branches and
tags makes the next fetch ask the git store again. A change can take up to
5 seconds to reach every fetch.

Include the header when you report a slow clone, fetch or push.

## SSH

Git over SSH is not available yet. Use HTTPS, which works for clone,
fetch and push everywhere SSH would.

Why: git over SSH needs raw TCP connections on port 22, and g1t runs
entirely on Cloudflare's network. Accepting inbound TCP traffic directly
into Workers is in a beta from Cloudflare that g1t has applied for and is
waiting on. SSH keys can already be added under
[Settings → SSH keys](https://g1t.sh/settings/keys),
and will be used once SSH is on.
