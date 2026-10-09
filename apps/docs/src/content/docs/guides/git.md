---
title: Git
description: Remotes, credentials, private repositories, deploy keys and limits.
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
creates it as a private repository, so nothing pushed by mistake is
published. To make it public, see
[change who can see a repository](/guides/managing-repositories/#change-who-can-see-a-repository).

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

## Download a ZIP

On a repository's **Files** page, **Code** → **Download ZIP** downloads the
branch shown as one zip, its files in a folder named `<repo>-<branch>`. It
works for anyone who can see the repository, and for any branch, tag or
commit at `g1t.sh/<workspace>/<repo>/archive/<ref>.zip`. A ZIP holds the
files, not the history; clone for that. A repository with more than 10,000
files or over 24 MB is too large to download this way, so clone it instead.

## Browsing without an account

Public projects, Explore, Search and profiles are open to everyone, in the
same sidebar members use. Signed out, the sidebar has Explore and Search,
and in a project its Code, Issues, Pull requests, Agents, Workflows and
Deployments; pages only people with a role on the repository see, such as
Security and Settings, are left out. **Sign in** and **Sign up** sit at the bottom, and both bring you
back to the page you were on.

## Protected branches

A repository protects its branches and tags with [rulesets](/guides/rules/),
under **Settings → Rules**. A push that breaks a rule is refused for
everyone, whatever their role, and for agents, unless a ruleset lists them
as able to bypass it. Git prints which ruleset and rule refused it, and how
to fix it:

```text
remote: error: rules for refs/heads/main declined this push:
remote: - Changes to main must be made through a pull request. [ruleset "Protect main", pull_request]
remote:   Push a branch, open a pull request into main, and merge it.
 ! [remote rejected] main -> main (declined by ruleset "Protect main" (pull_request))
```

With **Require a pull request before merging**, changes reach a branch only
by merging a pull request. Creating the branch, such as the first push to
an empty repository, is still allowed. Rulesets also block force pushes and
deletions, restrict who creates branches and tags, check commit messages,
signatures and the files a push changes, and set what a merge needs. See
[rules](/guides/rules/).

## Branches

Push any branch to a repository you can write to, and open a
[pull request](/concepts/overview/#pull-requests) from it on the
repository's **Pull requests** tab.

```sh
git switch -c my-change
git push origin my-change
```

A repository's **Branches** tab, `g1t.sh/<workspace>/<repo>/branches`, lists
every branch: the default one first, then those with a commit in the last 90
days (**Active**), then the rest (**Stale**). Each shows its last commit, how
many commits it is ahead of and behind the default branch, the pull request
open on it with its checks, and its preview when it has one. A branch with
no pull request links to opening one; one with nothing the default branch
lacks (ahead `0`) says **Nothing to merge** instead. The counts are exact,
merges included. g1t reads up to 1,000 commits of each history to find
where the two meet; a branch that left the default branch further back
than that shows no counts. Search narrows the list by name.

The **Tags** tab lists tags newest first, up to 100, each with its commit
and a ZIP of its files.

**Compare**, `g1t.sh/<workspace>/<repo>/compare/<base>...<head>`, shows
what one branch has that another does not: its commits, then every change.
Pick the two branches at the top; **Open a pull request** starts one from
the compared branch.

On **Files**, each file and folder shows the commit that last changed it and
when, from the branch's whole history. On a long history the first view
can show some of them blank while g1t finishes reading it; a later view
fills them in, and after a push only the new commits are read. The branch menu at the top switches branch and keeps the
folder or file you are on.

## Pull request forks

A pull request that was not opened from a branch has its own remote:

```text
https://g1t.sh/pulls/<pull request id>.git
```

Only whoever opened the pull request can push to it, or, for one g1t
made, whoever asked for it. Pushes to a fork
update the pull request's head commit on its page.

## Limits

### Size limits

Repositories are stored in Cloudflare Artifacts. g1t checks its limits
before a push is stored, and declines a push that would cross one. git
prints the reason beside each branch (`! [remote rejected] main (…)`), and
what to do as `remote:` lines. Nothing in a declined push is stored.

| Limit | Size | What happens past it |
| --- | --- | --- |
| A file | 32 MB | The push is declined, naming the file's size. |
| A repository, with its pull requests' forks | 950 MB, as g1t counts what was pushed (the store holds 1 GB) | The push is declined; once full, pushes are refused with the reason before any data is sent. |
| A push that push protection can scan before it lands | Most pushes; very large ones are scanned after they land | A very large push goes through and is scanned after it lands; secrets found are open alerts. To have it checked first, push in parts, oldest commits first. |
| A push | 100 MB | Refused by the network with HTTP `413` before g1t sees it. |

To push a large history in parts:

```sh
git rev-list --reverse HEAD | awk 'NR % 500 == 0' | xargs -I{} git push origin {}:refs/heads/main
git push origin main
```

Each push sends only what the one before did not.

### Pushes of many branches or tags

Every branch and tag in a push is stored. Each one is also announced as a
`git.push` event, which starts workflows, mirrors the repository and
calls webhooks, except in a push of many:

| A push of | What is announced |
| --- | --- |
| Up to 3 tags | Each tag |
| More than 3 tags (`git push --tags`, say) | None of the tags |
| Up to 1,000 branches | Each branch |
| More than 1,000 branches | Only the default branch, if it moved |

To have tags start workflows, push them 3 or fewer at a time.

### When the store is busy

If Cloudflare Artifacts is rate limiting g1t or not answering, g1t tries
reads again for a moment, then answers git with HTTP `429` (rate limited)
or `503` (unavailable) and a `Retry-After` header saying how many seconds
to wait. Pushes are never tried again on your behalf: run `git push`
again. On g1t.sh the page says the git storage is busy instead of failing,
and [status.g1t.sh](https://status.g1t.sh) shows **Git storage**.

### Git operations

Each clone, fetch and push is a git operation, your agents' included:
their sandboxes use the same git endpoints you do, and a pull request's
working copy counts for its repository's workspace. Every workspace has 50,000
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
| `pack;desc=` | Only for a fresh clone: `hit` when its pack came from g1t's cache, `miss` when the git store built it |
| `cred;desc=` | `isolate` or `shared` for a store credential made a moment ago, `mint` for a new one |

The ref listing git asks for first on every clone and fetch is kept for up
to a minute, and only the same question about the same refs gets the same
answer: a push, a merge or any other change to a repository's branches and
tags makes the next fetch ask the git store again. A change can take up to
5 seconds to reach every fetch.

A fresh clone, one that has no objects yet (shallow clones such as
`git clone --depth=1` included), has its pack kept too, for up to 7 days
or until the repository's branches or tags next change. The next clone that
asks for the same commits in the same way gets the same pack without the
git store building it again. A fetch into a repository you already have,
and any pack over 200 MB, always goes to the git store.

Include the header when you report a slow clone, fetch or push.

## SSH

Git over SSH is not available yet. Use HTTPS, which works for clone,
fetch and push everywhere SSH would.

Why: git over SSH needs raw TCP connections on port 22, and g1t runs
entirely on Cloudflare's network. Accepting inbound TCP traffic directly
into Workers is in a beta from Cloudflare that g1t has applied for and is
waiting on. SSH keys can already be added under
[Settings → SSH keys](https://g1t.sh/settings/keys),
and will be used once SSH is on. So can [deploy keys](#deploy-keys).

## Deploy keys

A deploy key is an SSH key that reaches one repository and nothing else.
Give one to a server or a pipeline that needs to clone a repository, or
push to it, without a person's account behind it. A deploy key belongs to
the repository: it keeps working when the person who added it leaves the
workspace, and it is not tied to anyone's role.

:::note
Deploy keys are used over SSH, which is [not on yet](#ssh). You can add
them now, and they will work as soon as SSH is. Until then, a machine can
clone and push over HTTPS with a
[workspace access token](/guides/workspaces/#workspace-access-tokens).
:::

### Read-only or read and write

A deploy key is read-only unless you choose **Allow write access** when
you add it:

| Access | It can |
| --- | --- |
| **Read-only** (the default) | Clone and fetch the repository, private or not. |
| **Read and write** | Clone, fetch and push, workflow files under `.g1t/workflows/` and `.github/workflows/` included. |

Either way it reaches only its own repository: any other address is
refused, in its workspace or anywhere else, and so is pushing to an
address with no repository, which would otherwise make one.

A key with write access can change workflows, and workflows run with the
repository's secrets. Allow it only for a machine that must push. You
cannot change a key's access later: delete it and add it again.

### Add a deploy key

You need the Admin role on the repository and a confirmed email address.

1. Make a key pair on the machine that will use it, without a passphrase
   if it runs unattended:

   ```sh
   ssh-keygen -t ed25519 -C "deploy@build-server" -f ~/.ssh/g1t_deploy -N ""
   ```

2. Open the repository's **Settings → Deploy keys**,
   `g1t.sh/<workspace>/<repo>/settings/keys`.
3. Under **Add a deploy key**, give it a **Title**, such as the machine that
   uses it, and paste the public key (`~/.ssh/g1t_deploy.pub`) into **Key**.
   Left without a title, it takes the key's comment.
4. Choose **Allow write access** only if the machine must push.
5. Choose **Add deploy key**.

g1t takes `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`,
`ecdsa-sha2-nistp521` and `ssh-rsa` keys. A public key can be registered
once on g1t: a key that is already someone's SSH key, or a deploy key on
any repository, is refused with **Key is already in use.** Give each
machine, and each repository, its own key. A repository can have up to
100 deploy keys.

### Manage deploy keys

**Settings → Deploy keys** lists every key on the repository, oldest
first, with its title, fingerprint, whether it is **Read-only** or **Read
and write**, who added it and when, and when it was last used. **Last
used** is when the key last signed in over SSH, to within 5 minutes;
**Never used** means it never has. Use it to find keys nothing uses any
more.

To remove a key, choose **Delete** beside it and confirm. Anything using
it stops at once.

Only people with the Admin role on the repository see the page and
manage its keys. An agent's token never can, and neither can a deploy key.
A workspace's own access token can only when an owner gave it Admin. See
[access and roles](/guides/access-and-roles/#deploy-keys). Adding and
deleting a key is recorded in the workspace's
[audit log](/guides/audit-log/) as `repo.deploy_key_added` and
`repo.deploy_key_removed`.

Deploy keys are kept by repository, so renaming or transferring the
repository keeps them. While a repository is deleted its keys do not work,
and when it is removed for good they go with it.

### Use a deploy key with git

Once SSH is on, point git at the key for the repository's remote:

```sh
GIT_SSH_COMMAND="ssh -i ~/.ssh/g1t_deploy -o IdentitiesOnly=yes" \
  git clone git@g1t.sh:<workspace>/<repo>.git
```

Or name it in `~/.ssh/config` for every git command on that machine:

```text
Host g1t.sh
  User git
  IdentityFile ~/.ssh/g1t_deploy
  IdentitiesOnly yes
```

A machine that needs several repositories needs a key for each; give each
a `Host` alias with its own `IdentityFile`.

### Through the API

| Route | MCP tool and action | What it does |
| --- | --- | --- |
| `GET /repos/{owner}/{name}/keys` | `access` `list_deploy_keys` | The repository's deploy keys. |
| `GET /repos/{owner}/{name}/keys/{id}` | `access` `get_deploy_key` | One key, by its `id`. |
| `POST /repos/{owner}/{name}/keys` | `access` `add_deploy_key` | Add a key. Body: `title`, `key` and `read_only` (true unless you send false). |
| `DELETE /repos/{owner}/{name}/keys/{id}` | `access` `remove_deploy_key` | Delete a key. |

Listing and reading need the `access:read` scope; adding and deleting
need `access:admin`. Each needs the Admin role on the repository.

```sh
curl https://api.g1t.sh/repos/acme/rocket/keys \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Build server", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE", "read_only": true}'
```

```json
{
  "id": "dk_01kp3f2g3h4j5k6m7n8p9q0r1s",
  "title": "Build server",
  "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE",
  "fingerprint": "SHA256:ubxEl41fJDnUoEPKSZE0y6R0ZjjAQf/wV5vZgeBV8qk",
  "read_only": true,
  "created_at": "2026-10-08T09:12:00.000Z",
  "created_by": "ada",
  "last_used_at": null
}
```

See [create a deploy key](/reference/api/access/create-deploy-key/) in the
API reference.
