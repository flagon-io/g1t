-- Reading a pull request without asking the repos service anything.
--
-- Whether the branch a pull request would land on has commits it does not,
-- worked out with its mergeability on every push to either side
-- (mergeability.rs) and kept beside `mergeable_key`, the pair of commits
-- it is for. Showing a pull request reads it from here; until a push
-- fills it in, the repos service is asked as before. 1 or 0; NULL until
-- first worked out.
ALTER TABLE pulls ADD COLUMN behind INTEGER;

-- An agent's unanswered questions and handoffs, by the pull request that
-- sent them (confidence.rs): found directly instead of by reading every
-- message in the repository.
CREATE INDEX IF NOT EXISTS agent_messages_by_sender ON agent_messages (repo_id, from_number);
