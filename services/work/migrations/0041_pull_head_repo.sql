-- A pull request opened from a branch of someone's fork of the repository
-- (a repository whose parent_id chain reaches it): which fork. Its branch
-- is source_branch, as for a branch of the repository itself. Unlike
-- fork_repo_id (a working copy made for one pull request, so unique), a
-- fork holds many pull requests' branches.
ALTER TABLE pulls ADD COLUMN head_repo_id TEXT;
ALTER TABLE pulls ADD COLUMN head_namespace TEXT;
ALTER TABLE pulls ADD COLUMN head_name TEXT;
-- A push to a fork's branch moves the pull requests opened from it.
CREATE INDEX pulls_by_head_repo ON pulls (head_repo_id, source_branch);

-- Whether issues can be opened in a repository: NULL for the default, on
-- for a repository and off for a fork of one.
ALTER TABLE repo_settings ADD COLUMN has_issues INTEGER;
