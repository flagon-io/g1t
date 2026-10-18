-- Each workspace's floor: the highest number any of its repositories used
-- on its own before work items moved to the workspace (a pull request
-- opened by then, or an old issue's number). Numbers above it are the
-- workspace's alone; at or below it, `#N` read in the workspace may be any
-- of its repositories' old pull requests, so it names none of them from
-- elsewhere (items/refs.rs). The job sets it from here on
-- (items/migration.rs `place_sql`); this sets it for workspaces that moved
-- before, as `RAISE_FLOORS` does.
ALTER TABLE work_counters ADD COLUMN floor INTEGER NOT NULL DEFAULT 0;

UPDATE work_counters SET floor = MAX(floor,
       COALESCE((SELECT MAX(p.number) FROM pulls p JOIN repo_workspaces rw ON rw.repo_id = p.repo_id
                 WHERE rw.workspace = work_counters.workspace
                   AND p.created_at <= COALESCE((SELECT done_at FROM work_jobs WHERE name = 'work_items'), '')), 0),
       COALESCE((SELECT MAX(l.legacy_number) FROM work_item_repos l JOIN repo_workspaces rw ON rw.repo_id = l.repo_id
                 WHERE rw.workspace = work_counters.workspace), 0))
WHERE true;

-- The job that records the repositories the first left out: deleted, but
-- still restorable, when it ran. Their work items were placed in their
-- workspace with no path, as private, with their labels and old numbers
-- unmerged (items/migration.rs `migrate_deleted_repos`). It runs once the
-- first is done, and again changes nothing.
INSERT INTO work_jobs (name) VALUES ('deleted_repos');
