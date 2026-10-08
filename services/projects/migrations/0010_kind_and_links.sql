-- What a project is and where it runs, set by a person, and its links
-- (services/projects/src/kind.ts, src/links.ts).

-- app, library, tool, docs or other; null leaves it to detection.
ALTER TABLE projects ADD COLUMN kind_setting TEXT;
-- g1t (Deployments on g1t.page) or elsewhere; null leaves it to whether
-- Deployments are on.
ALTER TABLE projects ADD COLUMN runs_setting TEXT;
-- Production's address when it is deployed elsewhere.
ALTER TABLE projects ADD COLUMN production_url TEXT;

-- Its own homepage; null follows `repo_website`, its repository's website,
-- kept from repos like its description.
ALTER TABLE projects ADD COLUMN homepage TEXT;
ALTER TABLE projects ADD COLUMN repo_website TEXT;
ALTER TABLE projects ADD COLUMN docs_url TEXT;
-- Its other links: a JSON list of {"label", "url"}, at most 10.
ALTER TABLE projects ADD COLUMN links TEXT;

-- `deploys` (0007) is replaced by the two settings, keeping what each
-- project does: "Deploys" was an app deploying on g1t; "Doesn't deploy"
-- was a library (or a tool), which a person can now say more exactly.
-- Auto stays auto. The column stays, unread.
UPDATE projects SET kind_setting = 'app', runs_setting = 'g1t' WHERE deploys = 'yes';
UPDATE projects SET kind_setting = 'library' WHERE deploys = 'no';

-- Every workspace's projects are read from repos once more, on their next
-- listing, so repo_website is the repository's website as it is now.
DELETE FROM backfilled;
