-- A person's issues, for their profile at g1t.sh/u/<name>. Pull requests
-- already have pulls_by_author.
CREATE INDEX IF NOT EXISTS issues_by_author ON issues (author_id, created_at);
