-- Issues became work items, numbered in their workspace. Links and
-- deliveries name the work item they are about; agent runs, the work item
-- they work on. The new numbers are known only once the work service has
-- numbered every item, so rows kept by a repository's issue number keep
-- it in `legacy_repo_id` and `legacy_number` until `work.migrated` says
-- where it went (src/work_migrated.rs), and are then cleared.

-- A work item's tie to something outside g1t: the Sentry issue that
-- opened it, the ticket it was imported from. One per outside thing per
-- connection, so an alert that fires 500 times is one work item.
CREATE TABLE links_new (
  id TEXT PRIMARY KEY,
  -- The work item's workspace, the connection's.
  workspace TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- The outside system's own id for it, as its API takes it.
  external_id TEXT NOT NULL,
  -- What people call it: TECH-1234, or a Sentry short id.
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  -- The work item, by id and by number in the workspace. Null until
  -- `work.migrated` for a link made to an issue.
  item_id TEXT,
  number INTEGER,
  -- The issue it was made to, until `work.migrated`.
  legacy_repo_id TEXT,
  legacy_number INTEGER,
  -- How many times an alert has fired for it, and the count last
  -- mentioned on the work item.
  count INTEGER NOT NULL DEFAULT 1,
  announced INTEGER NOT NULL DEFAULT 1,
  -- Whether the outside system has been told work started on it.
  told_started INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE (connection_id, external_id)
);

INSERT INTO links_new
  (id, workspace, connection_id, provider, external_id, key, title, url, item_id, number, legacy_repo_id, legacy_number,
   count, announced, told_started, first_seen, last_seen)
SELECT id, workspace, connection_id, provider, external_id, key, title, url, NULL, NULL, repo_id, number,
       count, announced, told_started, first_seen, last_seen
FROM links;

-- What was received about an issue: `owner/name#number` becomes the work
-- item's `workspace#number`. The issue is found by its repository's path
-- through the links made to it.
ALTER TABLE deliveries ADD COLUMN item TEXT;
ALTER TABLE deliveries ADD COLUMN legacy_repo_id TEXT;
ALTER TABLE deliveries ADD COLUMN legacy_number INTEGER;
UPDATE deliveries SET
  legacy_repo_id = (SELECT l.repo_id FROM links l WHERE l.repo = substr(deliveries.issue, 1, instr(deliveries.issue, '#') - 1) LIMIT 1),
  legacy_number = CAST(substr(issue, instr(issue, '#') + 1) AS INTEGER)
WHERE issue IS NOT NULL AND instr(issue, '#') > 0;
ALTER TABLE deliveries DROP COLUMN issue;
CREATE INDEX deliveries_by_legacy ON deliveries (legacy_repo_id, legacy_number) WHERE legacy_repo_id IS NOT NULL;

DROP TABLE links;
ALTER TABLE links_new RENAME TO links;
CREATE INDEX links_by_item ON links (item_id);
CREATE INDEX links_by_number ON links (workspace, number);
CREATE INDEX links_by_legacy ON links (legacy_repo_id, legacy_number) WHERE legacy_repo_id IS NOT NULL;

-- The work item a run works on, by number in its workspace (for a pull
-- request with none, the pull request's number). Runs started on an issue
-- keep none: their g1t session names the work item.
ALTER TABLE agent_runs ADD COLUMN item INTEGER;
ALTER TABLE agent_runs DROP COLUMN issue;
