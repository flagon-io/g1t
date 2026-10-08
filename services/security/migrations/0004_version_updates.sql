-- Version updates, from the dependency update file (dependabot.yml,
-- version 2): when each entry is next checked, the pull requests g1t makes
-- for them (and for grouped security updates), and the ignore conditions
-- people set with `@g1t ignore …` comments.

-- One row per `updates` entry, keyed by its id (ecosystem, directories and
-- target branch). Rows of entries no longer in the file are removed when
-- it is read again.
CREATE TABLE update_runs (
  repo_id TEXT NOT NULL,
  entry TEXT NOT NULL,
  -- When it is next checked; null when it is not (an ecosystem g1t does
  -- not update, `open-pull-requests-limit: 0`, or a file with problems).
  next_run_at TEXT,
  last_checked_at TEXT,
  -- What the last check found, in a sentence, and why it failed if it did.
  last_result TEXT,
  last_error TEXT,
  -- Set while a check runs, so two sweeps do not both take it.
  running_at TEXT,
  PRIMARY KEY (repo_id, entry)
);
CREATE INDEX update_runs_due ON update_runs (next_run_at);

-- A pull request g1t makes to update dependencies: a version update, or a
-- security update that a `groups` rule with `applies-to: security-updates`
-- gathers (security updates for one package stay in `updates`).
--   kind: version | security
--   state: requested | open | merged | closed | superseded | needs_code | failed
CREATE TABLE update_pulls (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entry TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  -- What it is about whatever versions it reaches (a group, or one
  -- dependency in one directory), and the versions it reaches.
  subject TEXT NOT NULL,
  signature TEXT NOT NULL,
  group_name TEXT,
  branch TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- JSON: the dependencies (UpdatedDependency), and the bump it was made
  -- with, so a rebase makes it again the same way.
  dependencies TEXT NOT NULL,
  bump TEXT NOT NULL,
  -- JSON lists of usernames to assign and to ask for review once it opens.
  assignees TEXT NOT NULL DEFAULT '[]',
  reviewers TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  pull INTEGER,
  issue INTEGER,
  -- The commit g1t last pushed to its branch: another means someone else pushed.
  head TEXT,
  -- Who asked for it to merge once its checks pass (`@g1t merge`), as JSON.
  merge_by TEXT,
  error TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX update_pulls_repo ON update_pulls (repo_id, state);
CREATE INDEX update_pulls_branch ON update_pulls (repo_id, branch);
CREATE INDEX update_pulls_pull ON update_pulls (repo_id, pull);
CREATE INDEX update_pulls_state ON update_pulls (state, updated_at);

-- Dependencies, or some of their versions, skipped because someone said so
-- in a comment. `condition` is what makes each one: '' for the whole
-- dependency, else its versions or its update type.
CREATE TABLE update_ignores (
  repo_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  dependency TEXT NOT NULL,
  condition TEXT NOT NULL,
  versions TEXT,
  update_type TEXT,
  by TEXT NOT NULL,
  pull INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_id, ecosystem, dependency, condition)
);
