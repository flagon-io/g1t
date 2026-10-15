-- An issue closed by a commit pushed to the default branch whose message
-- names it after a closing keyword (`Fixes #12`; pushed.rs): the commit,
-- and who pushed it. `resolved_by` stays for the pull request that closed
-- one; a commit closes an issue with that left empty.
ALTER TABLE issues ADD COLUMN resolved_commit TEXT;
ALTER TABLE issues ADD COLUMN resolved_pushed_by TEXT;

CREATE INDEX issues_by_resolved_commit ON issues (repo_id, resolved_commit) WHERE resolved_commit IS NOT NULL;
