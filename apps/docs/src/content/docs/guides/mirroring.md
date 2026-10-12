---
title: Mirroring
description: Keep a repository in step with copies of it elsewhere. A mirror stands by as a read-only copy until you take over; hand it back when you're done, or move it to g1t for good.
---

Mirroring keeps a repository on g1t in step with a copy of it on another
host: GitHub, another g1t (such as one you run yourself), or any git host
over HTTPS.

Every linked repository has exactly one **leader**, where work happens. The
other copies follow it. That one rule answers every question about which
push wins: a write reaches the leader, or it doesn't land.

| The repository on g1t is | Who leads | What works on g1t |
| --- | --- | --- |
| A **mirror**, standing by | The remote | Reading, cloning, search, what security scanning found, insights and settings. Nothing else: it's an exact, read-only copy that runs nothing and opens nothing. |
| A mirror in **CI failover** | The remote, for code | The same, and the remote's workflows run on g1t. Code, issues and pull requests stay on the remote. |
| A mirror **taken over** | g1t, for now | Everything: pushes, pull requests, issues, agents, workflows. |
| **Mirrored to** other hosts | g1t | Everything. Each push is sent to the followers. |

## Make a mirror

- **From GitHub:** choose **New project → Import from GitHub**, pick the
  repositories and choose **Standby mirror**. See [GitHub](/guides/github/).
- **From another g1t or any git host:** create an empty repository, then
  in its **Settings → Mirroring** choose **Add a remote**, with **The remote
  leads**. Give its https address and a token that can read it. The
  repository is filled from the remote, and only an empty repository can
  become a mirror.

A mirror follows every branch and tag of its remote:

- **GitHub** tells g1t about each push, so the mirror catches up within
  seconds.
- **Other hosts** are asked every five minutes.

Branches deleted on the remote are deleted on g1t. When the remote
force-pushes a branch or deletes it, the commit g1t had is kept under
`refs/g1t/replaced/<branch>/<time>` for at least 30 days. Nothing a mirror
held is lost silently.

## What a standby mirror offers

A standby mirror is a backup you can switch to: an exact copy of the
remote, kept up to date, that you can read and clone. It doesn't take work
of its own, and nothing on g1t opens anything on it by itself. One rule
decides, by state:

| | Standing by | CI failover | Taken over | Handing back |
| --- | --- | --- | --- | --- |
| **Code**: files, commits, branches, tags, compare, releases; clone, fetch, search | ✓ | ✓ | ✓ | ✓ |
| **Security**: what scanning found, read-only | ✓ | ✓ | ✓ | ✓ |
| **Insights**, **Settings** (mirroring settings included), rules, webhooks | ✓ | ✓ | ✓ | ✓ |
| **Workflows**: `.g1t/workflows` | Only with **Keep CI warm** | ✓ | ✓ | – |
| **Workflows**: `.github/workflows` | – | ✓ | ✓ unless turned off | – |
| Push, merge, edit on the web, make a release | – | – | ✓ | – |
| **Issues**, **Pull requests**, **Agents** | – | – | ✓ | – |
| **Deployments** on g1t.page | – | – | ✓ | – |
| Security updates, dependency updates, upkeep: anything that opens a branch or a pull request on its own | – | – | ✓ | – |

What it looks like:

- The repository shows **Mirror of github.com/acme/web** beside its name, and
  so does its row on the workspace's **Projects** page, in the list and the
  grid, where the **Kind** filter can show **Mirrors** or **On g1t** alone.
  A mirror in CI failover, taken over or handing back says that instead.
- Its sidebar lists only what it offers: **Code**, **Security**, **Insights**
  and **Settings**, plus **Workflows** when they run here. Opening an address
  it doesn't offer, such as `/acme/web/issues` or `/acme/web/pulls/new`, shows
  a note that says it's a mirror, links the remote, and leads to **Settings →
  Mirroring**, instead of the list or the form.
- Its overview shows the copy: the remote, the default branch, the latest
  commit, when it last synced, the latest commits and the About card. There
  is no **Where does it run**, no **Get started** checklist and no
  **Right now**: nothing runs here.
- **Security → Vulnerabilities** still lists what the daily scan found, but
  no security update opens: each alert says the update waits until the
  repository is taken over or moved to g1t. The same goes for
  [dependency updates](/guides/dependency-updates/) and anything else g1t
  does on its own.
- Every button that would write is greyed out, with the reason on hover, and
  the services refuse the write as well: a form posted to a mirror answers
  `409` with the reason, and the API answers `403`.

A `git push` to a standby mirror answers:

```text
remote: acme/web is a mirror of github.com/acme/web, so it is read-only here.
remote: Push to github.com/acme/web, or take over in Settings → Mirroring to work on g1t.
 ! [remote rejected] main -> main
```

**Taking over** changes all of it at once: the sidebar fills in, the
overview shows where the project runs and what is moving, security and
dependency updates open on the next scan, and pushes, pull requests, issues,
agents, workflows and deployments work until you hand back. **Moving to g1t**
does the same for good.

## When the remote stops answering

g1t checks each remote's host every minute. A host is **unreachable**
after three failed checks over at least two minutes. A refused token or a
deleted repository isn't the host being down; those show as an error on
the link instead. The host is reachable again after three good checks over
at least five minutes.

By default an unreachable remote is only **shown**: the repository's dot
turns amber and a banner offers **Take over**. Nobody is paged and nothing
happens on its own. If it's midnight and nobody needs to work, GitHub comes
back and the mirror catches up. Nothing needs reconciling, because nobody
wrote to g1t.

You choose how much more happens, per link, in **Settings → Mirroring**:

| Setting | Default | Options |
| --- | --- | --- |
| When the remote stops answering | Show it on the repository | Also tell the workspace's owners in their [notifications](/guides/notifications/) |
| Take over automatically | Off | After 5 to 1440 minutes unreachable |
| Hand back on its own | When every branch goes back cleanly | Only when someone hands it back |
| Keep CI warm | Off | Run `.g1t/workflows` on each push copied in |
| Run the remote's `.github` workflows | On | Off |
| Hold workflows that deploy for approval | On | Off |
| Report checks to GitHub | On | Off. Only for a mirror of a GitHub repository; see [Checks on GitHub](#checks-on-github). |

**Hand back on its own** only applies to takeovers g1t started itself. A
takeover a person started waits for a person to hand it back.

## CI failover

Sometimes the remote's git works but its workflows don't run. **Start CI
failover** keeps the remote in charge of the code and runs its workflows on
g1t for each push copied in:

- `.github/workflows` as well as `.g1t/workflows`. When both folders have
  a workflow of the same `name:`, g1t's own runs.
- Workflows that deploy wait for approval, so nothing deploys from two
  places. A workflow deploys when any job names an `environment:`.
- Secrets come from the [project on g1t](/guides/secrets-and-variables/),
  never the remote's.
- A push copied in that changes `.g1t/`, `.github/workflows/` or
  `.github/actions/` starts runs that wait for approval before they can
  use the repository's secrets and variables.

**End CI failover** when the remote runs its workflows again. Runs already
started finish.

## Checks on GitHub

While g1t runs a GitHub mirror's workflows, in CI failover, during a
takeover, or with **Keep CI warm**, it reports their results to the commit
on GitHub. You can keep GitHub as the place you work and still see, on
each commit and pull request there, what g1t ran.

What g1t reports is each status it sets on a commit: a workflow run, and a
deploy. Each becomes a commit status on GitHub:

| On GitHub | What it is |
| --- | --- |
| Context | The status's name on g1t under `g1t / `: a workflow run's `CI / push` shows as `g1t / CI / push`. A name that already starts with `g1t / `, such as a deploy's `g1t / deploy`, stays as it is. |
| State | `pending` while it runs, then `success`, `failure` or `error`, as on g1t. A cancelled run is `error`. |
| Description | The status's description on g1t, cut to GitHub's 140 characters. |
| Details | A link to the run, or the deploy, on g1t. |

A status is sent once each time it changes. Only commits that came from
GitHub are reported: a commit made on g1t during a takeover isn't on
GitHub until it's handed back, so it is skipped. A mirror standing by
without **Keep CI warm** runs nothing, so it reports nothing.

g1t reports through its GitHub App, which needs the **Commit statuses**
permission, read and write. When the app's installation doesn't have it,
GitHub refuses, and the mirror's **Settings → Mirroring** page says
**g1t can't report checks to GitHub: the GitHub App needs the Commit
statuses permission**. g1t doesn't retry; it tries again with the next
status, and the line goes once a status gets through. To grant it, an
owner of the GitHub account or organization accepts the app's new
permissions on GitHub, under **Settings → Applications → Installed GitHub
Apps → g1t-sh**.

To turn it off, clear **Report checks to GitHub** in the mirror's
**Settings → Mirroring** and save. Through the API, send
`report_checks: false` to
`PATCH /repos/{owner}/{name}/mirror/remotes/{id}`.

## Take over

**Take over** makes g1t lead the repository for now, whether or not the
remote is answering. Everything works on g1t from then on. Each branch's
commit at that moment is recorded as where the takeover began.

You can take over any time: during an outage g1t detected, a partial one
it didn't, or simply because you want to work on g1t for a while.

If the remote is still answering, people may keep pushing there. Their
work isn't lost. Each branch that changed on both sides waits for a
decision when you hand back.

## Hand back

**Review hand-back** shows what handing back would do, branch by branch,
by comparing each side with where the takeover began:

| Plan | When | What happens |
| --- | --- | --- |
| **Push** | Only g1t changed it | g1t's commits are pushed to the remote. |
| **Take** | Only the remote changed it | The remote's commits are copied in. |
| **Pull request** | Only g1t changed it, and the remote protects the branch | g1t's commits go to `g1t/handback/<branch>` on the remote, with a pull request into the branch. g1t then follows the remote's branch. |
| **Diverged** | Both changed it | You decide: keep g1t's (pushed over the remote's), keep the remote's (g1t's is kept under `refs/g1t/replaced/`), or send g1t's as a pull request. |

**Hand back** carries out the plan. The repository is read-only while it
goes back, so nothing moves under it. If the remote refuses anything, g1t
keeps the lead and says why; nobody is left stuck. When every branch has
gone back, the mirror stands by again and lists any pull requests it
opened.

Hand back is refused while the remote isn't answering, and while a
diverged branch has no decision.

## Move to g1t

**Move to g1t** makes the move permanent. The repository stops being a
mirror, and **g1t no longer tracks the remote**: pushes made there don't
come here any more. You can move from standby, CI failover or during a
takeover, and the takeover's work stays as it is.

Tick **Keep the remote updated from g1t** to turn the remote into a
follower instead of dropping it. g1t then pushes every change to it, as
below.

## Mirror to other hosts

A repository g1t leads can be **mirrored to** any number of followers.
Use another g1t to keep a copy on your own servers, or keep GitHub up to
date for people still working there.

In **Settings → Mirroring**, **Add a remote** with **g1t leads**, its https
address, a username if the host needs one, and a token that can push. The
token is stored encrypted and never shown again. Repositories imported
from GitHub with **Move to g1t** follow g1t this way already.

Each push to g1t is sent to every follower. When someone pushes to a
follower directly:

- **Take in fast-forwards** (the default): a push that builds on g1t's
  branch is copied in. Anything else marks the follower **stuck**. g1t
  stops pushing to it until someone chooses **Sync now**, which pushes
  g1t's branches over it.
- **Overwrite with g1t's**: g1t pushes its branches over the change at once.

A follower that refuses g1t's push, a protected branch say, is also marked
stuck, with its answer on the link.

## Self-hosted g1t and g1t.sh

The `g1t` remote works both ways between instances:

- Run g1t on your own servers as the leader and mirror to
  [g1t.sh](https://g1t.sh) for a hosted copy, or the other way round.
- Make a standby mirror on your own g1t of a repository on g1t.sh. Take
  over if g1t.sh is unreachable from your network.

Use a [token](/guides/authentication/) with `code:read` for a leader, or
`code:write` for a follower, on the other instance.

## API, MCP and events

Everything here is also in the API at `/repos/{owner}/{name}/mirror`, and
as the `mirror_*` actions of the MCP `repository` tool. See the
[API reference](/reference/api/). Reading a repository's
mirroring needs read access; syncing needs push; everything else needs the
Admin role. Agents never move a repository to g1t, nor add, change or
remove a remote.

Removing a remote makes a mirror an ordinary repository with what it has,
and stops pushes to a follower. It is refused during a takeover: hand it
back or move it to g1t first.

[Webhooks](/guides/webhooks/) can subscribe to:

- `mirror.unreachable` and `mirror.reachable`
- `mirror.state_changed`, sent when a mirror stands by, enters CI
  failover, is taken over or is handed back
- `mirror.moved_in`, sent when a mirror is moved to g1t or stops because
  its remote is gone

## When a remote goes away

A standby mirror becomes an ordinary repository, keeping what it has, when:

- the repository is deleted on GitHub,
- g1t's GitHub App is uninstalled from its account, or
- a workspace owner removes that GitHub account from the workspace.

A takeover in progress keeps going and says why on the link: move it to
g1t to keep it.

## Not supported yet

- Checks go back to GitHub as commit statuses, one per workflow run; a
  run's jobs aren't shown there as separate check runs. Remotes other than
  GitHub aren't told about checks.
- CI failover starts only when someone starts it.
- A takeover runs under the repository's own [rules](/guides/rules/) on
  g1t, not the remote's branch protection.
- A mirror doesn't show the remote's pull requests.
- GitLab and Bitbucket repositories link as any host over HTTPS, asked
  every five minutes.
