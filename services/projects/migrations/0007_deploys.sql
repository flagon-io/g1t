-- Whether a project deploys (an app) or not (a library or a tool), so its
-- pages offer production or releases. `deploys` is the setting: auto, yes
-- or no. On auto the kind is worked out from the columns after it, which
-- the service keeps (services/projects/src/kind.ts).
ALTER TABLE projects ADD COLUMN deploys TEXT NOT NULL DEFAULT 'auto';

-- What the manifests at its root say, read at `detected_commit` of the
-- default branch: app, library, or null when none says. '' for the commit
-- of a repository with no commits yet; null until first read.
ALTER TABLE projects ADD COLUMN detected_kind TEXT;
ALTER TABLE projects ADD COLUMN detected_detail TEXT;
ALTER TABLE projects ADD COLUMN detected_ecosystem TEXT;
ALTER TABLE projects ADD COLUMN detected_commit TEXT;

-- A package its repository publishes, other than a container image, as
-- `Composer package psr/log`; null for none. Kept from package events.
ALTER TABLE projects ADD COLUMN linked_package TEXT;

-- Whether Deployments are on for it, kept from the deployments service;
-- null until it has said.
ALTER TABLE projects ADD COLUMN deployments_on INTEGER;
