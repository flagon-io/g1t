-- More of how a repository wants its pull requests handled.

-- How many approving reviews a pull request needs before it may merge, and
-- whether a g1t agent's approval counts as one.
ALTER TABLE repo_settings ADD COLUMN required_approvals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repo_settings ADD COLUMN count_agent_approvals INTEGER NOT NULL DEFAULT 1;
-- Whether a member may merge although the acceptance checks did not pass.
ALTER TABLE repo_settings ADD COLUMN allow_ignoring_checks INTEGER NOT NULL DEFAULT 1;
-- Whether a g1t agent's pull request is reviewed by a second agent, and how
-- many times its author may be sent back before a person is asked.
ALTER TABLE repo_settings ADD COLUMN agent_review INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repo_settings ADD COLUMN max_revisions INTEGER NOT NULL DEFAULT 2;
