-- Labels and milestones of a repository, and pull requests into branches
-- other than the default one.

-- A repository's labels. Issues and pull requests carry them by name, in
-- their `labels` JSON arrays; names are lowercase.
CREATE TABLE labels (
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Six hex digits, without '#'.
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name)
);

-- Pull requests carry labels too.
ALTER TABLE pulls ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';

-- Every label already on an issue becomes one of its repository's labels,
-- with a color chosen as the site chose it before, so nothing in use
-- disappears from the labels page.
INSERT OR IGNORE INTO labels (repo_id, name, color, description, created_at)
SELECT DISTINCT issues.repo_id, json_each.value,
  CASE json_each.value
    WHEN 'bug' THEN 'd73a4a'
    WHEN 'feature' THEN 'a2eeef'
    WHEN 'docs' THEN '0075ca'
    WHEN 'chore' THEN 'fbca04'
    WHEN 'question' THEN 'd876e3'
    ELSE 'bfdadc'
  END,
  '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM issues, json_each(issues.labels)
WHERE trim(json_each.value) != '';

-- Milestones: numbered from 1 in each repository, apart from issues.
CREATE TABLE milestones (
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- YYYY-MM-DD, or NULL.
  due_on TEXT,
  -- open or closed.
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX milestones_by_state ON milestones (repo_id, state, due_on);

-- The milestone an issue or a pull request is in, by number.
ALTER TABLE issues ADD COLUMN milestone INTEGER;
ALTER TABLE pulls ADD COLUMN milestone INTEGER;
CREATE INDEX issues_by_milestone ON issues (repo_id, milestone);
CREATE INDEX pulls_by_milestone ON pulls (repo_id, milestone);

-- The branch a pull request merges into. NULL is the repository's default
-- branch, whichever that is at the time, as every pull request until now.
ALTER TABLE pulls ADD COLUMN base_branch TEXT;
CREATE INDEX pulls_by_base ON pulls (repo_id, base_branch, status);
