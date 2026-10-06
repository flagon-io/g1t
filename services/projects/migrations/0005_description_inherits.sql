-- A project's description follows its repository's until someone gives the
-- project one of its own. `description` now holds only that own text (null:
-- follow the repository); `repo_description` is the repository's, kept from
-- repos like its visibility and default branch.
ALTER TABLE projects ADD COLUMN repo_description TEXT;

-- Primary projects were made from their repository (from repo.created or a
-- backfill) with its description copied in. Whether a person later edited
-- that copy is not recorded: settings saved the description field with every
-- change of name or root directory, so updated_at does not tell. Every
-- primary project follows its repository from here; its copy seeds
-- repo_description until the backfill below reads the repository's current
-- one. Other projects were made by a person, who gave their description:
-- theirs stays their own.
UPDATE projects SET repo_description = description, description = NULL WHERE is_primary = 1;

-- Every workspace's projects are read from repos once more, on their next
-- listing, so repo_description is the repository's description as it is now.
DELETE FROM backfilled;
