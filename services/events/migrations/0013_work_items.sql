-- Issues became work items (g1t #57). What needs only names is rewritten
-- here; what was kept by a repository's issue number (inbox threads,
-- subscriptions, the log's events) is rewritten as the work service
-- announces where each issue went (`work.migrated`, src/work_items.rs),
-- recorded in `work_migrated`.

-- Inbox items about an issue are about its work item.
UPDATE inbox_items SET subject = 'item' WHERE subject = 'issue';

-- A custom watch that followed issues follows work items.
UPDATE inbox_watching
SET events = (
  SELECT json_group_array(CASE value WHEN 'issues' THEN 'work_items' ELSE value END)
  FROM json_each(inbox_watching.events)
)
WHERE EXISTS (SELECT 1 FROM json_each(inbox_watching.events) WHERE value = 'issues');

-- Subscriptions to a work item keep its origin as `repo_id`, and one
-- with no origin has none.
CREATE TABLE inbox_subscriptions_new (
  username TEXT NOT NULL,
  -- `<repo_id>#<number>` for a pull request, `item:<item_id>` for a work item.
  thread TEXT NOT NULL,
  -- The pull request's repository, or the work item's origin.
  repo_id TEXT,
  -- subscribed | unsubscribed | ignored
  state TEXT NOT NULL,
  -- Why: comment, mention, assign, review_requested, author or manual.
  reason TEXT,
  created_at TEXT NOT NULL,
  -- When the person last chose (subscribed, unsubscribed or ignored by
  -- hand); null while it only follows what they did.
  chosen_at TEXT,
  PRIMARY KEY (thread, username)
);
INSERT INTO inbox_subscriptions_new (username, thread, repo_id, state, reason, created_at, chosen_at)
SELECT username, thread, repo_id, state, reason, created_at, chosen_at FROM inbox_subscriptions;
DROP TABLE inbox_subscriptions;
ALTER TABLE inbox_subscriptions_new RENAME TO inbox_subscriptions;
CREATE INDEX inbox_subscriptions_repo ON inbox_subscriptions (repo_id);

-- Where each repository's issues went, a page of `work.migrated` at a time.
CREATE TABLE work_migrated (
  repo_id TEXT NOT NULL,
  -- The issue's number in its repository.
  legacy_number INTEGER NOT NULL,
  -- The work item's workspace (a slug), number in it, and id.
  workspace TEXT NOT NULL,
  number INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  -- The `work.migrated` event that said so.
  event_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, legacy_number)
);
CREATE INDEX work_migrated_event ON work_migrated (event_id);
