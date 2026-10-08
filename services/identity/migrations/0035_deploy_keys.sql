-- Deploy keys: SSH keys that reach one repository, read-only unless whoever
-- added them allowed write access. See src/deploy_keys.rs.
--
-- `repo_id` is the repository's id, so a rename or a transfer keeps its
-- keys; the path is looked up when a key is used. `workspace_id` is the
-- workspace it was added in. `created_by` is the user (or, for a
-- workspace's token, the workspace) that added it. `read_only` is 1 or 0.
CREATE TABLE deploy_keys (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  read_only INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX deploy_keys_repo ON deploy_keys (repo_id);

-- When a person's SSH key was last used to sign in over SSH, to within 5
-- minutes. Null until it is.
ALTER TABLE ssh_keys ADD COLUMN last_used_at TEXT;

-- A public key means one thing: it is someone's SSH key or one
-- repository's deploy key, never both. The services check first and say
-- "Key is already in use."; these keep two adds at once from both landing.
CREATE TRIGGER deploy_keys_not_ssh_keys BEFORE INSERT ON deploy_keys
WHEN EXISTS (SELECT 1 FROM ssh_keys WHERE fingerprint = NEW.fingerprint)
BEGIN
  SELECT RAISE(ABORT, 'Key is already in use.');
END;

CREATE TRIGGER ssh_keys_not_deploy_keys BEFORE INSERT ON ssh_keys
WHEN EXISTS (SELECT 1 FROM deploy_keys WHERE fingerprint = NEW.fingerprint)
BEGIN
  SELECT RAISE(ABORT, 'Key is already in use.');
END;
