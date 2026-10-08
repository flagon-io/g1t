-- Teams asked to review, code owners, and the protection rule that waits
-- for them. See src/codeowners.rs and src/team_reviews.rs. Every
-- timestamp is RFC 3339 UTC. The ALTERs must run once, as in 0007; the
-- tables and indexes say IF NOT EXISTS.

-- The teams asked to review a pull request, as a JSON array of
-- `workspace/slug`. People review assignment picks from a team are in
-- `reviewers` beside it.
ALTER TABLE pulls ADD COLUMN team_reviewers TEXT NOT NULL DEFAULT '[]';

-- Branch protection: merging waits for the code owners' approval.
ALTER TABLE repo_settings ADD COLUMN require_code_owner_review INTEGER NOT NULL DEFAULT 0;

-- Who owns what a pull request changes, as last worked out from the
-- CODEOWNERS file of the branch it merges into: its path, the reviews it
-- needs (JSON, codeowners::Requirement), who answers for each owner (JSON
-- object of owner to usernames), how many errors the file has, and which
-- owners g1t already asked to review, so that a request someone withdrew
-- is not made again on the next push.
CREATE TABLE IF NOT EXISTS pull_code_owners (
  pull_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  requirements TEXT NOT NULL,
  members TEXT NOT NULL,
  errors INTEGER NOT NULL DEFAULT 0,
  requested TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

-- Each person review assignment picked from a team, for round robin
-- (who was asked least recently goes first).
CREATE TABLE IF NOT EXISTS team_review_requests (
  team_id TEXT NOT NULL,
  username TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  requested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_review_requests_team ON team_review_requests (team_id, username, requested_at);
