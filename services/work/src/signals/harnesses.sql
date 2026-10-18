-- ?1 the repositories' ids as a JSON array. Each person's root sessions
-- (a subagent is its parent's) in each repository over its whole history,
-- by harness: when they first started one and how many, under the name on
-- their latest session there. Agents and g1t are left out by the caller
-- (signals.rs `is_person`).
WITH r AS (
  SELECT repo_id, actor_id, actor_name, harness, started_at FROM sessions
  WHERE repo_id IN (SELECT value FROM json_each(?1)) AND parent_id IS NULL
),
-- The name on each one's latest session (SQLite takes the bare column from
-- the row MAX picks).
named AS (
  SELECT repo_id, actor_id, actor_name, MAX(started_at) FROM r GROUP BY repo_id, actor_id
)
SELECT r.repo_id, r.actor_id AS owner_id, named.actor_name AS owner_name, r.harness,
  MIN(r.started_at) AS first_at, COUNT(*) AS sessions
FROM r JOIN named ON named.repo_id = r.repo_id AND named.actor_id = r.actor_id
GROUP BY r.repo_id, r.actor_id, r.harness
ORDER BY r.repo_id, first_at, r.harness
