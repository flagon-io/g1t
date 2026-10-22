-- Provider cost reports per person, from every provider that has one
-- (src/provider_costs.rs, src/provider_people.rs): OpenAI's costs per
-- user, Cursor's usage events, Amp's daily usage and Devin's ACUs or
-- credits, beside Anthropic's Claude Code report.

-- What a row counts: 'usd', or a provider's own unit ('credits' for Devin
-- Desktop's prompt credits, 'acus' for Devin's), never converted. `micros`
-- is millionths of it. `list_price` is 1 when the provider gave tokens only
-- and g1t priced them at list price (OpenAI, where its costs can't be split
-- by person); 0 for the provider's own figure.
ALTER TABLE provider_person_costs ADD COLUMN unit TEXT NOT NULL DEFAULT 'usd';
ALTER TABLE provider_person_costs ADD COLUMN list_price INTEGER NOT NULL DEFAULT 0;

-- Each conversation Cursor's usage events name, per UTC day and actor:
-- what its requests were charged and how many there were. Cursor's
-- conversation id is the one its hooks give as `conversation_id`, so a
-- session g1t recorded (`sessions.harness_session_id`) can be matched to
-- what Cursor charged for it. Read and replaced with the day's
-- per-person rows.
CREATE TABLE provider_conversations (
  workspace TEXT NOT NULL,
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  conversation TEXT NOT NULL,
  micros INTEGER NOT NULL,
  events INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (workspace, provider, day, actor_kind, actor, conversation)
);

CREATE INDEX provider_conversations_by_conversation ON provider_conversations (workspace, conversation);
