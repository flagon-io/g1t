-- What the build found the project to be: `workers` (a Workers config),
-- `static` (a site its build wrote) or `html` (its own files, served as
-- they are). Shown on the project's deployment settings. Null for builds
-- that did not finish, or finished before this was kept.
ALTER TABLE deployments ADD COLUMN detected TEXT;
