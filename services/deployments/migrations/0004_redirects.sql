-- An app's old address after its workspace was renamed: the old script
-- stays in the dispatch namespace as a Worker that redirects to the app's
-- new address, for as long as the workspace holds its old slug. The sweep
-- leaves these scripts alone until `expires_at`, then removes them.
CREATE TABLE redirects (
  -- The old script, which is the old hostname's first label on g1t.page.
  script TEXT PRIMARY KEY,
  -- The hostname it redirects to.
  target TEXT NOT NULL,
  -- The workspace's slug now.
  workspace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX redirects_by_expiry ON redirects (expires_at);
