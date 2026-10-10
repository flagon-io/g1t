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
| A **mirror**, standing by | The remote | Reading, cloning, search. Nothing else: it's an exact, read-only copy that runs nothing. |
| A mirror in **CI failover** | The remote, for code | The remote's workflows run on g1t. Code, issues and pull requests stay on the remote. |
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

## What a mirror standing by refuses

A standby mirror is a backup you can switch to. It doesn't take work of its
own:

| | Standing by | CI failover | Taken over |
| --- | --- | --- | --- |
| Clone, fetch, browse, search | ✓ | ✓ | ✓ |
| Push, merge, edit on the web | – | – | ✓ |
| Issues, pull requests, agents | – | – | ✓ |
| `.g1t/workflows` | Only with **Keep CI warm** | ✓ | ✓ |
| `.github/workflows` | – | ✓ | ✓ unless turned off |
| Deployments on g1t.page | – | – | ✓ |
| Settings, rules, webhooks | ✓ | ✓ | ✓ |

What's refused says why. A `git push` to a standby mirror answers:

```text
remote: acme/web is a mirror of github.com/acme/web, so it is read-only here.
remote: Push to github.com/acme/web, or take over in Settings → Mirroring to work on g1t.
 ! [remote rejected] main -> main
```

The repository shows **Mirror of github.com/acme/web** beside its name,
and every button that would write is greyed out, with the reason on hover.

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

**End CI failover** when the remote runs its workflows again. Runs already
started finish.

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
Admin role. Agents never move a repository to g1t or handle a remote's
token.

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
