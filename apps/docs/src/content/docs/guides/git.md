---
title: Git
description: Remotes, credentials, private repositories and limits.
---

g1t speaks git's smart HTTP protocol. Any git client works.

## Remotes

```text
https://g1t.sh/<owner>/<repo>.git
```

Public repositories can be cloned without signing in:

```sh
git clone https://g1t.sh/syntaqx/g1t.git
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

Pushing to a repository that does not exist under your own username creates
it as a public repository.

```sh
git push https://g1t.sh/<username>/new-repo.git main
```

## Private repositories

A private repository is visible only to its owner. To everyone else it looks
exactly like a repository that does not exist, both on the site and to git.

## Attempt forks

Each [attempt](/concepts/overview/) has its own remote:

```text
https://g1t.sh/attempts/<attempt id>.git
```

Only the person who started the attempt can push to it. Pushes to a fork
update the attempt's head commit on its page.

## Limits

Repositories are stored in Cloudflare Artifacts, which limits a repository to
1 GB and a single file to 32 MB. A single push is limited to 100 MB.

## SSH

Git over SSH is not available yet. Use HTTPS.
