# Performance

How g1t.sh answers a page: where the code runs, where the data lives, how
reads and writes travel, what is cached, and the budget pages are held to.
Internal. The tools: `scripts/perf/measure.ps1` (time pages from your
machine), `scripts/perf/placement-probe.mjs` (measure placements without
touching production), and the Server-Timing header on every page.

## The shape of a request

```
browser ──► Cloudflare edge (nearest data centre)
              │
              ▼
           g1t (apps/web, React Router)      root loader + layout + page loaders, in parallel
              │  service bindings: POST /rpc/<method>, JSON
              ▼
           g1t-identity, g1t-repos, g1t-work, g1t-projects, g1t-billing, …   (services/*)
              │
              ▼
           D1 (one SQLite database per service; primary in WNAM, US West)
           Artifacts (git objects and refs, for g1t-repos)
```

- **The site holds no data.** Every loader calls services; every service
  owns one D1 database. A page is a few rounds of service calls; each call
  is a few D1 queries.
- **Latency is round trips times distance.** A query from a Worker next to
  its database takes 1 to 5 ms. The same query from Amsterdam to WNAM took
  about 150 ms. A page with three rounds of calls, each with two or three
  queries in turn, costs about a second and a half when the code and the
  data are on different continents. That was the slowness.

## Where the code runs

| Worker | Placement | Why |
| --- | --- | --- |
| `g1t` (site), `g1t-api`, `g1t-sudo` | `off` | Run next to the person. With D1 replicas (below), most reads are local too. |
| identity, repos, work, search, billing, projects, deployments | `off` | They read with D1 sessions: the nearest replica, or the primary when consistency needs it. |
| actions, events, webhooks, integrations, context, security | `off` now; a region near WNAM once the probe has picked one | They read the primary only. Pinned beside it, a page from Europe pays one ocean crossing per call instead of one per query. |
| pages, models, og, runner, status, docs | none | Edge-serving or no data of their own. |

### What happened with Smart Placement

Every data-holding Worker and the site had `"placement": { "mode": "smart" }`.
Production answered with `cf-placement: remote-AMS` for a visitor in Denver:
the site ran in Amsterdam, and so did the services it called through
bindings (a binding runs the callee where the caller is unless the callee
is placed). Every D1 query then crossed the Atlantic. Smart Placement only
considers locations where the Worker has already run and needs traffic
from many places to decide, so it settled on a poor spot and stayed there.
Measured from Colorado, signed out, warm:

| Page | Smart (AMS) | Off |
| --- | --- | --- |
| `/` | 270 ms | 140 ms |
| `/explore` | 850 ms | 170 ms |
| `/flagon-io/g1t/pulls` | 600 ms | 220 ms |
| `/flagon-io/g1t/issues` | 780 ms | 230 ms |
| `/pricing` | 500 ms | 120 ms |
| `/flagon-io/g1t` (overview) | 1.4 s | 1.67 s (its own problem, below) |

Placement now applies only to `fetch` handlers; the services are reached
through `fetch` (`/rpc/<method>`), so it applies to them.

### Choosing a region (the probe)

Cloudflare's placement hints (`"placement": { "region": "aws:us-west-1" }`,
GCP and Azure regions too, Wrangler 4.146 accepts them) run a Worker next
to a cloud region. D1 is not a cloud region, and Cloudflare does not say
which city WNAM is, so measure:

```powershell
node scripts/perf/placement-probe.mjs deploy    # g1t-probe-* on workers.dev, SELECT 1 against g1t-repos
node scripts/perf/placement-probe.mjs measure   # a table: where each ran, ms per D1 query, through a binding too
node scripts/perf/placement-probe.mjs delete
```

Pick the region with the lowest **D1 primary ms/query**. To pin the
primary-only services there, edit their configs (or use
`node scripts/perf/placement-probe.mjs apply '{"region":"<it>"}'`, which
sets every config it lists, then put `"mode": "off"` back on the site, API,
sudo and the session services). `apply '{"mode":"off"}'` is what the
working tree has now.

## Where the data lives, and how reads travel

Every database's primary is in WNAM. D1 read replication puts read-only
copies in every region (ENAM, WNAM, WEUR, EEUR, APAC, OC) at no extra
cost. A copy trails the primary, so reading one needs care.

### Sessions and bookmarks

Seven services read through D1's Sessions API when asked
(`crates/kit/src/d1.rs`, `packages/contracts/src/d1.ts`). The caller asks
with the `x-d1-bookmark` request header:

| Header | Reads go to |
| --- | --- |
| absent | the primary, with no session: exactly as before |
| `first-primary` | the primary, then any copy at least as new |
| `first-unconstrained` | the nearest copy |
| a bookmark | any copy at least as new as the bookmark |

Writes always go to the primary. A session is sequentially consistent: it
reads its own writes. The service returns the session's latest bookmark
in `x-d1-bookmark`.

**Only the site asks for anything.** Service-to-service calls
(`g1t_kit::call`), queues, crons, the API and MCP send no header, so they
read the primary as they always did. Billing's `can_start`/`start_run`,
credential checks for git, and everything agents do stay on the primary.

The site decides per call (`apps/web/app/lib/perf.ts`, `sessionFor`):

1. A request that writes (any method but GET and HEAD) starts every session
   on the primary, so what an action checks before writing is current.
2. Within 30 seconds of the person's last write, every service reads its
   primary. A write can reach a service the site did not call (work
   writing to repos during a merge) whose bookmark the site never sees;
   replicas trail by well under a second, so 30 seconds is a wide margin.
3. Otherwise, the bookmark that service returned after the last write.
4. Otherwise, the nearest copy.

After a request that may have written, the site sets the `g1t_d1` cookie:
`at:<unix seconds>` and `service:<bookmark>` pairs, HttpOnly, five minutes.
"May have written" is: a non-GET request; a GET that called a method not
on the known-read list (`READS` in `perf.ts`; anything new counts as a
write until listed); or a GET that started a session (signing in with
GitHub). GETs that only read set no cookie, so public pages stay cacheable.

Keep `READS` complete. Until 2026-10-06 it lacked `get` (repos and
projects), `list`, `queue` and `pulls_for_repos`, so every project page
and Mission control looked like a write: each set the cookie, which kept
signed-out project pages out of the public cache (every view rendered,
0.4 to 0.6 s, crawlers included), sent the person's next 30 seconds of
reads to the primary, and turned off the sidebar cache
(`mustReadFresh`). `scripts/perf/measure.ps1` shows a **Sets g1t_d1**
column: it should say False for every page it measures.

What a person can still see out of date: something someone else (or an
agent, or the API) changed in the last fraction of a second, which a page
would have missed by loading a moment earlier anyway; and a session
revoked from another device working for that same fraction of a second
on reads (sign-out from this browser is a write, so it is immediate).

### Turning replication on

Not on yet: the code above works the same without it (every read is then
the primary). Turn it on per database once the site and the seven services
are deployed with sessions. There is no Wrangler command; use the
dashboard (**D1 → database → Settings → Read replication → Enable**) or
the API with a token that has D1 Edit:

```powershell
$token = $env:CLOUDFLARE_D1_TOKEN   # D1: Edit on account syntaqx
$account = "1e6f2cffa3f445920836e8ebe446bb58"
$databases = @{
  "g1t"             = "b7d49c93-2666-4006-a3c3-073a01838dc9"   # identity
  "g1t-repos"       = "f9544c51-c3bf-4621-a96f-8a6d5cf24a97"
  "g1t-work"        = "f35a9022-e36b-4547-b596-9ab9d5f1c47a"
  "g1t-projects"    = "0af698be-2b60-4bd9-aa93-81e84828e991"
  "g1t-deployments" = "aa935a8f-845b-4132-8fa3-98f1afba1db5"
  "g1t-search"      = "9d04cbf3-cd02-4544-b3e3-2d78767e13bf"
  "g1t-billing"     = "695a6979-fd07-4850-bc97-904a6b4b7a04"
}
foreach ($name in $databases.Keys) {
  curl.exe -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$account/d1/database/$($databases[$name])" `
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" `
    --data '{\"read_replication\":{\"mode\":\"auto\"}}'
  Write-Host ""
}
npx wrangler d1 info g1t-repos   # read_replication: { mode: "auto" }
```

Turning it off is `{"read_replication":{"mode":"disabled"}}` and takes up
to a day to finish. Read-heavy over the last 24 hours: g1t-repos (60,103
reads to 111 writes), g1t-work (43,219 / 1,462), g1t-projects (28,861 /
22), g1t-billing (20,600 / 507), g1t (5,434 / 202). g1t-search writes more
than it reads (indexing), so replicas help it least.

## Caching

| What | Where | For how long | Rules |
| --- | --- | --- | --- |
| Static assets (`/assets/*`) | browser and edge | a year, immutable | hashed file names |
| Avatars | edge cache | a year, immutable | by content hash |
| Public pages for people signed out | the data centre's cache (`workers/app.ts`, `servePublic`) | fresh 30 s, then served once more while a new copy is made, up to 5 min | GET, no `g1t_session` cookie, an allowlisted path (home, pricing, explore, policies, a project's pages), status 200 or 404, no `Set-Cookie`, nothing private. Reserved first segments and workspace pages (`-`) are never kept. A project's kept page is served only after repos' `visibility` says the repository is still there and public (one indexed read, alongside the cache lookup); a repository made private or deleted is never served from any data centre's copy, and the copy is dropped. Visitors from the EU, EEA, UK and Switzerland, whose page asks about the analytics cookie, get a copy of their own (the cache key gains `_g1t_consent=1`, `lib/analytics-consent.ts`). The answer says `server-timing: cache;desc="hit, Ns old"`. |
| Sidebar data (projects, spend, limit, entitlements) | per isolate (`lib/cache.server.ts`) | 15 s, per person and workspace | skipped during a write and for 30 s after the person's last one; failures not kept; only settled answers kept |
| Registration mode | per isolate | 60 s | |
| A commit's log by hash | repos' data-centre cache | for good | history from a commit never changes. One of 100 commits or more is put together from a 16-commit read and the history kept from any of those commits, when there is one (`store.rs` `spliced_log`): a default branch that moved by a merge costs 16 commits, not 120 or 1,000 |
| A branch's drift from the default branch (Active branches) | repos' data-centre cache (`branch_drift`) | a count for good; "too far to count" a day | by repository and the pair of head commits (key version `v2`); a failed read is not kept |
| A repository's tags | repos' data-centre cache | until the refs move, 5 min at most | as the branch list; not kept when a tag's commit could not be read |
| Git objects, trees, refs | repos' caches | see services/repos | |
| A branch's log, the branch list, a file by branch and path | repos' data-centre cache | until the repository's refs change (`refs_version`), 5 min at most | only while no handed-out push credential is live; by commit hash for good (docs/ARTIFACTS.md R9) |
| A target branch's history, for mergeability | the repos isolate | 60 s, per target head | 100 pull requests checked after a push walk it once (R10) |
| Git store credentials | repos isolate and KV | reused 50 min (1 h tokens); 3 min for ones handed out | (R3) |
| A file's highlighted lines (blob, blame) | the site's isolate (about 8 MB), then the data centre's cache (`content.g1t.internal/highlight-lines/`) | for good (30 days in the data centre) | by SHA-256 of the language and the text, nothing else: the same text on any branch, commit or page is one entry. `HIGHLIGHT_VERSION` in `lib/highlight.server.ts` is in the key; bump it when the theme, grammars, Shiki or `linesToHtml` change. Nothing kept for a file without a language or over 200,000 characters |
| A pull request's first highlighted files | as above (`highlight-diff/`, about 4 MB per isolate) | for good | by the language and each line's side and text (`diffContent` in `lib/diff.ts`); line numbers and the path are not in it |
| Parsed markdown | the isolate, or the browser tab (400,000 characters of source, about 8 MB) | until pushed out | by the text and the repository its references point into (`components/markdown.tsx`); the tree is rendered with the page's components each time |
| React Router's route tables | the isolate | its life | the build is loaded once and the handler made once (`workers/app.ts`); development still reloads it per request |

## Server-Timing

Every page and `.data` response from the site carries a `Server-Timing`
header (DevTools → Network → the request → Timing):

```
total;dur=180;desc="web to first byte",
loader.root;dur=40, loader.repo.layout;dur=60, loader.repo.pull;dur=150,
rpc;dur=140;desc="9 service calls, overlap counted once",
work;dur=120;desc="4 calls, 70ms inside", repos;dur=30;desc="2 calls, 12ms inside", …,
d1;desc="work=unconstrained repos=bookmark identity=primary"
```

- `total`: from the request reaching the site to the response headers.
  Streamed panels finish after it.
- `loader.<route>` / `action.<route>`: each route's loader or action
  (React Router instrumentation in `app/entry.server.tsx`).
- `rpc`: time waiting on services, overlapping calls counted once.
- One entry per service: summed wall time of its calls from the site,
  and how much of that the service itself reported (`svc;dur` from
  `Served::finish`). The difference is the trip between them.
- `d1`: how each session-capable service was asked to read.
- Inside a service entry, `db Nms in T round trips`: what the service
  reported waiting on its own database (`db;dur`, from
  `g1t_kit::d1::Timing` and `Served::finish_timed`). The work service
  reports it, and `rpc;dur` for its own calls to other services; a service
  call's own response carries both beside `svc;dur`.

Git requests keep their own header (`repos;dur` plus the repos service's
steps). Counting git operations writes nothing on the way: the meters are
written after the answer (`wait_until`), so `kept` no longer includes a D1
upsert (63–98 ms before; docs/ARTIFACTS.md R13). Mission control keeps its per-section timings.

## What a page does, in rounds

Rounds are what cost: calls in the same round overlap.

| Page | Before | Now |
| --- | --- | --- |
| Any in-app navigation | root (sidebar: 6 calls, then up to 20 `get_by_id` for shared repositories) and the project layout re-ran when moving between pages of a project | root re-runs only when the workspace or project changes, or after a form; the project layout likewise; shared repositories are one `readable` call, in the same round; the sidebar's workspace data is cached for 15 s; open counts are read once per request for both |
| Pull request ("Review and respond") | access, then 8 calls, then checks' runs / comparison / session, then up to 5 more deployments lookups for stacked previews | one round of 9 (access-dependent ones start as soon as the repository lookup returns), then the comparison on Changes; the workflow jobs and stacked previews stream in |
| Project overview | access, then 17 calls, one of which (Active branches) read the default branch's last 120 commits and up to 10 branches' last 40 | one round; Active branches streams in with a skeleton, in one `branch_drift` call (below) |
| Mission control | per project: open pulls, closed pulls and events (3 × up to 10), then `get_by_id` per unknown repository | one `pulls_for_repos` call for every project (one access check, one query), events per project alongside, one `readable` for the rest |
| Issue, issues | access, then the rest | one round |

### Inside the work service

Before 2026-10-06 a pull request's page cost the work service about
twenty D1 round trips one after another, plus two calls to repos: the
access check (`get`), then the pull request, its issue, then its
lifecycle read progress, latest review, settings, statuses, review
comments, the confidence signals (three in turn), approvals, requests
for changes, the queue entry, and wrote the stage back on every view,
then statuses and settings again, messages and earlier checks. It also
asked repos `behind` on every view, which walks up to `MAX_ANCESTRY`
commits in Artifacts. About 350 ms of the page's 0.5 s.

Now (`services/work/src/prefetch.rs`):

- **One batch.** Everything the page and the lifecycle read is one D1
  batch of 20 statements keyed by repository id and number (subqueries
  find the pull request's id, issue and head). The helpers that decide
  the lifecycle (`settings`, `statuses`, `review_pending`,
  `approvals_gap`, `signals`, …) read from it when it is there, so the
  decision is the same code either way.
- **Beside the access check.** `repo_then` starts the batch with the
  repository id this isolate last saw for the path, at the same time as
  repos' `get`; the rows are used only if `get` then allows that same
  repository, and read again otherwise. Issues, lists, counts, labels and
  settings do the same. `pulls_for_repos` reads its rows beside
  `readable` and drops those of repositories the viewer cannot read.
- **Precomputed `behind`.** `pulls.behind` is written with mergeability
  on every push to either side (migration 0023); a view reads it when it
  was worked out for the current head and asks repos only otherwise
  (then keeps the answer).
- **No write on a view** unless the stage changed.
- `list_active_pulls` reads its pull requests' issues in the same batch
  instead of one query each.

A pull request is now the repos `get` (about 40 ms) and one batch beside
it. The indexes were checked with `EXPLAIN QUERY PLAN` against the
migrations: every statement is an index search; 0023 adds
`agent_messages_by_sender` for the unanswered-questions count.

### The overview streams

`routes/repo/overview.tsx` returns its seventeen calls as one deferred
promise. The layout's header and tabs (repository and project, two
cheap calls) and a skeleton go out first; the sections follow in the
same response. Crawlers still get the whole page (`entry.server.tsx`
waits for `allReady` for bots), and signed out it is kept in the public
cache like any other project page.

### Active branches (2026-10-08)

Measured on production, `/flagon-io/g1t` uncached, as a crawler, soon
after pushes: **3,606 ms** to the first byte, `rpc` 3,605 ms over 38
service calls, **repos 25 calls, 17,953 ms inside**. Nearly all of it was
Active branches:

- The site measured each branch itself: a `log` call per branch per
  depth (40, then 1,000), plus the default branch's (120, then 1,000), plus
  one more for the default branch's head, each call with its own access
  check and store handle. The answer was kept by the pair of heads in the
  site's cache, so every push to a branch, and every merge to the default
  branch (which changes every pair), started the walks again, in every
  data centre.
- A branch far from the default branch read 1,000 commits of both, and
  the default branch's 1,000 again after each merge.
- The page waits 3.5 s for the section, then shows a link to Branches.
  The walks were not in `waitUntil`, so when the page stopped waiting
  they were dropped with it: an answer that took longer than 3.5 s was
  never kept, and the next view started over. 3,606 ms is that timeout.

Now:

- **One call.** `branch_drift` (services/repos/src/drift.rs) takes the
  default branch's head and every branch head, checks access once, opens
  the store once, and reads the default branch's last 120 commits once
  for all of them. Each count is kept in repos' data-centre cache by the
  pair of hashes; only pairs that changed are walked. It also returns the
  default branch's head commit, which the site read with its own call.
- **Only what the count needs.** The walk goes newest commit first from
  both heads, as `git rev-list --left-right --count` does, and stops once
  everything left is reached by both. The store lists first parents only,
  so a merge's other parent is read on its own (16 commits, by hash, kept
  for good) when the walk reaches it; a branch a few commits from the
  default branch costs one read of its own. Past 128 reads or 4,000
  commits there is no count, and that answer is kept a day, not for good.
- **Fixed 2026-10-09: counts never showed.** The first version (and the
  site's before it) gave up when a commit on one side only had a parent
  not read, which every merge on the default branch has, and kept "no
  count" for good: no branch of flagon-io/hello or flagon-io/g1t showed
  counts. The cache key moved to `drift.g1t.internal/v2/`, so those
  answers are not read again.
- **Long histories spliced.** A log by hash of 100 commits or more is a
  16-commit read plus the log kept from one of those commits (the
  first-parent chain from a commit never changes), so the default branch
  after a merge costs 16 commits instead of 120 or 1,000. A kept log is
  used only when it starts at that commit and goes on to the one the
  16-commit read lists next (`splice_first`), so the join neither repeats
  nor skips a commit.
- **Finished after the page.** The call runs in `waitUntil`, so repos
  keeps the answer even when the page stopped waiting for it.
- **Crawlers wait 0.7 s** for the section (browsers 3.5 s, streamed);
  past that they get the link to Branches, as a slow browser does.
- `tags` is kept until the refs move (it listed the refs from the store
  on every call), and the project is looked up once per request for the
  layout and the overview (`projectFor`, beside `repoFor`).
- `tags`, `commit_checks`, `shortcuts` and the Files page's reads were
  missing from `READS`, so every signed-in overview counted as a write:
  it set `g1t_d1`, sent the next 30 seconds of reads to the primary and
  turned off the sidebar cache.

| Overview, signed out, uncached | Before | After |
| --- | --- | --- |
| repos calls | 25 (6 when nothing had moved) | 6 whatever moved: `get`, `stars`, `branches`, `log`, `tags`, `branch_drift` |
| projects calls | 3 (`get` twice) | 2 |
| Crawler, after a push | 3,606 ms (the 3.5 s timeout) | at most about 0.8 s: the rest of the page, or 0.7 s for Active branches |
| Crawler, nothing moved | 460 to 570 ms | not yet measured on production |
| Browser, first byte | 115 to 160 ms (`total`), 200 to 245 ms measured from Colorado | unchanged: the page does not wait for any of this |

## CPU per page (2026-10-09)

Workers bill CPU time past 30 million ms a cycle. From 1 to 9 October the
site (`g1t`) used 83.3 million CPU-ms over 1.93 million requests, about 43
ms a request and seven tenths of all g1t's Workers CPU; `g1t-repos` used
28.3 million over 6.58 million (about 4 ms). Signed-out pages are kept
for 30 s (above), but a crawler reads each file once, so most of its
requests render.

### Measuring it

`Server-Timing` cannot show CPU: a Worker's clock does not move while it
computes, so `total;dur=0` on a page that rendered for 20 ms is normal.
Measure locally instead, with the built site and fake services:

1. `npm run build -w apps/web`.
2. Load `build/server/index.js` in Node with `cloudflare:workers` pointed
   at a stub whose `env` has a service binding per service, answering
   `POST /rpc/<method>` from fixtures. A page's `.data` (fetched signed
   out from production) decoded with React Router's turbo-stream decoder
   gives realistic answers; files and READMEs can come from the working
   tree.
3. Call the worker's `fetch` with a crawler's user agent (the whole page
   renders before the answer) and read `process.cpuUsage()` over 100
   requests after a few to warm up. Run Node with `--single-threaded` so
   garbage collection and compilation count on the one thread, as in a
   Worker; on Windows `cpuUsage` moves in 15.6 ms steps, so divide a long
   run, never time one request.
4. `node --cpu-prof` on the same loop says where it goes.

### Where it went

Profiled with fixtures from flagon-io/g1t:

| Page | CPU a request | Where |
| --- | --- | --- |
| A 130-line TypeScript file | 30 ms | 63% highlighting (Shiki's tokenizer), 17% rendering |
| A 1,800-line TSX file (2.4 MB page) | 250 ms | 85% highlighting; the rest rendering and encoding the page |
| The Files page with a README | 32 ms | 46% parsing the README (remark, rehype-raw, sanitize, the plugins) |
| Any page | 1 to 1.5 ms more | React Router rebuilt its route tables for every request: given the build as a function, it wraps every route for the timings and flattens and ranks the route table again each time |
| `package-lock.json` (3.8 MB page, too large to highlight) | 170 ms | rendering one row per line and the file again in the page's data |

The CSP nonce, `isbot`, Server-Timing bookkeeping and the signed-out
cache's own work were each under 1% of a page's CPU in the profiles.

### What changed

- **Highlighting is kept by content** (`lib/highlight.server.ts`,
  `lib/content-cache.ts`): the isolate first, then the data centre's
  cache, then Shiki. The key is a SHA-256 of the language and the text,
  with a version, so a file that is the same on another branch or commit,
  in blame, or for the next crawler is highlighted once per data centre.
  A pull request's first files are kept the same way.
- **Markdown is parsed once per text** (`lib/markdown-tree.ts`,
  `components/markdown.tsx`): the steps `react-markdown` runs on every
  render are split, and the parsed tree is kept per isolate (and per
  browser tab). `lib/markdown-tree.test.ts` renders README.md, this file
  and a set of edge cases (raw HTML, scripts, `javascript:` links, alerts,
  references) both ways and checks the HTML is identical.
- **The request handler is made once per isolate** (`workers/app.ts`).
- Shiki's module is asked for once per isolate, not on every highlight.

### Measured

Locally, CPU a request, median of three runs of 100 requests, signed out
as a crawler. "Seen" is a file or README this isolate (or data centre)
has highlighted or parsed before; "new" is one it has not.

| Page | Before | After, seen | After, new |
| --- | --- | --- | --- |
| `/` (landing) | 12.7 ms | 10.6 ms | 10.6 ms |
| `/pricing` | 4.8 ms | 3.3 ms | 3.3 ms |
| Files, root with README.md | 30.8 ms | 9.5 ms | 23.7 ms |
| Files, `docs/` (a 30,000-character README) | 44.7 ms | 8.9 ms | 33.1 ms |
| Files, no README | 9.2 ms | 7.2 ms | 6.9 ms |
| A 130-line TypeScript file | 27.3 ms | 7.8 ms | 24.5 ms |
| A 1,800-line TSX file | 255.6 ms | 41.3 ms | 246.7 ms |
| A 560-line Rust file | 34.7 ms | 14.8 ms | 30.0 ms |
| A markdown file's source | 18.4 ms | 11.6 ms | 18.8 ms |
| `package-lock.json` | 200.2 ms | 134.1 ms | 127.8 ms |

A pull request's first screens: a 288-line diff took 18.8 ms to
highlight and 0.15 ms to read back from the data centre's cache. Hashing
the text for the key is part of every "new" figure above. Small
differences (a few ms) are within the noise of these runs; the large
saving on `package-lock.json`, which nothing here caches, is partly that
noise and partly less garbage per request.

What is left on large files is rendering: a row per line, and the same
lines again in the page's data for hydration. Files over 200,000
characters (lock files) are not highlighted and still cost about 130 ms
for a crawler.

## Client navigation

- `<Link prefetch="intent">` on the sidebar, project tabs, breadcrumbs,
  list rows and Mission control rows: hovering loads the next page's code
  and data.
- A thin progress bar while a navigation is pending (`Progress` in
  `components/shell.tsx`).
- Mission control's code loads while the browser is idle after the app
  shell paints; its skeleton is rarely seen.
- Mission control's quick actions show as done when sent and undo on
  failure.
- Skeletons (`components/ui/skeleton.tsx`: `Skeleton`, `SkeletonText`,
  `SkeletonRows`) stand in, at the same size, wherever something arrives
  after the page: the account menu's name, address and invites (now also
  fetched when the pointer reaches the button), Active branches, the
  statement's next entries, the command palette's results, blame's "why".

## Static assets

Hashed, immutable, a year. Signed in, the first page loads about 120 KB of
JavaScript gzipped for React and the router, plus the page's own (the pull
request page about 240 KB in all, most of it the markdown renderer and
shared components); later pages load only what they add, usually on hover.
Shiki's grammars load only when code is highlighted, on the server too
(`lib/highlight.server.ts`), so a Worker starting up no longer evaluates
them.

## Budget

| | Target (from the US) |
| --- | --- |
| Public page, signed out (cached) | p50 time to first byte under 200 ms |
| Signed-in page | p50 under 400 ms to first byte |
| In-app navigation | under 300 ms until the new page shows (data prefetched on hover) |
| Streamed panels | within 1 s |

The status page's **Page speed** part checks a public project page and
Explore every minute, timed to the first byte (the answer's headers), and
shows them as degraded over 800 ms (`apps/status/src/components.ts`,
`SPEED_BUDGET_MS`). It asks as a browser does: a crawler's user agent makes
the site render the whole page before the first byte (`isbot` in
`apps/web/app/entry.server.tsx`), so the check sends a browser's user
agent ending in `g1t-status/1.0 (+status.g1t.sh)`, which isbot reads as a
browser (`apps/status/src/probe.ts`, `BROWSER_USER_AGENT`; the sign-in page
of **Website and sign-in** is loaded the same way). A slow answer is asked
again at once and counts only if the second is slow too, at the faster of
the two times; every check is kept for 7 days with the data centre it ran
from, and sudo's incident page charts them.

## Measuring

```powershell
# Signed out, as a browser (streamed). Without -BrowserUA curl's own
# user agent counts as a crawler, which waits for the whole page.
powershell -File scripts/perf/measure.ps1 -BrowserUA -Runs 7 -Out before.csv
# Signed in: your g1t_session cookie's value, from DevTools; never printed
$env:G1T_SESSION = "<64 hex>"
powershell -File scripts/perf/measure.ps1 -Runs 7 -Pull 12 -Issue 11 -Out before-signed-in.csv
```

It prints p50 and p90 of the server's share (TLS handshake done to first
byte), where the Worker ran, whether the answer set `g1t_d1` (it should
not, for a page that only reads), and the slowest Server-Timing entries.

Signed out, a public page is usually answered from the data centre's
cache (`server-timing: cache;desc="hit, …"`), and `cache-control:
no-cache` does not change that. To time a render, add a query string the
page ignores: the cache is keyed by the whole URL, so
`/flagon-io/g1t?nc=<random>` is always a miss. A crawler's user agent
(`Googlebot/2.1`) waits for the whole page; a browser's gets the first
byte and the streamed rest.
