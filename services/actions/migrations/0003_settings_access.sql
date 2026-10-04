-- Secrets and variables become one list, as Vercel's environment variables
-- are: each row is a key, its type (secret or config), the environments it
-- applies to and who reads it. A key may have one row per environment, so
-- the unique (owner, kind, name) constraint goes; the service keeps a
-- key's rows from overlapping. Existing rows keep working exactly as before:
-- every environment, read by workflows alone, so nothing reaches
-- deployments until someone says it should.

CREATE TABLE settings_v2 (
  id TEXT PRIMARY KEY,
  -- repository or workspace.
  scope TEXT NOT NULL,
  -- The repository's id, or the workspace's slug.
  owner TEXT NOT NULL,
  -- secret or variable (shown as Config). A variable may become a secret;
  -- a secret never becomes a variable.
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  -- A secret's is sealed, bound to the row's id.
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- workflows and deployments, comma-separated.
  available_to TEXT NOT NULL DEFAULT 'workflows,deployments',
  -- The environments it applies to, comma-separated (production, preview,
  -- or a workflow job's `environment:`). Empty is every environment.
  environments TEXT NOT NULL DEFAULT '',
  -- A workspace's row: the repositories it reaches, as a JSON array of
  -- names. Null is every repository.
  repositories TEXT,
  -- Where to rotate it, or who to ask.
  note TEXT,
  updated_by TEXT
);

INSERT INTO settings_v2 (id, scope, owner, kind, name, value, updated_at, available_to)
  SELECT id, scope, owner, kind, name, value, updated_at, 'workflows' FROM settings;
DROP TABLE settings;
ALTER TABLE settings_v2 RENAME TO settings;
CREATE INDEX settings_by_owner ON settings (owner, name);
