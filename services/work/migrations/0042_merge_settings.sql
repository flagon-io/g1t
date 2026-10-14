-- How a repository's pull requests merge (RepoSettings in
-- crates/contracts/src/work.rs). NULL is the default for each, so rows
-- written before this read as the defaults: merge, squash and rebase on,
-- fast-forward off, merge by default, default messages, updates suggested,
-- auto-merge allowed, branches kept, no sign-off, commit comments on and
-- issues closed by the pull requests that name them.
ALTER TABLE repo_settings ADD COLUMN allow_merge_commit INTEGER;
ALTER TABLE repo_settings ADD COLUMN allow_squash_merge INTEGER;
ALTER TABLE repo_settings ADD COLUMN allow_rebase_merge INTEGER;
ALTER TABLE repo_settings ADD COLUMN allow_fast_forward INTEGER;
-- 'merge', 'squash', 'rebase' or 'fast_forward'.
ALTER TABLE repo_settings ADD COLUMN default_merge_method TEXT;
-- 'default', 'pull_title', 'pull_title_and_description',
-- 'pull_title_and_commits' (squash only) or 'custom'.
ALTER TABLE repo_settings ADD COLUMN merge_commit_message TEXT;
ALTER TABLE repo_settings ADD COLUMN squash_commit_message TEXT;
ALTER TABLE repo_settings ADD COLUMN merge_commit_template TEXT;
ALTER TABLE repo_settings ADD COLUMN squash_commit_template TEXT;
ALTER TABLE repo_settings ADD COLUMN suggest_updating_branches INTEGER;
ALTER TABLE repo_settings ADD COLUMN allow_auto_merge INTEGER;
ALTER TABLE repo_settings ADD COLUMN delete_branch_on_merge INTEGER;
ALTER TABLE repo_settings ADD COLUMN require_web_commit_sign_off INTEGER;
ALTER TABLE repo_settings ADD COLUMN allow_commit_comments INTEGER;
ALTER TABLE repo_settings ADD COLUMN auto_close_issues INTEGER;

-- How a pull request merged, and the commit its merge left the base at.
ALTER TABLE pulls ADD COLUMN merge_method TEXT;
ALTER TABLE pulls ADD COLUMN merge_commit TEXT;
-- A person's request that it merge on its own once it may (JSON: the
-- contract's AutoMerge, with the enabler's account as stored to act as).
ALTER TABLE pulls ADD COLUMN auto_merge TEXT;
-- JSON array of the issue numbers it closes when it merges into the
-- default branch: its issue and those its title and description name.
ALTER TABLE pulls ADD COLUMN closes TEXT;
-- Its branch was deleted after it merged or closed (restorable).
ALTER TABLE pulls ADD COLUMN head_branch_deleted INTEGER NOT NULL DEFAULT 0;
-- The pull requests waiting to merge on their own, for the sweep.
CREATE INDEX pulls_with_auto_merge ON pulls (repo_id) WHERE auto_merge IS NOT NULL;
