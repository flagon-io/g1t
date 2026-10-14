-- A workspace's AI providers are not integrations: they move out of
-- `connections` into a table of their own, and what Ask answers with into
-- `ai_routes`. Ids stay as they are, so sealed keys (bound to the id) still
-- open, and managed_agents and agent_runs still find their provider.

CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY,
  -- The workspace's slug.
  workspace TEXT NOT NULL,
  -- anthropic, openai, …, anthropic_endpoint or openai_endpoint
  -- (g1t_contracts::ai::AiProvider).
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Its address, key header and model, as JSON. Never its key.
  config TEXT NOT NULL,
  -- Its key, as JSON sealed with AES-256-GCM under the service's key and
  -- bound to the id. Never returned.
  secrets TEXT,
  -- The last four characters of the key, to tell keys apart.
  secret_hint TEXT,
  -- The models it offered when last checked, as a JSON array.
  models TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  last_error TEXT
);
CREATE INDEX ai_providers_by_workspace ON ai_providers (workspace, id);

INSERT INTO ai_providers
  (id, workspace, provider, name, config, secrets, secret_hint, models, created_by, created_at, last_used_at, last_error)
SELECT id, workspace, provider, name, config, secrets, secret_hint, models, created_by, created_at, last_used_at, last_error
FROM connections
WHERE provider IN (
  'anthropic', 'openai', 'gemini', 'xai', 'mistral', 'deepseek', 'azure_openai', 'openrouter', 'groq',
  'together', 'fireworks', 'cerebras', 'anthropic_endpoint', 'openai_endpoint'
);

DELETE FROM connections WHERE id IN (SELECT id FROM ai_providers);

-- What each kind of AI work in a workspace answers with. Only `ask` is
-- used: the other tasks were for g1t's hosted agents, which are gone.
CREATE TABLE ai_routes (
  workspace TEXT NOT NULL,
  task TEXT NOT NULL,
  -- One of the workspace's ai_providers.
  provider_id TEXT NOT NULL,
  -- The model chosen; not read with `auto`.
  model TEXT,
  -- 1: Auto, a model of the provider's for each question.
  auto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, task)
);

INSERT INTO ai_routes (workspace, task, provider_id, model, auto)
SELECT workspace, task, connection_id, model, auto
FROM model_routes
WHERE task = 'ask' AND connection_id IN (SELECT id FROM ai_providers);

DROP TABLE model_routes;
