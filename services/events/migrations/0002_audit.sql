-- The audit log: every action taken with a run credential, and every
-- change people and workspace tokens make through the API and git, with
-- whether it was allowed and the rule that decided. Append-only: nothing
-- updates or deletes a row except a workspace rename, which moves its
-- rows to the new slug. Ids are time-sortable.
CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,
  -- RFC 3339 UTC.
  time TEXT NOT NULL,
  -- The workspace's slug: whose log it is in.
  workspace TEXT NOT NULL,
  -- person | agent | workspace
  actor_kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  agent TEXT,
  on_behalf_of TEXT,
  run_id TEXT,
  run_kind TEXT,
  credential_id TEXT,
  -- An operation, such as create_issue, or git.push / git.fetch.
  action TEXT NOT NULL,
  -- rest | mcp | git
  surface TEXT NOT NULL,
  -- owner/name
  repo TEXT,
  number INTEGER,
  git_ref TEXT,
  path TEXT,
  -- allowed | denied
  outcome TEXT NOT NULL,
  rule TEXT NOT NULL,
  -- ok, or the failure's code
  result TEXT,
  message TEXT,
  request_id TEXT NOT NULL
);
CREATE INDEX audit_workspace ON audit_entries (workspace, id);
CREATE INDEX audit_run ON audit_entries (run_id, id) WHERE run_id IS NOT NULL;
CREATE INDEX audit_target ON audit_entries (repo, number, id) WHERE repo IS NOT NULL;
