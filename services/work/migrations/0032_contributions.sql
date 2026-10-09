-- A person's reviews over the last year, for the contribution calendar on
-- their profile (src/contributions.rs). Issues and pull requests already
-- have issues_by_owner and pulls_by_owner.
CREATE INDEX IF NOT EXISTS comments_by_author ON comments (author_id, created_at);
