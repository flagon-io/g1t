-- Provider cost reports (src/provider_costs.rs): a workspace's AI
-- provider admin key, and what that provider's own cost report says the
-- organization spent, by day.

-- One per workspace and provider. The key is sealed with BILLING_KEY,
-- bound to the row's id; `hint` is its last four characters, the only
-- part ever shown.
CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  provider TEXT NOT NULL,
  credential TEXT NOT NULL,
  hint TEXT NOT NULL,
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_synced_at TEXT,
  last_error TEXT,
  -- YYYY-MM-DD: the first day asked for. Unset until the first read,
  -- which goes back 90 days.
  synced_from TEXT,
  UNIQUE (workspace, provider)
);

-- What the provider reported, per UTC day, line item (Anthropic's
-- description, OpenAI's line item) and the provider's own workspace or
-- project (`scope`, empty for its default). Each read replaces the days
-- it covers, since providers revise recent days.
CREATE TABLE provider_costs (
  workspace TEXT NOT NULL,
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  item TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  micros INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  synced_at TEXT NOT NULL,
  PRIMARY KEY (workspace, provider, day, item, scope)
);

CREATE INDEX provider_costs_by_day ON provider_costs (workspace, day);
