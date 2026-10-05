-- Guardrails: what a workspace lets its agents do in a sandbox. One row
-- for the workspace's defaults (scope 'workspace', scope_key its slug) and
-- one per project that overrides them (scope 'project', scope_key its
-- repository's id). A missing row inherits everything.
CREATE TABLE guardrails (
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  -- The workspace's slug, for renames.
  workspace TEXT NOT NULL,
  -- JSON: g1t_contracts::guardrails::GuardrailSettings, unset fields inherited.
  settings TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_key)
);
CREATE INDEX guardrails_by_workspace ON guardrails (workspace);

-- The caps a run started with, and which one stopped it.
ALTER TABLE agent_runs ADD COLUMN budget_usd REAL;
ALTER TABLE agent_runs ADD COLUMN time_cap_minutes INTEGER;
-- budget or time, when g1t stopped it for reaching that cap.
ALTER TABLE agent_runs ADD COLUMN halted TEXT;
