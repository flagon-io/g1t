-- Who may use a private repository's actions and reusable workflows from
-- their own workflows (Settings, Actions, Access): `none` (the default:
-- only the repository itself) or `organization` (any private repository in
-- the same workspace). Null is `none`. A public repository's are anyone's,
-- whatever this says. See src/reach.rs.
ALTER TABLE repo_settings ADD COLUMN access_level TEXT;
