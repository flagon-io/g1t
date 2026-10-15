-- A repository has no description: its project has (projects 0014 copied
-- every one across). Nothing has read or written this column since #45
-- shipped, so it goes.
ALTER TABLE repos DROP COLUMN description;
