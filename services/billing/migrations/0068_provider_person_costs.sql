-- Provider cost reports, per person (src/provider_costs.rs): what
-- Anthropic's Claude Code usage report estimates each person's (or API
-- key's) use cost, per UTC day and model, read with the workspace's
-- Anthropic connection.

-- One row per day, actor and model, summed over the report's rows for
-- them (remote and local use, terminals and customer types come back as
-- separate rows). `actor` is the address, lowercased, for a user
-- (`actor_kind` 'user'), or the key's name for an API key ('api_key').
-- Nothing here names a g1t account: identity matches addresses to
-- members through the ones they have confirmed, when asked.
--
-- `sessions` is the report's session count for the actor's whole day,
-- which it does not split by model: it is kept on the day's first model
-- row (by name) and is 0 on the others, so summing any rows never counts
-- a day's sessions twice. A day with sessions and no cost has one row
-- with an empty model. `customer_type` is the report's (api,
-- subscription), several joined with a comma.
--
-- Each read replaces the days it asked for, since the report is revised.
CREATE TABLE provider_person_costs (
  workspace TEXT NOT NULL,
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  harness TEXT NOT NULL DEFAULT 'claude_code',
  model TEXT NOT NULL DEFAULT '',
  micros INTEGER NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  customer_type TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL,
  PRIMARY KEY (workspace, provider, day, actor_kind, actor, harness, model)
);

CREATE INDEX provider_person_costs_by_day ON provider_person_costs (workspace, day);

-- The per-person report is read alongside the cost report but kept apart
-- from it: an organization without Claude Code data, or a key that can't
-- read it, leaves the cost report working. As last_synced_at, last_error
-- and synced_from, for this report.
ALTER TABLE provider_connections ADD COLUMN people_synced_at TEXT;
ALTER TABLE provider_connections ADD COLUMN people_error TEXT;
ALTER TABLE provider_connections ADD COLUMN people_synced_from TEXT;
