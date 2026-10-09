# Mirroring: keeping remotes in sync

> **2026-10-08:** "bidirectional synchronization from GitHub or whatever
> providers … as well as setting up a different remote (think self-hosted g1t
> and mirroring to the hosted g1t.sh platform)". "GitHub is down, I want to
> run GitHub's workflows on g1t, but only until GitHub is back up. But what if
> I push on g1t?" "It needs to be highly clear when a repository is mirrored,
> and things are disabled." "When it's mirroring it's just mirroring … you
> can use g1t as a disaster recovery option intentionally." "We really don't
> want to force someone's hand." "When we've decided that we've moved the
> repository entirely to g1t and it's no longer a mirror … mention that we'll
> no longer track the remote."

The user-facing guide is `apps/docs/src/content/docs/guides/mirroring.md`.
This is the design record.

## The rule

**Every linked repository has exactly one leader. Work happens on the
leader; the others follow.** g1t is never a second place where people work
while the remote also leads, so there's nothing to merge back by surprise.
Every state is an answer to "who leads right now?":

| State | Leader | On g1t |
| --- | --- | --- |
| `standby` | remote | Exact, read-only copy. Runs nothing (optional: keep CI warm). |
| `ci` | remote (code) | The remote's workflows run on g1t; results stay on g1t for now. |
| `takeover` | g1t, for now | Everything works. Deploying workflows wait for approval. |
| `handing_back` | moving back | Read-only while refs move. |
| moved to g1t | g1t | Not a mirror. g1t no longer tracks the remote, or keeps it as a follower. |
| `following` / `stuck` | g1t | A follower remote, pushed to on every `git.push`. |

Outside a takeover, every commit on a mirror's branches is already on the
remote. So a standby mirror is safe to treat as a backup, and any
difference between the two is a bug.

## Decisions taken

1. **A mirror is a standby by default.** No issues, pull requests, agents,
   workflows or deployments, so mirroring is just mirroring. Settings,
   rules, webhooks and reported checks stay open.
2. **Detection shows; it doesn't act.** Hosts are probed every minute. A
   host is unreachable after 3 failures over at least 2 minutes, and back
   after 3 successes over at least 5. By default this only turns the
   repository's dot amber and offers **Take over**. Telling owners in the
   inbox, and taking over automatically after N minutes, are opt-in
   settings per link.
3. **Take over any time**, not only during a detected outage.
4. **Hand back is a reviewed plan**, ref by ref, against the commit each
   ref had when the takeover began:
   - `push`: only g1t moved.
   - `fetch`: only the remote moved.
   - `pull_request`: the remote protects the branch; the commits go to
     `g1t/handback/<branch>` and g1t follows the remote's branch.
   - `diverged`: both moved; a person decides keep ours, keep theirs or
     pull request.

   If anything is refused, g1t keeps the lead and says why. An automatic
   hand-back happens only for takeovers g1t started itself, and only when
   no ref has diverged.
5. **Nothing is lost silently.** When a pull would drop a commit (a
   force-push or deletion on the remote, or a keep-theirs decision), that
   commit is kept at `refs/g1t/replaced/<ref>/<ms>` for at least 30 days.
6. **CI failover is its own switch.** It runs `.github/workflows` as well
   as `.g1t/workflows`; g1t's wins a `name:`.
7. **Move to g1t** is permanent. The confirmation says g1t will no longer
   track the remote. Optionally the remote becomes a follower.
8. **Security.**
   - A push copied in that changes `.g1t/`, `.github/workflows/` or
     `.github/actions/` starts runs that wait for approval before they can
     use secrets.
   - Agents never move a repository to g1t, nor add, change or remove a
     remote.

## Where it lives

- **`crates/contracts/src/mirrors.rs`** (and `packages/contracts/src/mirrors.ts`):
  - the model: `MirrorState`, `RepoMirror` on `Repo`, `Remote`,
    `MirrorSettings`;
  - the hand-back logic: `ref_action` and `HandbackPlan`;
  - `MirrorEvent`.
- **repos** (`src/mirror.rs`, migration 0017 `repos.mirror`):
  - `set_mirror`;
  - `mirror`, which now also keeps replaced commits and announces pushes
    as `mirrored`;
  - `mirror_refs`, which returns g1t's side alone when there is no URL;
  - `mirror_apply`, which moves named refs with a compare-and-swap;
  - `read_only_refusal` at every write path: the git front door, the
    commit API, merges, catch-up, releases and pull-request copies.
- **integrations** (`src/remotes.rs`, migration 0006 `remotes`,
  `remote_refs`, `remote_hosts`; cron every minute; `EVENTS` binding):
  - the links;
  - the provider adapters: `github` through the App, `g1t` and `git` with
    a sealed token, and polling every 5 minutes for hosts without webhooks;
  - takeover, CI, hand-back, move-in, health and the automatic levers.
  - `github_repos` mirror and push rows became remotes in the migration;
    the GitHub webhook's pushes go to remotes.
- **work**: `retired::writable` refuses on a read-only mirror;
  `not_archived` is kept for settings, rulesets and commit checks.
- **actions** (`src/mirrored.rs`): what runs per state, `.github` reading,
  holding deploys, approval for copied workflow changes.
- **deployments**: production deploys only while g1t leads.
- **events**: `mirror.*` in the inbox (only the people named in `notify`)
  and in the webhook catalogue.
- **api** (`src/mirrors.rs`):
  - REST under `/repos/{owner}/{name}/mirror…`;
  - MCP `mirror_*` actions on the `repository` tool;
  - scopes: `repo:read` to read, `code:write` to sync, `repo:admin` for
    everything else.
- **web**: the badge, banner, disabled states, clone note and
  **Settings → Mirroring**.

## Not yet

- **Check runs posted back to GitHub** during CI failover. Needs
  `checks: write` on the App.
- **Starting CI failover automatically** when GitHub starts no check suite
  for a pushed commit. Needs `checks: read`.
- **Copying GitHub's branch protection** into g1t during a takeover. Today
  a takeover runs under g1t's own rules.
- **Locking the remote** with a ruleset so only g1t pushes. Needs
  `administration: write`.
- **GitHub's pull requests read into a mirror**, and agents opening theirs
  there.
- **A working mirror** (write-through while GitHub leads). Deliberately
  left out; it could come back as one toggle on a standby mirror.
- **GitLab and Bitbucket adapters**: one arm each in `remotes.rs`
  (`credential`, `protected`, `open_pull_request`), plus a webhook route.
- **Taking in fast-forwards on a follower** skips g1t's branch rules on the
  copied push. A follower's pushes are already gated by the remote's own
  rules.
