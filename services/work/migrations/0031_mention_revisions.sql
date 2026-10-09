-- When a mention sent g1t back to its pull request, so that no more than
-- a day's ceiling of them do (settings.rs MAX_MENTION_REVISIONS_PER_DAY).
ALTER TABLE agent_mentions ADD COLUMN revised_at TEXT;
CREATE INDEX agent_mentions_revised ON agent_mentions (pull_id, revised_at)
  WHERE revised_at IS NOT NULL;
