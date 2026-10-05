-- What of a month's embedding cost is charged: only private text's. Public
-- repositories' text, and searches, are never charged. Billing is told this
-- figure (`note_pending`, source `context`).
ALTER TABLE usage ADD COLUMN billable_micros INTEGER NOT NULL DEFAULT 0;
