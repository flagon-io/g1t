-- The inbox in threads (src/inbox.rs): one item per person per thing it is
-- about, brought back to the top by new activity, with a short history;
-- why each person was told, in a fixed set of reasons; subscriptions to
-- issues and pull requests; how people watch repositories; and what each
-- person chose about being told.

-- What the item is about, as one key: `<repo_id>#<number>` for an issue or
-- pull request, `<repo_id>/run/<workflow>@<branch>` for a workflow on a
-- branch, `<repo_id>/deploy/<project_id>/<production|number>` for a
-- project's deployments.
ALTER TABLE inbox_items ADD COLUMN thread TEXT;
-- The latest activity: when, as a time-sortable id lists order by, its
-- event type, and how many things have happened on the thread.
ALTER TABLE inbox_items ADD COLUMN updated_at TEXT;
ALTER TABLE inbox_items ADD COLUMN bumped TEXT;
ALTER TABLE inbox_items ADD COLUMN event TEXT;
ALTER TABLE inbox_items ADD COLUMN activity INTEGER NOT NULL DEFAULT 1;
-- A path on the site, for a subject with a page of its own (a deployment).
ALTER TABLE inbox_items ADD COLUMN link TEXT;

-- Reasons were named for what happened; now they say why the person was told.
UPDATE inbox_items SET reason = CASE reason
  WHEN 'agent_asked' THEN 'agent'
  WHEN 'checks_failed' THEN 'ci_activity'
  WHEN 'workflow_failed' THEN 'ci_activity'
  WHEN 'mentioned' THEN 'mention'
  WHEN 'merged' THEN 'state_change'
  ELSE 'author'
END;
UPDATE inbox_items SET
  thread = CASE
    WHEN number IS NOT NULL THEN repo_id || '#' || number
    WHEN run_id IS NOT NULL THEN repo_id || '/run/' || run_id
    ELSE 'event/' || event_id
  END,
  updated_at = created_at,
  bumped = id;

-- What happened on each thread, newest first, at most 10 kept. One row per
-- event per person, so a redelivered event is told once.
CREATE TABLE inbox_activity (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  username TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event TEXT,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, username)
);
CREATE INDEX inbox_activity_item ON inbox_activity (item_id, id);

-- Items about the same thing become one: every item is a line of its
-- history, and the newest stays: unread with the most urgent severity of
-- those unread if any was, and saved if any was.
INSERT INTO inbox_activity (id, item_id, username, event_id, reason, severity, title, body, actor, created_at)
SELECT i.id,
       (SELECT max(j.id) FROM inbox_items j WHERE j.username = i.username AND j.thread = i.thread),
       i.username, i.event_id, i.reason, i.severity, i.title, i.body, i.actor, i.created_at
FROM inbox_items i;
UPDATE inbox_items SET severity = COALESCE((
  SELECT j.severity FROM inbox_items j
  WHERE j.username = inbox_items.username AND j.thread = inbox_items.thread AND j.read_at IS NULL AND j.done_at IS NULL
  ORDER BY CASE j.severity WHEN 'warning' THEN 0 WHEN 'error' THEN 1 WHEN 'success' THEN 2 ELSE 3 END
  LIMIT 1), severity);
UPDATE inbox_items SET
  activity = (SELECT count(*) FROM inbox_items j WHERE j.username = inbox_items.username AND j.thread = inbox_items.thread),
  created_at = (SELECT min(j.created_at) FROM inbox_items j WHERE j.username = inbox_items.username AND j.thread = inbox_items.thread),
  saved = (SELECT max(j.saved) FROM inbox_items j WHERE j.username = inbox_items.username AND j.thread = inbox_items.thread),
  read_at = CASE WHEN EXISTS (
    SELECT 1 FROM inbox_items j
    WHERE j.username = inbox_items.username AND j.thread = inbox_items.thread AND j.read_at IS NULL AND j.done_at IS NULL
  ) THEN NULL ELSE read_at END,
  done_at = CASE WHEN EXISTS (
    SELECT 1 FROM inbox_items j
    WHERE j.username = inbox_items.username AND j.thread = inbox_items.thread AND j.done_at IS NULL
  ) THEN NULL ELSE done_at END;
DELETE FROM inbox_items
WHERE id NOT IN (SELECT max(id) FROM inbox_items GROUP BY username, thread);

CREATE UNIQUE INDEX inbox_thread ON inbox_items (username, thread);
CREATE INDEX inbox_thread_of ON inbox_items (thread);
-- Lists go by latest activity.
DROP INDEX inbox_recent;
DROP INDEX inbox_saved;
CREATE INDEX inbox_recent ON inbox_items (username, bumped) WHERE done_at IS NULL;
CREATE INDEX inbox_saved ON inbox_items (username, bumped) WHERE saved = 1;

-- Subscriptions to issues and pull requests, beyond being their author,
-- assignee or reviewer (which subscribes a person without a row): someone
-- who commented or was mentioned, subscribed by hand, unsubscribed, or
-- ignores the thread.
CREATE TABLE inbox_subscriptions (
  username TEXT NOT NULL,
  -- `<repo_id>#<number>`.
  thread TEXT NOT NULL,
  repo_id TEXT NOT NULL,
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
CREATE INDEX inbox_subscriptions_repo ON inbox_subscriptions (repo_id);

-- How people watch repositories. No row: participating.
CREATE TABLE inbox_watching (
  username TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- `owner/name`, kept for listing what a person watches.
  repo TEXT,
  -- participating | all | ignore | custom
  level TEXT NOT NULL,
  -- With custom: a JSON array of issues, pulls, deployments, security.
  events TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, username)
);
CREATE INDEX inbox_watching_user ON inbox_watching (username);

-- What each person chose: the reasons they are emailed for (a JSON array),
-- and how they watch repositories they create. No row: the defaults.
CREATE TABLE inbox_settings (
  username TEXT PRIMARY KEY,
  email TEXT,
  default_watch TEXT,
  updated_at TEXT NOT NULL
);
