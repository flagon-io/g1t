-- A project's description no longer follows its repository's (0014 made each
-- one its own), and nothing has read or written repo_description since #45
-- shipped, so it goes.
ALTER TABLE projects DROP COLUMN repo_description;
