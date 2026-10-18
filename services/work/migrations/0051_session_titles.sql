-- Session titles that settle (src/coordination/titles.rs). A session's
-- title says where it came from (`title_source`): `prompt` (provisional,
-- the first prompt's intent), `agent` (its harness or agent said so),
-- `person` (pinned from the site, never replaced), `item` or `pull` (the
-- work item's or pull request's title) or `summary` (g1t named the whole
-- of the work, with the workspace's AI provider or without one).
--
-- g1t settles a title when one is due (`title_due_at`, read by the cron):
-- once the session has enough to go on, again only when what it works on
-- changes (at most every 20 minutes), and a last time when it ends
-- (`title_final`). `title_basis` is what it was settled from (its work
-- items and pull requests), `title_prompts` how many prompts it had then,
-- `title_calls` how many times the AI provider was asked (a handful at
-- most), and `prompts` how many prompts it recorded.
ALTER TABLE sessions ADD COLUMN title_source TEXT;
ALTER TABLE sessions ADD COLUMN title_settled_at TEXT;
ALTER TABLE sessions ADD COLUMN title_due_at TEXT;
ALTER TABLE sessions ADD COLUMN title_final INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN title_basis TEXT;
ALTER TABLE sessions ADD COLUMN title_prompts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN title_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN prompts INTEGER NOT NULL DEFAULT 0;

UPDATE sessions SET prompts = (
  SELECT COUNT(*) FROM session_entries e WHERE e.session_id = sessions.id AND e.kind = 'prompt'
);

-- Every session started before this is settled once (the backfill): a
-- subagent keeps its task, so only sessions at the top of a tree.
UPDATE sessions SET title_due_at = COALESCE(ended_at, last_seen_at) WHERE parent_id IS NULL;

CREATE INDEX sessions_title_due ON sessions (title_due_at) WHERE title_due_at IS NOT NULL;
