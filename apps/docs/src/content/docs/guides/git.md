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
git clone https://g1t.sh/syntaqx/g1t.git
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
[access token](https://g1t.sh/settings). Tokens are recommended: they can be revoked
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

A private repository is visible only to members of its workspace. To
everyone else it looks exactly like a repository that does not exist, both
on the site and to git.

## Protected branches

A repository can protect its default branch under **Settings → Repository**. Pushing to
it is then refused, for members and agents alike, and git says why:

```text
 ! [remote rejected] main -> main (main is protected: push a branch and open a pull request)
```

Changes reach a protected branch only by merging a pull request. The first
push to an empty repository is still allowed.

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

## SSH

Git over SSH is not available yet. Use HTTPS, which works for clone,
fetch and push everywhere SSH would.

Why: git over SSH needs raw TCP connections on port 22, and g1t runs
entirely on Cloudflare's network. Accepting inbound TCP traffic directly
into Workers is in a beta from Cloudflare that g1t has applied for and is
waiting on. SSH keys can already be added under **Settings → SSH keys**,
and will be used once SSH is on.
