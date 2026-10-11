-- Who archived an agent (docs.g1t.sh/guides/agents/, "Archive, restore and
-- delete"), by username, so the Archived section and an archived agent's
-- direct message can say so without reading the audit log. NULL for an
-- agent archived before this column, and for a live one.
ALTER TABLE agents ADD COLUMN archived_by TEXT;
