-- Issues move out of repositories into their workspaces as work items
-- (src/items.rs). A work item belongs to a workspace, is numbered in the
-- workspace's sequence (which new pull requests share), and links the
-- repositories it concerns: where it was filed (origin, which keeps the
-- issue's old number), where it is meant to land (target), and where work
-- for it landed or is under way (touched).
--
-- This database does not know which workspace a repository is in, so the
-- job in src/work_migration.rs assigns each work item its workspace and
-- number, and moves labels and milestones to the workspace, once it has
-- asked repos. Everything else moves here: every row that named an issue
-- by repository and number names its work item by id. Until the job is
-- done, an old `#N` resolves through `work_item_repos.legacy_number`.
--
-- Tables are rebuilt the way D1 allows: inside the migration's
-- transaction, with foreign keys deferred until every rebuilt table is in
-- place again.
PRAGMA defer_foreign_keys = true;

-- Which workspace each repository is in, and its path: recorded by the
-- job, then kept on repo.created, renamed, transferred and visibility
-- changes. `private` is 1 until the repository is known to be public.
CREATE TABLE repo_workspaces (
  repo_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- owner/name, as it is now.
  path TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX repo_workspaces_by_workspace ON repo_workspaces (workspace);

-- Each workspace's sequence of numbers, shared by work items and new pull
-- requests. The per-repository `counters` stays, emptied by the job, for
-- the code that still reads it while the job runs.
CREATE TABLE work_counters (
  workspace TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

-- One-off jobs, resumable: where each got to, and when it finished.
CREATE TABLE work_jobs (
  name TEXT PRIMARY KEY,
  cursor TEXT,
  done_at TEXT
);
INSERT INTO work_jobs (name) VALUES ('work_items');

-- The issues, renamed first so that pulls' reference follows them.
ALTER TABLE issues RENAME TO work_items;

CREATE TABLE work_items_next (
  -- wki_…; one moved from an issue keeps its iss_… id.
  id TEXT PRIMARY KEY,
  -- The workspace's slug and its number there: NULL until the job
  -- assigns them to a moved issue.
  workspace TEXT,
  number INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- JSON array of label names.
  labels TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open',
  -- Why it was closed: completed or not_planned.
  reason TEXT,
  -- JSON array of { repo_id, pull, commit, pushed_by }: what resolved it
  -- in each repository it landed in.
  resolutions TEXT NOT NULL DEFAULT '[]',
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  requested_by_id TEXT,
  requested_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  -- JSON array of usernames.
  assignees TEXT NOT NULL DEFAULT '[]',
  -- JSON array of the ids of the work items that have to land first.
  blocked_by TEXT NOT NULL DEFAULT '[]',
  -- The number of its workspace milestone.
  milestone INTEGER,
  UNIQUE (workspace, number)
);

INSERT INTO work_items_next
  (id, workspace, number, title, body, labels, state, reason, resolutions, author_id, author_name,
   requested_by_id, requested_by_name, created_at, updated_at, closed_at, assignees, blocked_by, milestone)
SELECT
  i.id, NULL, NULL, i.title, i.body, i.labels, i.state, i.reason,
  CASE WHEN i.resolved_by IS NOT NULL OR i.resolved_commit IS NOT NULL
    THEN json_array(json_object('repo_id', i.repo_id, 'pull', i.resolved_by, 'commit', i.resolved_commit,
                                'pushed_by', i.resolved_pushed_by))
    ELSE '[]' END,
  i.author_id, i.author_name, i.requested_by_id, i.requested_by_name, i.created_at, i.updated_at, i.closed_at,
  i.assignees,
  (SELECT json_group_array(id) FROM
     (SELECT b.id AS id FROM json_each(i.blocked_by) j JOIN work_items b ON b.repo_id = i.repo_id AND b.number = j.value
      ORDER BY j.key)),
  i.milestone
FROM work_items i;

-- The repositories each work item is linked to.
CREATE TABLE work_item_repos (
  item_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('origin', 'target', 'touched')),
  -- For the origin of a moved issue: its number in that repository.
  legacy_number INTEGER,
  -- owner/name: filled in by the job, kept when the repository goes.
  path TEXT,
  -- When something that closes it landed there.
  landed_at TEXT,
  added_at TEXT NOT NULL,
  -- Who linked it, by id; NULL when g1t did.
  added_by TEXT,
  PRIMARY KEY (item_id, repo_id)
);
CREATE INDEX work_item_repos_by_repo ON work_item_repos (repo_id, role);
CREATE UNIQUE INDEX work_item_repos_by_legacy ON work_item_repos (repo_id, legacy_number)
  WHERE legacy_number IS NOT NULL;

INSERT INTO work_item_repos (item_id, repo_id, role, legacy_number, path, landed_at, added_at, added_by)
SELECT id, repo_id, 'origin', number, NULL,
  CASE WHEN state = 'closed' AND (resolved_by IS NOT NULL OR resolved_commit IS NOT NULL) THEN closed_at END,
  created_at, author_id
FROM work_items;

DROP TABLE work_items;
ALTER TABLE work_items_next RENAME TO work_items;
CREATE INDEX work_items_by_state ON work_items (workspace, state, number);
CREATE INDEX work_items_by_milestone ON work_items (workspace, milestone);
CREATE INDEX work_items_by_author ON work_items (author_id, created_at);
CREATE INDEX work_items_by_owner ON work_items (COALESCE(requested_by_id, author_id), created_at);
CREATE INDEX work_items_unnumbered ON work_items (created_at, id) WHERE number IS NULL;

-- Pull requests name their work item by id, and what they close or are
-- part of as JSON arrays of ids.
DROP INDEX pulls_by_issue;
ALTER TABLE pulls RENAME COLUMN issue_id TO item_id;
ALTER TABLE pulls DROP COLUMN issue_number;
ALTER TABLE pulls ADD COLUMN closes_items TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pulls ADD COLUMN parts TEXT NOT NULL DEFAULT '[]';
UPDATE pulls SET closes_items = (SELECT json_group_array(id) FROM
    (SELECT r.item_id AS id FROM json_each(pulls.closes) j
     JOIN work_item_repos r ON r.repo_id = pulls.repo_id AND r.legacy_number = j.value
     ORDER BY j.key))
  WHERE closes IS NOT NULL AND json_valid(closes);
ALTER TABLE pulls DROP COLUMN closes;
CREATE INDEX pulls_by_item ON pulls (item_id);

-- Comments: a pull request's by repository and number, a work item's by
-- its id.
CREATE TABLE comments_next (
  id TEXT PRIMARY KEY,
  repo_id TEXT,
  number INTEGER,
  item_id TEXT,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  -- For a comment on one line of a pull request's change: the file, and
  -- the line as numbered after the change.
  path TEXT,
  line INTEGER,
  -- A reviewer's decision: approve or request_changes.
  verdict TEXT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',
  edited_at TEXT,
  agent_id TEXT,
  agent_handle TEXT,
  agent_name TEXT,
  agent_avatar_seed TEXT,
  acting_for_id TEXT,
  acting_for_name TEXT,
  agent_verdict TEXT,
  CHECK (item_id IS NOT NULL OR (repo_id IS NOT NULL AND number IS NOT NULL))
);
INSERT INTO comments_next
  (id, repo_id, number, item_id, author_id, author_name, body, path, line, verdict, created_at, kind, edited_at,
   agent_id, agent_handle, agent_name, agent_avatar_seed, acting_for_id, acting_for_name, agent_verdict)
SELECT c.id,
  CASE WHEN r.item_id IS NULL THEN c.repo_id END, CASE WHEN r.item_id IS NULL THEN c.number END, r.item_id,
  c.author_id, c.author_name, c.body, c.path, c.line, c.verdict, c.created_at, c.kind, c.edited_at,
  c.agent_id, c.agent_handle, c.agent_name, c.agent_avatar_seed, c.acting_for_id, c.acting_for_name, c.agent_verdict
FROM comments c LEFT JOIN work_item_repos r ON r.repo_id = c.repo_id AND r.legacy_number = c.number;
DROP TABLE comments;
ALTER TABLE comments_next RENAME TO comments;
CREATE INDEX comments_by_subject ON comments (repo_id, number, id);
CREATE INDEX comments_by_item ON comments (item_id, id);
CREATE INDEX comments_by_author ON comments (author_id, created_at);
CREATE INDEX comments_by_agent ON comments (agent_id, repo_id, number, created_at)
  WHERE agent_id IS NOT NULL;

-- Reactions: the same.
CREATE TABLE reactions_next (
  -- The comment's id, or the pull request's or work item's own id for its
  -- description.
  subject TEXT NOT NULL,
  repo_id TEXT,
  number INTEGER,
  item_id TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject, user_id, content)
);
INSERT INTO reactions_next (subject, repo_id, number, item_id, user_id, user_name, content, created_at)
SELECT x.subject,
  CASE WHEN r.item_id IS NULL THEN x.repo_id END, CASE WHEN r.item_id IS NULL THEN x.number END, r.item_id,
  x.user_id, x.user_name, x.content, x.created_at
FROM reactions x LEFT JOIN work_item_repos r ON r.repo_id = x.repo_id AND r.legacy_number = x.number;
DROP TABLE reactions;
ALTER TABLE reactions_next RENAME TO reactions;
CREATE INDEX reactions_by_thread ON reactions (repo_id, number);
CREATE INDEX reactions_by_item ON reactions (item_id);
CREATE INDEX reactions_by_user ON reactions (user_id);

-- Claims are on a work item; the repository is the claimant's checkout.
CREATE TABLE claims_next (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  repo_id TEXT,
  session_id TEXT,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  harness TEXT,
  note TEXT,
  -- active, released, expired or handed_off.
  state TEXT NOT NULL DEFAULT 'active',
  ttl_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  -- For a hand-off: the username it is for; NULL for anyone.
  handoff_to TEXT
);
INSERT INTO claims_next
  (id, item_id, repo_id, session_id, actor_id, actor_name, harness, note, state, ttl_minutes, created_at,
   expires_at, ended_at, end_reason, handoff_to)
SELECT c.id, r.item_id, c.repo_id, c.session_id, c.actor_id, c.actor_name, c.harness, c.note, c.state, c.ttl_minutes,
  c.created_at, c.expires_at, c.ended_at, c.end_reason, c.handoff_to
FROM claims c JOIN work_item_repos r ON r.repo_id = c.repo_id AND r.legacy_number = c.issue;
DROP TABLE claims;
ALTER TABLE claims_next RENAME TO claims;
CREATE INDEX claims_by_item ON claims (item_id, state);
CREATE INDEX claims_by_state ON claims (state, expires_at);
CREATE INDEX claims_by_repo ON claims (repo_id, state) WHERE repo_id IS NOT NULL;
CREATE INDEX claims_by_session ON claims (session_id, state) WHERE session_id IS NOT NULL;

-- A session's work item, by id.
ALTER TABLE sessions ADD COLUMN item_id TEXT;
UPDATE sessions SET item_id = (SELECT r.item_id FROM work_item_repos r
    WHERE r.repo_id = sessions.repo_id AND r.legacy_number = sessions.issue)
  WHERE issue IS NOT NULL;
DROP INDEX sessions_by_issue;
ALTER TABLE sessions DROP COLUMN issue;
CREATE INDEX sessions_by_item ON sessions (item_id) WHERE item_id IS NOT NULL;

-- Sessions' ties: a pull request by number, a work item (kind `item`) by
-- id, with number 0.
CREATE TABLE session_links_next (
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- item or pull.
  kind TEXT NOT NULL,
  -- A pull request's number; 0 for a work item.
  number INTEGER NOT NULL,
  -- A work item's id; '' for a pull request.
  item_id TEXT NOT NULL DEFAULT '',
  via TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, kind, number, item_id, via)
);
INSERT INTO session_links_next (session_id, repo_id, kind, number, item_id, via, at)
SELECT session_id, repo_id, kind, number, '', via, at FROM session_links WHERE kind = 'pull';
INSERT OR IGNORE INTO session_links_next (session_id, repo_id, kind, number, item_id, via, at)
SELECT l.session_id, l.repo_id, 'item', 0, r.item_id, l.via, l.at
FROM session_links l JOIN work_item_repos r ON r.repo_id = l.repo_id AND r.legacy_number = l.number
WHERE l.kind = 'issue';
DROP TABLE session_links;
ALTER TABLE session_links_next RENAME TO session_links;
CREATE INDEX session_links_by_number ON session_links (repo_id, kind, number);
CREATE INDEX session_links_by_item ON session_links (item_id) WHERE item_id <> '';

-- What a session named: a work item (kind `item`) by id.
UPDATE OR IGNORE session_touches SET kind = 'item',
    value = (SELECT r.item_id FROM work_item_repos r
             WHERE r.repo_id = session_touches.repo_id AND r.legacy_number = CAST(session_touches.value AS INTEGER))
  WHERE kind = 'issue' AND EXISTS (SELECT 1 FROM work_item_repos r
    WHERE r.repo_id = session_touches.repo_id AND r.legacy_number = CAST(session_touches.value AS INTEGER));
DELETE FROM session_touches WHERE kind = 'issue';

-- Decisions on a work item, by id; a pull request's stay by number.
ALTER TABLE decisions ADD COLUMN item_id TEXT;
UPDATE decisions SET item_id = (SELECT r.item_id FROM work_item_repos r
    WHERE r.repo_id = decisions.repo_id AND r.legacy_number = decisions.issue)
  WHERE issue IS NOT NULL;
DROP INDEX decisions_by_issue;
ALTER TABLE decisions DROP COLUMN issue;
CREATE INDEX decisions_by_item ON decisions (item_id, created_at) WHERE item_id IS NOT NULL;

-- Mentions of the retired agent, kept for their history: on a work item
-- by id too.
ALTER TABLE agent_mentions ADD COLUMN item_id TEXT;
UPDATE agent_mentions SET item_id = (SELECT r.item_id FROM work_item_repos r
    WHERE r.repo_id = agent_mentions.repo_id AND r.legacy_number = agent_mentions.number)
  WHERE pull_id IS NULL;

ALTER TABLE queue_entries RENAME COLUMN keep_issue_open TO keep_item_open;

ALTER TABLE repo_settings RENAME COLUMN has_issues TO has_work_items;
ALTER TABLE repo_settings RENAME COLUMN auto_close_issues TO auto_close_items;
UPDATE repo_settings SET merge_commit_template = replace(merge_commit_template, '{issues}', '{items}')
  WHERE merge_commit_template LIKE '%{issues}%';
UPDATE repo_settings SET squash_commit_template = replace(squash_commit_template, '{issues}', '{items}')
  WHERE squash_commit_template LIKE '%{issues}%';

-- Labels and milestones belong to the workspace. The repositories' own
-- wait here until the job merges them in: labels by name (the first made
-- keeps its color and description), milestones renumbered in the
-- workspace (`milestone_moves` says where each went).
ALTER TABLE labels RENAME TO repo_labels;
ALTER TABLE milestones RENAME TO repo_milestones;
DROP INDEX milestones_by_state;

CREATE TABLE labels (
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Six hex digits, without '#'.
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, name)
);

CREATE TABLE milestones (
  workspace TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- For one moved from a repository: that repository's id.
  origin_repo_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- YYYY-MM-DD, or NULL.
  due_on TEXT,
  -- open or closed.
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (workspace, number)
);
CREATE INDEX milestones_by_state ON milestones (workspace, state, due_on);

CREATE TABLE milestone_moves (
  repo_id TEXT NOT NULL,
  old_number INTEGER NOT NULL,
  workspace TEXT NOT NULL,
  number INTEGER NOT NULL,
  PRIMARY KEY (repo_id, old_number)
);

PRAGMA defer_foreign_keys = false;
