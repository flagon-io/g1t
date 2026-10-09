-- Mirroring: a repository's links to copies of it on other hosts, and the
-- health of those hosts. See src/remotes.rs and crates/contracts
-- src/mirrors.rs. Every timestamp is RFC 3339 UTC; *_ms are milliseconds
-- since the epoch.

-- One link. role leader: the remote leads and the repository is its
-- mirror (at most one per repository). role follower: g1t leads and the
-- remote is kept in step.
--
-- provider: github | g1t | git.
-- name: for people, `github.com/acme/web`. url: its web address.
-- clone_url: its https git address.
-- external_id: the provider's id for it (GitHub's numeric repository id,
--   which survives renames). connection_id: GitHub's installation id.
-- username, credential: for g1t and git, the user and token sent by basic
--   authentication; the token sealed under INTEGRATIONS_KEY.
-- state: standby | ci | takeover | handing_back (leaders), following |
--   stuck (followers). state_by: a username, or g1t.
-- settings: JSON `MirrorSettings`.
-- recorded: 0 until the repos service has this state (set_mirror); the
--   cron retries until it has.
-- polled_ms: the last poll of a remote with no webhook.
CREATE TABLE remotes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL,
  provider TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  clone_url TEXT NOT NULL,
  external_id TEXT,
  connection_id TEXT,
  username TEXT,
  credential TEXT,
  state TEXT NOT NULL,
  state_since TEXT NOT NULL,
  state_by TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  recorded INTEGER NOT NULL DEFAULT 0,
  polled_ms INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX remotes_one_leader ON remotes (repo_id) WHERE role = 'leader';
CREATE INDEX remotes_by_repo ON remotes (repo_id);
CREATE INDEX remotes_by_external ON remotes (provider, external_id);
CREATE INDEX remotes_unrecorded ON remotes (recorded) WHERE recorded = 0;

-- During a takeover: each ref's commit when it began (base), what both
-- sides agreed on, and what someone decided for one that diverged.
CREATE TABLE remote_refs (
  remote_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  base TEXT,
  decision TEXT,
  PRIMARY KEY (remote_id, ref)
);

-- Whether a host answers. It is unreachable after three failed checks
-- over at least two minutes, and reachable again after three good ones
-- over at least five.
--
-- failures, successes: in a row. streak_ms: when the current run began.
-- unreachable_since: set while unreachable.
CREATE TABLE remote_hosts (
  host TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  streak_ms INTEGER NOT NULL DEFAULT 0,
  unreachable_since TEXT,
  checked_ms INTEGER NOT NULL DEFAULT 0,
  last_problem TEXT
);

-- The GitHub links that kept g1t in step (mirror) or GitHub in step
-- (push) become remotes. A mirror becomes a standby mirror: read-only on
-- g1t until someone takes over, which is what it always was in effect
-- (anything pushed to it was overwritten at the next sync).
INSERT INTO remotes
  (id, repo_id, workspace, repo, provider, role, name, url, clone_url, external_id, connection_id,
   state, state_since, settings, synced_at, last_error, created_by, created_at)
SELECT
  'rmt_' || lower(hex(randomblob(10))), repo_id, workspace, repo, 'github',
  CASE mode WHEN 'mirror' THEN 'leader' ELSE 'follower' END,
  'github.com/' || full_name, 'https://github.com/' || full_name, 'https://github.com/' || full_name || '.git',
  CAST(github_repo_id AS TEXT), CAST(installation_id AS TEXT),
  CASE mode WHEN 'mirror' THEN 'standby' ELSE 'following' END,
  COALESCE(synced_at, created_at), '{}', synced_at, last_error, created_by, created_at
FROM github_repos
WHERE mode IN ('mirror', 'push');
