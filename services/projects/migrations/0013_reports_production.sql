-- Whether a successful production deployment that g1t.page did not build
-- (a workflow job's with an `environment:`, or one reported through the
-- API) has been seen for the project: an app nobody has placed then
-- deploys itself (src/kind.ts). Null until one has.
ALTER TABLE projects ADD COLUMN reports_production INTEGER;
