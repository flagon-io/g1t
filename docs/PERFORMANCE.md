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
| Public pages for people signed out | the data centre's cache (`workers/app.ts`, `servePublic`) | fresh 30 s, then served once more while a new copy is made, up to 5 min | GET, no `g1t_session` cookie, an allowlisted path (home, pricing, explore, policies, a project's pages), status 200 or 404, no `Set-Cookie`, nothing private. Reserved first segments and workspace pages (`-`) are never kept. The answer says `server-timing: cache;desc="hit, Ns old"`. |
| Sidebar data (projects, spend, limit, entitlements) | per isolate (`lib/cache.server.ts`) | 15 s, per person and workspace | skipped during a write and for 30 s after the person's last one; failures not kept; only settled answers kept |
| Registration mode | per isolate | 60 s | |
| A commit's log by hash | repos' data-centre cache | for good | history from a commit never changes; Active branches asks by hash |
| Git objects, trees, refs | repos' caches | see services/repos | |

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

Git requests keep their own header (`repos;dur` plus the repos service's
steps). Mission control keeps its per-section timings.

## What a page does, in rounds

Rounds are what cost: calls in the same round overlap.

| Page | Before | Now |
| --- | --- | --- |
| Any in-app navigation | root (sidebar: 6 calls, then up to 20 `get_by_id` for shared repositories) and the project layout re-ran when moving between pages of a project | root re-runs only when the workspace or project changes, or after a form; the project layout likewise; shared repositories are one `readable` call, in the same round; the sidebar's workspace data is cached for 15 s; open counts are read once per request for both |
| Pull request ("Review and respond") | access, then 8 calls, then checks' runs / comparison / session, then up to 5 more deployments lookups for stacked previews | one round of 9 (access-dependent ones start as soon as the repository lookup returns), then the comparison on Changes; the workflow jobs and stacked previews stream in |
| Project overview | access, then 17 calls, one of which (Active branches) read the default branch's last 120 commits and up to 10 branches' last 40 | one round; Active branches streams in with a skeleton, reading logs by commit hash so a branch that has not moved costs nothing |
| Mission control | per project: open pulls, closed pulls and events (3 × up to 10), then `get_by_id` per unknown repository | one `pulls_for_repos` call for every project (one access check, one query), events per project alongside, one `readable` for the rest |
| Issue, issues | access, then the rest | one round |

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
Explore every minute and shows them as degraded over 800 ms
(`apps/status/src/components.ts`, `SPEED_BUDGET_MS`).

## Measuring

```powershell
# Signed out
powershell -File scripts/perf/measure.ps1 -Runs 7 -Out before.csv
# Signed in: your g1t_session cookie's value, from DevTools; never printed
$env:G1T_SESSION = "<64 hex>"
powershell -File scripts/perf/measure.ps1 -Runs 7 -Pull 12 -Issue 11 -Out before-signed-in.csv
```

It prints p50 and p90 of the server's share (TLS handshake done to first
byte), where the Worker ran, and the slowest Server-Timing entries.
