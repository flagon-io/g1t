# Mirroring: keeping remotes in sync

> **2026-10-08:** "bidirectional synchronization from GitHub or whatever
> providers … as well as setting up a different remote (think self-hosted g1t
> and mirroring to the hosted g1t.sh platform) so that it will keep remotes in
> sync with each other." And: "GitHub is down, I want to run GitHub's
> workflows on g1t, but only until GitHub is back up. But what if I push on
> g1t?" And: "It needs to be highly clear when a repository is mirrored, and
> things are disabled … It should still work as a repository when it's in
> mirror mode."

This replaces the three loose modes shipped in Projects step 5 (import,
mirror, push, see PLAN.md "Projects") with one model that has a clear answer
for every push, wherever it lands.

## What exists today

- GitHub only, through the `g1t-sh` App. `github_repos.mode` is one of
  `import | mirror | push` (integrations `0003_github.sql`).
- **Mirror** pulls on GitHub's push webhook and calls `mirror::copy` with
  `Prune::Yes`, which *overwrites* g1t's refs and deletes g1t-only branches.
  Anything pushed to g1t is silently lost at the next sync.
- **Push** ("Move to g1t") forwards each `git.push` to GitHub. A ref GitHub
  refuses ends up in `last_error`, and nothing reconciles it.
- Mirrored and imported refs publish `git.push` with no actor. They start
  `.g1t/workflows` like any push. They are written straight to the store, so
  they skip `workflow_gate`.
- `.github/workflows` is never read, except as a reusable `uses:` target.
- No provider port. `Endpoint::github` and `https://github.com/{full_name}.git`
  are hard-coded. `ProjectSource { kind: "mirror", provider }` is declared but
  unused.

The first three behaviours are the bugs this plan fixes. Pushes are lost
silently, divergence goes undetected, and anyone who can push to GitHub can
change a workflow that runs with g1t's secrets.

## The rule

**Every linked repository has exactly one leader at any moment. A write
reaches the leader first, or it doesn't land. The leader's word is final.**

Everything else follows from that rule:

- *Two-way sync* doesn't need its own mode. When g1t follows, a push to g1t is
  forwarded to the leader *before* g1t's ref moves (write-through). When g1t
  leads, a fast-forward push on the other side is adopted. Both sides accept
  pushes, and there is always a tie-breaker.
- *Conflicts* can only happen when the leader was unreachable and someone
  wrote anyway (failover), or when a follower took a write it couldn't
  forward. A conflict is never resolved by overwriting silently.
- *Echo loops* are impossible. When an update's new sha equals the tip
  already held, the update is a no-op. That covers a webhook announcing our
  own push and a chain of g1t instances alike.

## Words (UI and docs)

| State | Badge on the repository | Meaning |
| --- | --- | --- |
| No link | (none) | An ordinary g1t repository. *Import* is a one-time copy that leaves no link. |
| **Mirror** | `Mirror of github.com/acme/web` | The remote leads and g1t follows. Pushes to g1t are forwarded to the remote. |
| **Mirrored** | `Mirrored to github.com/acme/web` (+ more) | g1t leads and the remotes follow. A repository can have any number of these. |
| **Failover** | `Mirror of github.com/acme/web · Failover` (amber) | The leader is unreachable, so g1t is temporarily accepting writes. They are replayed when the leader returns. |
| **Reconciling** | `… · 2 branches diverged` (red) | Some branches moved on both sides and need a decision. Other branches keep syncing. |

A repository is a Mirror of **at most one** remote, and it can also be
Mirrored to others. Self-hosted g1t can be a Mirror of GitHub and Mirrored
to g1t.sh, for example. Creating a link that would make a cycle is refused.
For g1t-to-g1t links we can ask the other side for its leader chain.

The existing modes map as follows: `mirror` → Mirror, `push` → Mirrored,
`import` → no link.

## Pushes, case by case

### When g1t is a Mirror (the remote leads)

| Where the push happens | What happens |
| --- | --- |
| On the remote | The webhook arrives (or a poll runs when there is no webhook), g1t fetches, and the ref moves. A force-push by the leader is followed, because the leader may rewrite history. The old tip is kept at `refs/g1t/replaced/<branch>/<time>` for 30 days, and the change shows in the activity feed. Nothing is lost silently. |
| On g1t (person, agent, merge button, web edit) | **Write-through.** g1t receives the pack, pushes it to the leader with a compare-and-swap (expected old = our tip), and moves its own ref only when the leader accepts. If the leader refuses (branch protection, non-fast-forward, a hook), the push fails with the leader's own message passed through as `remote:` lines. Branch protection on the remote is enforced for free. |
| On g1t, branch only on g1t | There are no g1t-only branches on a Mirror. Every branch is forwarded. This removes the current `Prune::Yes` data loss: g1t never holds anything the leader doesn't. |
| On g1t, leader unreachable | Depends on the failover setting (below). The default refuses with: `acme/web is a mirror of github.com/acme/web, which isn't answering. Pushes resume when it's back, or turn on failover in Settings → Mirroring.` |

The cost is latency: a push to a Mirror takes as long as a push to the
remote plus our own write. That trade buys g1t's commits never diverging
while the leader is up. The 40 MB pack relay limit in `mirror.rs` applies to
forwarded pushes as well, and the error message has to say so.

### When g1t is Mirrored (g1t leads)

| Where the push happens | What happens |
| --- | --- |
| On g1t | It's g1t's normal push with all of g1t's rules. After it lands, a `git.push` event queues a forward to each follower (this exists today). A follower that refuses (its own protection, for example) marks that ref **stuck** on that remote and shows it on the repository. Retries back off and never force. |
| On the remote, fast-forward | **Default: adopt.** The webhook triggers a fetch, and the update goes through g1t's ref rules as if the pusher had pushed to g1t, with the pusher mapped to a g1t account (see Actors). If g1t's rules allow it, the ref moves and the update is forwarded to the other followers. If they refuse (a protected branch, say), the ref is marked **diverged**. |
| On the remote, not a fast-forward | Marked **diverged**. g1t never force-pushes over it without a person's or agent's decision. |

A setting covers pushes made directly on the remote:

- **Adopt fast-forwards** (default)
- **Overwrite them**: g1t force-pushes its tip and keeps the replaced
  remote tip under `refs/g1t/replaced/…`. This suits teams that consider the
  remote read-only.
- **Lock the remote**: g1t creates a ruleset on the GitHub repository that
  lets only the g1t App update refs. This needs `administration: write` on
  the App, which we request only when someone picks this option.

### Diverged branches

A diverged branch stops syncing and every other branch keeps going. Both
tips are kept: g1t's at the branch, and the other side's at
`refs/remotes/<remote>/<branch>`, which is browsable and diffable. The
repository shows `main diverged from github.com/acme/web: 3 commits here, 1
there` with three actions:

1. **Keep g1t's**, which force-pushes to the other side (the old tip is kept).
2. **Keep theirs**, which moves g1t's ref (the old tip is kept).
3. **Merge them**, which opens a pull request merging the other tip into the
   branch. One click hands it to @g1t, and it lands through the normal rules.

## Failover: GitHub is down, and I push on g1t

Failover is a *state* of a Mirror, not a separate mode. The setting
"When github.com/acme/web is unreachable" has three choices:

- **Stop accepting pushes** (default for new links)
- **Ask me**: a banner and an inbox item for repository admins offer
  **Start failover**.
- **Fail over automatically**

**Entering failover.** The leader is unreachable when forwarded writes fail
with a timeout, a connection error or a 5xx, *and* a health probe of
`info/refs` fails 3 times over 2 minutes. A provider status page alone isn't
enough, because they lag and over-report. While in failover:

- g1t accepts pushes, merges and agent work on every branch. Branch rules
  still apply: g1t imports a read-only copy of the remote's protection when
  the link is made, refreshes it on every sync, and enforces it during
  failover. "Main needs a reviewed pull request" still holds while GitHub is
  down.
- Each ref records its **base**, the last sha both sides agreed on.
- The repository wears the amber Failover badge with the duration and the
  count of commits waiting to go back.

**Leaving failover.** Once the probe succeeds 3 times over 5 minutes, each
branch changed during failover is replayed:

| Remote since base | g1t since base | Result |
| --- | --- | --- |
| unchanged | moved | Fast-forward push to the remote. |
| moved | unchanged | Fetch, as normal. |
| moved | moved, one contains the other | Fast-forward whichever side is behind. |
| moved | moved, split | **Diverged** (above). |
| (remote refuses: protected branch) | moved | **Replayed as a pull request on GitHub** from `g1t/failover/<branch>`, titled *Changes made on g1t while GitHub was unreachable*. g1t can't push straight to a protected main, and shouldn't. |

The repository goes back to a plain Mirror when nothing is diverged or
stuck. Until then it shows Reconciling. An admin can end failover by hand at
any time, and the replay runs the same way.

## Workflows

### Which files run on g1t

| Files | Default | Setting |
| --- | --- | --- |
| `.g1t/workflows` | Run on every push, whatever its origin | None needed. These are g1t's files: having them means you want them run. Workflows can filter on `g1t.event.origin` (`local` / `remote`). |
| `.github/workflows` | **Off** | **Run GitHub's workflows on g1t: Off · While GitHub Actions is down · Always.** |

This deliberately narrows the rule in `crates/actions/src/workflow.rs` ("g1t
never reads `.github`"). g1t reads `.github/workflows` only for repositories
linked to GitHub, and only when this setting is on. When both folders define
the same `name:`, `.g1t` wins.

### "While GitHub Actions is down"

This is the scenario from the request. The window opens when either of these
happens:

1. A pushed commit gets no check suite on GitHub within 10 minutes. This
   needs `checks: read` on the App and is the most reliable signal, because it
   means GitHub really didn't run it.
2. Someone with admin on the repository clicks **GitHub Actions is down: run
   here** on the repository or on a single commit. A per-commit **Run on g1t**
   button is always available, in any setting.

GitHub's status page is shown next to the banner for context. It never opens
or closes the window by itself.

The window closes once GitHub starts check suites again for new commits. Runs
already started on g1t finish.

While the window is open:

- Pushes and pull requests on g1t, **including failover pushes**, run the
  `.github` workflows that match.
- Commits pushed during the window that GitHub never ran are **backfilled**:
  g1t offers to run them in one click.
- Results go back to GitHub as check runs named `g1t / <workflow> /
  <job>` (needs `checks: write`). People on GitHub see them, and GitHub's
  required-check rules can name them if the team chooses.

**Deploys and other side effects.** A workflow running in two places can
deploy twice. In "While down" mode, jobs that declare an `environment:` or
use a secret named `*DEPLOY*`/`*TOKEN*` that only GitHub has are **held for
approval** by default. The setting is "Side-effect jobs in GitHub's
workflows: hold for approval (default) · run". In "Always" mode they run.
That mode is for teams that have moved CI to g1t and keep GitHub for code
review.

**Secrets.** GitHub won't give out secret values. When the setting is turned
on, g1t lists every `secrets.X` the `.github` workflows reference, ticks off
the ones already set on the project, and blocks "Always" until each is set
or marked "not needed". A run that hits a missing secret fails with
`NPM_TOKEN is set on GitHub but not on g1t: add it in Project → Secrets`.
It does not fail with an empty string.

**After GitHub returns.** Failover commits replayed to GitHub start GitHub's
own workflows there. That is expected, because GitHub's checks are what
GitHub's rules ask for. g1t's check runs for the same sha are already posted,
so reviewers see both. Deploy jobs held on g1t can be discarded once GitHub
has deployed.

### Workflow changes that arrive from a remote

Today a commit fetched from GitHub that edits `.g1t/workflows` runs with
g1t's secrets, and its author never needed `workflow_files: write` on g1t.
That gets fixed in step 1, before any of the rest:

- A fetched push that changes workflow files, or `.github/workflows` while
  that setting is on, runs only if the pusher maps to a g1t account with
  `workflow_files: write` on the repository.
- Otherwise its runs wait for approval: `Workflow changed on GitHub by
  @octo, who has no write access to workflows here. Approve run?` This is
  the same mechanism as runs from forks.

## Actors

GitHub's push webhook names the pusher, and `github_accounts` already links
GitHub users to g1t users. A fetched push is attributed to the linked g1t
account, or to `github:<login>` (shown greyed out, not a g1t user) when there
is none. Today such pushes have no actor. Webhooks, audit and the workflow
`actor` all get the attributed value.

## What works on a Mirror, and what's disabled

This table is also the source for the UI's disabled states. Every disabled
control uses the shadcn Tooltip with the reason and the setting that would
enable it.

| | Mirror (remote leads) | Mirror in Failover | Mirrored (g1t leads) |
| --- | --- | --- | --- |
| Browse, clone, fetch, blame, search | ✓ | ✓ | ✓ |
| Push branches and tags | ✓ forwarded to the remote | ✓ held, replayed later | ✓ |
| Branch protection | The remote's (read-only copy shown) | The remote's copy, enforced by g1t | g1t's |
| Pull requests | **The remote's.** Listed on g1t; *New pull request* and agents open them on the remote; *Merge* merges there through the API under its rules | g1t pull requests allowed. Each is replayed as a remote pull request when the remote returns | g1t's |
| Merge queue, required g1t checks | Disabled: "Merges happen on GitHub, which leads this repository." | ✓ on g1t's copy of the rules | ✓ |
| Issues, agents, plans | ✓ g1t's own. Agents push branches that are forwarded, and open pull requests on the remote | ✓ | ✓ |
| `.g1t/workflows` | ✓ | ✓ | ✓ |
| `.github/workflows` | Per setting | Per setting | Per setting (only if a follower is GitHub) |
| Projects, deployments, previews, secrets | ✓ (the on-ramp) | ✓ | ✓ |
| Releases | Read from the remote (later) | Held | g1t's, copied to followers (later) |
| Rename, transfer | g1t side only. The link stays | Same | Same |
| Delete branch, set default branch | Forwarded / read from the remote | Held | g1t's, forwarded |
| Archive | Stops syncing. The link is kept and paused | Not allowed | Stops forwarding |
| Unlink | Becomes an ordinary repository (choice: keep g1t-side failover commits) | Must reconcile first | Followers stop receiving |

Other places that must show the state, not only the badge:

- **Clone box:** `This is a mirror of github.com/acme/web. Pushes here are
  forwarded there.`
- **Push output:** `remote: forwarded to github.com/acme/web (412 ms)`, so
  people learn the model the first time they push.
- **Repository header:** the sync dot (`in sync · 40s ago`, `syncing`,
  `failover · 23m`, `2 diverged`, `stuck on gitlab.com/…`). It opens
  **Settings → Mirroring**, which lists every remote, each branch's state,
  the last 50 sync events and **Sync now**.
- **Workspace and project lists:** a small mirror glyph with the leader's
  host.

## The provider port

All of this lives behind one port, so GitLab, Bitbucket, plain git and other
g1t instances are each an adapter. The Rust trait lives in
`services/integrations`, because the connections live there:

```rust
trait Remote {
    fn kind(&self) -> RemoteKind;                        // github | g1t | gitlab | bitbucket | git
    fn capabilities(&self) -> Capabilities;              // webhooks, checks, lock, pull_requests, protection
    async fn endpoint(&self) -> Result<mirror::Endpoint>;// URL + fresh credential for mirror.rs
    async fn parse_event(&self, req: &Request) -> Result<Vec<RemoteRefChange>>; // verify + normalise
    async fn probe(&self) -> Health;                      // info/refs reachability
    async fn protection(&self) -> Result<Vec<RuleCopy>>;  // read the remote's branch rules
    async fn lock(&self, on: bool) -> Result<()>;         // optional
    async fn post_check(&self, sha: &str, run: &CheckRun) -> Result<()>; // optional
    async fn pull_requests(&self) -> Result<PullRequestPort>; // optional, step 7
}
```

- Each `Capabilities` flag that's off greys out the matching UI and setting.
  The UI never offers a lever the provider can't honour.
- Providers without webhooks (plain `git`, or a self-hosted g1t behind a
  firewall) get a **poll** every 1 to 10 minutes with backoff, using
  `ls-remote` and comparing tips. The poll uses the same code path as the
  webhook.
- **`g1t` adapter (self-hosted ↔ g1t.sh).** It authenticates with a
  fine-grained token on the other instance (`contents: write`,
  `webhooks: write`) and registers its own webhook there through our API.
  Because we control both ends, write-through works in either direction, and
  the cycle check can ask the other side for its chain. Issues and pull
  requests between g1t instances come later, over the public API.

## Data

**integrations, `remotes`** (replaces `github_repos`; existing rows are
migrated):
- `id`, `repo_id`, `workspace`, `kind`, `url`, `role` (`leader` |
  `follower`), and `connection_id` (installation or token row).
- `provider_ref`, provider-specific JSON (GitHub: `installation_id`,
  `github_repo_id`).
- `settings` JSON: on-unreachable, remote-push policy, `.github` workflows,
  side-effect jobs.
- `state` (`ok` | `failover` | `reconciling` | `paused` | `error`),
  `state_since`, `last_error`, `synced_at`.
- A unique index on `(repo_id) WHERE role = 'leader'` enforces at most one
  leader.

**repos, `ref_sync`** (per repository, inside the repository's store so it
moves atomically with refs):
- `remote_id`, `ref`, `base_sha` (last agreed), `remote_sha` (last seen
  there).
- `state` (`ok` | `ahead` | `behind` | `held` | `diverged` | `stuck`),
  `updated_at`.

**repos, repository row:** `mirror_of` (remote id or null), cached from
integrations through a `remote.updated` event. The git front door, commit
API and merge paths can then decide forward-or-refuse without an RPC.
`lifecycle::archived_refusal` is the template for a matching
`mirror::route(repo, ref)` used at the same call sites.

**contracts, `GitPush`** gains `origin: { kind: "local" | "remote",
remote_id?, provider?, pusher? }`. Actions, webhooks, audit and the inbox
read it. `ProjectSource`'s unused `mirror` variant is dropped: a Mirror is
still a hosted repository with a full copy, so its project stays `hosted`, as
PLAN.md already decided.

**Events:** `remote.linked`, `remote.updated`, `remote.unlinked`,
`remote.failover_started`, `remote.failover_ended`, `ref.diverged`,
`ref.reconciled`. These are in the public webhook catalogue, so people can
build alerts on them.

## Build order

1. **Safety and the port.** The `Remote` trait with the GitHub adapter. Move
   `github_repos` to `remotes`. Add `ref_sync` with base shas. Add `origin`
   and the attributed actor on `GitPush`. Echo suppression by sha. Keep
   replaced tips instead of overwriting silently. Approval for workflow
   changes arriving from a remote. Badge, sync dot, and **Settings →
   Mirroring** (read-only state).
2. **Write-through Mirror.** Forward pushes from the git front door, the
   commit API, merges and agents. Pass the leader's refusals through. Apply
   the disabled-feature table in the UI. Read-only copy of the remote's
   protection.
3. **Mirrored with remote pushes handled.** Adopt / overwrite / lock, stuck
   refs, diverged refs with the three resolutions.
4. **Failover.** Probe, ask/automatic, enforcement of the protection copy,
   replay with the table above, pull-request replay for protected branches.
5. **GitHub's workflows on g1t.** The three-way setting, the
   missing-check-suite signal, *Run on g1t*, backfill, check runs back to
   GitHub, held side-effect jobs, the secrets checklist.
6. **g1t ↔ g1t.** The `g1t` adapter, polling, the cycle check, docs for
   self-hosted ↔ g1t.sh.
7. **Remote pull requests on Mirrors.** List, open, merge through the API,
   agents opening theirs there (already "Not yet" in PLAN.md step 5).
8. **GitLab, Bitbucket, plain git** adapters.

Each step updates `guides/github.md` and a new `guides/mirroring.md` in the
same change (docs standard). `guides/github.md`'s "anything pushed to the
g1t copy directly is overwritten" goes away with step 1.

## Decisions to confirm

1. **Failover defaults to "Stop accepting pushes"** for new links, with
   "Ask me" one click away. Automatic failover is opt-in, because it creates
   work that has to be replayed.
2. **On a Mirror, pull requests live on the leader**, and g1t has no pull
   requests of its own there (except during failover). One place to merge
   avoids two review histories for one branch. Making g1t the leader is the
   way to get g1t's review and queue.
3. **App permissions are asked for when a feature needs them**:
   `checks: read/write` for step 5 and `administration: write` only for
   *Lock the remote*. They are not requested up front.
