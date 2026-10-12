-- Whether a project builds through the deploy workflow g1t manages for it
-- (a managed workflow in the actions service, `managed/deploy-<project>.yml`)
-- rather than through this service's own build on each push and pull request.
ALTER TABLE settings ADD COLUMN via_workflow INTEGER NOT NULL DEFAULT 0;
