# Rate limits and log sampling

Internal notes. The public limits are on the docs' rate limits page
(`apps/docs/src/content/docs/reference/rate-limits.md`); change both, and
`RATE_LIMITS`, together.

## Rate limits

Every public surface that costs money or sends something is behind a
[Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
binding (`ratelimits` in its wrangler.jsonc). The table of record is
`RATE_LIMITS` in `packages/contracts/src/rate-limits.ts`;
`apps/web/app/lib/front-door-limits.test.ts` fails when a wrangler.jsonc
and the table disagree, or a namespace id is used twice.

Rules every limit follows:

- **Fails open.** No binding (self-hosted: `deploy/self-host/configs.mjs`
  does not copy `ratelimits`) or a binding that throws lets the request
  through, logged as `rate_limit.unavailable` (TS) or
  `rate limit … could not be asked` (Rust). Helpers: `checkLimit` in
  packages/contracts, `g1t_kit::limits::check`.
- **Keys never hold a secret.** Addresses are `ip:<CF-Connecting-IP>`;
  sessions, tokens, git credentials and email addresses are the first 16 hex
  digits of their SHA-256.
- **60-second window.** The binding only counts over 10 or 60 seconds, so
  "per hour" limits are not possible here; D1 throttles cover those
  (identity's `throttle.rs`, the waitlist's `rate_limits`, status's resend
  window).
- **429 with `Retry-After: 60`.** JSON `{"error": {"code": "rate_limited", …}}`
  on the API and MCP; plain text for git (git prints it) and pages.
- Counts are per Cloudflare location and approximate: a limit is a guard
  against floods, not a quota.

### Namespace ids

Unique per Cloudflare account, in blocks of a hundred per Worker. Take the
next free id in the Worker's block; a new Worker takes the next block.

| Block | Worker |
| --- | --- |
| 41xx | services/packages |
| 42xx | apps/web |
| 43xx | services/repos |
| 44xx | apps/api |
| 45xx | services/og |
| 46xx | apps/status |

### Bindings

| Binding | Id | Limit / 60 s | Key | Where enforced |
| --- | --- | --- | --- | --- |
| `ANONYMOUS_LIMIT` | 4101 | 300 | address | packages `src/limits.rs`: registry pulls and token requests |
| `SIGNED_LIMIT` | 4102 | 5,000 | person, workspace or agent | packages, the same |
| `WEB_ANONYMOUS_LIMIT` | 4201 | 600 | address | web `app/lib/front-door-limits.ts`: signed-out pages and data |
| `WEB_HEAVY_LIMIT` | 4202 | 30 | address | web: signed-out archives, run pages, logs, artifacts, search |
| `WEB_SESSION_LIMIT` | 4203 | 1,200 | session cookie hash | web: requests with a session cookie (not checked there) |
| `WEB_ADDRESS_LIMIT` | 4204 | 3,000 | address | web: every request that reaches the Worker; stops made-up cookies getting round the signed-out limit |
| `GIT_ANONYMOUS_LIMIT` | 4205 | 120 | address | web: git smart HTTP without `Authorization` (~40 clones) |
| `GIT_SIGNED_LIMIT` | 4206 | 1,200 | `Authorization` hash | web: git smart HTTP with credentials, sandboxes' included |
| `WEB_TOKEN_LIMIT` | 4207 | 1,000 | token hash | web: pages, data requests and socket tickets with `Authorization: Bearer` (a token used on the website, not checked there); the same limit as `API_TOKEN_LIMIT`, counted apart. The live sockets such a page opens carry a ticket instead of the header (`app/lib/socket-ticket.ts`), so their upgrades count as signed out, by address |
| `PACK_FILL_LIMIT` | 4301 | 30 | repository id | repos `src/limits.rs`: packs written to `GIT_PACKS`; past it the pack is streamed, not kept |
| `ANONYMOUS_FETCH_LIMIT` | 4302 | 120 | repository id | repos: anonymous fetches the git store answers (cache hits never count) |
| `API_ANONYMOUS_LIMIT` | 4401 | 60 | `rest:`/`mcp:` + address | api `src/limits.rs`: no token, or a wrong one |
| `API_TOKEN_LIMIT` | 4402 | 1,000 | `rest:`/`mcp:` + token hash | api: with a bearer token |
| `OG_RENDER_LIMIT` | 4501 | 60 | address | og `src/index.ts`: cache misses only; past it, the brand card (brief cache) |
| `STATUS_SUBSCRIBE_LIMIT` | 4601 | 3 | address | status `src/index.ts`: `POST /subscribe` |
| `STATUS_EMAIL_LIMIT` | 4602 | 2 | email hash | status: the same, per address asked for (the D1 resend window also allows one email per 10 minutes) |

What is deliberately not limited:

- Static assets (served by the assets binding before the Worker), avatars,
  `go get` answers and the docs redirect on the front door.
- Packages through the front door: the packages service limits itself.
- On the API: Stripe and connection webhooks, sandbox and runner reports
  (job, run, check, plan, review, backup and queue tokens; `REPORTS` in
  `apps/api/src/limits.rs`), the Actions toolkit, OIDC and deployment
  build reports. Many sandboxes share an egress address.
- Status has no Turnstile: nothing in g1t uses Turnstile yet. The honeypot,
  both limits and the resend window are the guard.

Why anonymous git matters: each clone or fetch the store answers is an
operation billed to the repository's workspace (`services/repos/src/git_ops.rs`)
and a miss writes a pack to R2 (`pack_cache.rs`). The address limit stops
one client; `ANONYMOUS_FETCH_LIMIT` bounds many addresses against one
repository (at most 120 × 60 × 24 ≈ 173k operations a day, about $26 at
cost), and `PACK_FILL_LIMIT` bounds R2 writes.

## Log sampling

Workers Logs keeps `head_sampling_rate` of invocations (`observability`
in each wrangler.jsonc). The decision is made when the request starts, so
an unsampled request's `console.error` and uncaught exception are dropped
with the rest of its logs. Workers metrics (requests, errors, CPU) in the
dashboard are not sampled; only the log lines are.

| Rate | Workers | Why |
| --- | --- | --- |
| 1 | billing, identity, runner, actions, deployments, status, sudo | Money, sign-in or a run someone will ask about, or too few requests to matter. Every error is kept. |
| 0.1 | web, api, pages, repos, og, models, search, context, events, work, webhooks, integrations, packages, projects, security, docs | Every page view, git request or event; a tenth is enough to see a pattern. |

The tradeoff: on a 0.1 Worker, a one-off error has a 90% chance of leaving
no log line. Error counts in the dashboard still show it, and a recurring
one shows up within a few occurrences. To chase a rare error on one of
those Workers, raise its rate to 1 for the investigation and lower it after.

A sampled invocation's log holds its full URL. The only credential g1t
ever puts in a URL is a socket ticket (`?ticket=` on `/-/live`,
`/<workspace>/-/chat/live` and `/<workspace>/-/artifacts/live`, for pages
opened with an access token; `apps/web/app/lib/socket-ticket.ts`). The site
never logs it or passes it on, and one found in Workers Logs is useless:
it lasts 60 seconds, opens only that socket, and the token inside it is
sealed and checked again when the socket opens.
