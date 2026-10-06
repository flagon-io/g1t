-- Pull request working copies (`pulls--<pull id>` in the git store) are
-- removed some days after their pull request merges or closes
-- (src/forks.rs), in the hourly sweep. Their rows stay, so the pull
-- request's page still reads its changes, from the repository it came from.
--
-- retire_after: RFC 3339. Set when the pull request merges or closes,
--   cleared if it reopens in time. The sweep retires it once this passes.
-- retired_at: RFC 3339. When its git data was removed. Null while it has some.
-- retired_head: the commit its branch pointed to when it was removed. Kept
--   in the repository it came from: as part of its history once merged, or
--   under refs/pull/<pull id>/head. Reads of the working copy are answered
--   from there; anything that writes to it makes it again (`revive`).
ALTER TABLE repos ADD COLUMN retire_after TEXT;
ALTER TABLE repos ADD COLUMN retired_at TEXT;
ALTER TABLE repos ADD COLUMN retired_head TEXT;
CREATE INDEX repos_retiring ON repos (retire_after) WHERE retire_after IS NOT NULL AND retired_at IS NULL;

-- How the git store has been answering, by the minute, for the status
-- page's "Git storage" part (`store_health`). Each isolate adds up its own
-- calls and writes them now and then, after its answers have gone back
-- (src/health.rs). Kept for a day.
--
-- store: the git store namespace (`g1t`, or a shard's).
-- minute: YYYY-MM-DDTHH:MM, UTC.
-- calls, errors: calls made and how many failed (after retries).
-- rate_limited: of those, how many the store refused for its rate limit.
-- rejected: calls not made because the namespace's breaker was open.
-- ms_total: summed duration of the calls, for the mean.
CREATE TABLE store_health (
  store TEXT NOT NULL,
  minute TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  ms_total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store, minute)
);

-- Every interaction with the git store, as raw meters: what g1t asked of it,
-- by day, workspace and repository (src/meters.rs). Counted in each isolate
-- and written after answers have gone back, never on the request path.
-- Cloudflare has not said exactly what it bills as an "operation" during
-- the beta, so everything is kept and what counts is decided by data
-- (`operation_mapping`), not code.
--
-- day: YYYY-MM-DD, UTC.
-- store: the git store namespace (`g1t`, or a shard's).
-- repo: the repository's name in the git store (`acme--rocket`,
--   `pulls--<pull id>`): what Cloudflare's metrics call `repositoryName`.
-- workspace: the workspace it belongs to, when known (`pulls` for a pull
--   request's working copy; join `repos.fork_of` for its repository's).
-- meter: what was asked. Git over HTTPS from people and tools:
--   `git.info_refs`, `git.ls_refs`, `git.fetch`, `git.receive_pack`; by
--   g1t itself (landing, catching up, mirrors, listing branches):
--   `internal.git.info_refs`, `internal.git.fetch`,
--   `internal.git.receive_pack`; calls on the binding: `binding.<method>`
--   (`binding.get`, `binding.create_token`, `binding.log`, ...).
-- count, bytes_in, bytes_out: how many, and the bytes sent to and received
--   from the store where known (0 where not).
CREATE TABLE artifacts_meters (
  day TEXT NOT NULL,
  store TEXT NOT NULL,
  repo TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT '',
  meter TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, store, repo, meter)
);
CREATE INDEX artifacts_meters_by_workspace ON artifacts_meters (workspace, day);

-- Which meters are git operations, and how many each is worth: what
-- Cloudflare bills g1t (`cost_operations`, for reconciling with its
-- invoice) and what a workspace is counted for (`billable_operations`,
-- added to `git_operations`, which billing charges past the free amount).
-- Changed by data (`set_operation_mapping`) the day Cloudflare says what it
-- counts; no deploy. A meter not listed counts as 0 for both.
--
-- The defaults are what Cloudflare most plausibly bills: a clone or fetch
-- (one per upload-pack request that fetches objects), a push (one per
-- receive-pack), and making, forking and deleting a repository. Listing
-- refs, ref answers g1t served from its own cache, and reads through the
-- binding count for nothing.
CREATE TABLE operation_mapping (
  meter TEXT PRIMARY KEY,
  cost_operations REAL NOT NULL DEFAULT 0,
  billable_operations REAL NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO operation_mapping (meter, cost_operations, billable_operations, note, updated_at) VALUES
  ('git.fetch', 1, 1, 'Clone or fetch: an upload-pack request that fetches objects', '2026-10-06T00:00:00Z'),
  ('git.receive_pack', 1, 1, 'Push', '2026-10-06T00:00:00Z'),
  ('internal.git.fetch', 1, 1, 'g1t fetching objects: landing, catching up, mirrors', '2026-10-06T00:00:00Z'),
  ('internal.git.receive_pack', 1, 1, 'g1t pushing: landing, catching up, commits from the web, mirrors', '2026-10-06T00:00:00Z'),
  ('binding.create', 1, 1, 'A repository made', '2026-10-06T00:00:00Z'),
  ('binding.fork', 1, 1, 'A pull request''s working copy made', '2026-10-06T00:00:00Z'),
  ('binding.delete', 1, 1, 'A repository or working copy deleted', '2026-10-06T00:00:00Z');
