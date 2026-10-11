-- Actions from GitHub, kept on g1t (src/registry.rs): the commit each
-- ref last named, and the archives of commits jobs have used, in R2.
-- Repositories are lowercased, as GitHub reads them.
CREATE TABLE IF NOT EXISTS action_refs (
  repository TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  PRIMARY KEY (repository, ref)
);

CREATE TABLE IF NOT EXISTS action_archives (
  repository TEXT NOT NULL,
  sha TEXT NOT NULL,
  object TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_at TEXT NOT NULL,
  used_at TEXT NOT NULL,
  PRIMARY KEY (repository, sha)
);

CREATE INDEX IF NOT EXISTS action_archives_used ON action_archives (used_at);
