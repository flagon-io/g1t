-- What happened to an issue or a pull request, told in its conversation:
-- who was assigned, whose review was asked for, when it was closed. These
-- sit among the comments in the order they happened.
-- kind is 'comment' or 'event'.
ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';

-- The people a pull request is assigned to, and those whose review was
-- asked for: JSON arrays of usernames. `g1t-agent` among the reviewers
-- means a g1t agent was asked.
ALTER TABLE pulls ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pulls ADD COLUMN reviewers TEXT NOT NULL DEFAULT '[]';
