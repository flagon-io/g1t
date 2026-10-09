-- Project-to-project dependencies were removed (2026-10-09): nothing reads
-- this table any more. Dropped a deploy after the code that read it left,
-- since migrations run before code is deployed.
DROP INDEX IF EXISTS dependencies_by_target;
DROP TABLE IF EXISTS dependencies;
