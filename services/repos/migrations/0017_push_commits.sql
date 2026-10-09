-- Commits people pushed, for the contribution calendar on their profile
-- (src/push_commits.rs). One row per person, repository and UTC day: how
-- many pushes landed on the default branch (or gh-pages) and how many new
-- commits they brought along its first-parent line, at most 50 a push.
-- Credited to whoever pushed, as a person; tokens of agents, workspaces and
-- workflow jobs are not counted. Work's `contributions` reads it through
-- `commit_days`, which counts only repositories the viewer may read.
CREATE TABLE push_commits (
  user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- YYYY-MM-DD, UTC.
  day TEXT NOT NULL,
  pushes INTEGER NOT NULL DEFAULT 0,
  commits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, repo_id)
);
