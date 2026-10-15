-- Only projects have descriptions; a repository no longer keeps one. A
-- project that was following its repository's description keeps the text it
-- showed, as its own. `repo_description` is no longer read or written, and
-- goes in a later migration once no running code reads it.
UPDATE projects SET description = repo_description
WHERE description IS NULL AND repo_description IS NOT NULL AND trim(repo_description) <> '';
