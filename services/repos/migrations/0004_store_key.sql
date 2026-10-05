-- Where each repository is kept in the git store. It was always
-- "<namespace>--<name>", worked out from the path; a workspace can now be
-- renamed, which changes the path but cannot move what the store holds, so
-- the key is kept as it was given. New repositories get the same form,
-- unless another repository already holds that key (one whose workspace
-- used to have this name), when they get their id.
ALTER TABLE repos ADD COLUMN store TEXT;
UPDATE repos SET store = namespace || '--' || name;
CREATE UNIQUE INDEX repos_by_store ON repos (store);
