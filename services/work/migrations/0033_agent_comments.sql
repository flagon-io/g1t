-- A workspace's own agents (Margo, @margo) comment on issues and pull
-- requests, and review pull requests, as themselves, on behalf of a
-- person whose access caps them (src/agent_comments.rs). Such a comment
-- is stored with the agent as its author (author_id is the agent's id,
-- author_name its handle) and these columns beside it:
--
--   agent_*        the agent as it was when it wrote it, for showing it
--                  without asking the agents service: id, handle, name
--                  and the seed its pixel face is drawn from.
--   acting_for_*   the person it acted for: their id and username. They
--                  answer for it as its author would (edit, delete).
--   agent_verdict  an agent review's verdict: comment, approve or
--                  request_changes. Kept apart from `verdict` on purpose:
--                  every rule that counts approvals or requests for
--                  changes (required approvals, code owners, a person's
--                  request for changes, confidence, contributions) reads
--                  `verdict`, so an agent's review is advisory by
--                  construction and never satisfies or blocks a merge.
ALTER TABLE comments ADD COLUMN agent_id TEXT;
ALTER TABLE comments ADD COLUMN agent_handle TEXT;
ALTER TABLE comments ADD COLUMN agent_name TEXT;
ALTER TABLE comments ADD COLUMN agent_avatar_seed TEXT;
ALTER TABLE comments ADD COLUMN acting_for_id TEXT;
ALTER TABLE comments ADD COLUMN acting_for_name TEXT;
ALTER TABLE comments ADD COLUMN agent_verdict TEXT;

-- How many times an agent wrote on one issue or pull request lately, for
-- its rate limit.
CREATE INDEX IF NOT EXISTS comments_by_agent ON comments (agent_id, repo_id, number, created_at)
  WHERE agent_id IS NOT NULL;
