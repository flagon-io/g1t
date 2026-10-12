-- How a self-hosted runner keeps work from its machine, as it said when it
-- registered: nested-container, container or host. Null for runners that
-- registered before runners said so.
ALTER TABLE runners ADD COLUMN isolation TEXT;
