-- ?1 the repositories' ids as a JSON array; ?2 and ?3 the bounds of the 90
-- days ending with `until`. Each owner's merged pull requests in each
-- repository over its whole history, under the name on their latest.
-- Agents and g1t are left out by the caller (signals.rs `is_person`).
WITH m AS (
  SELECT repo_id, COALESCE(requested_by_id, author_id) AS owner_id,
    CASE WHEN requested_by_id IS NULL THEN author_name ELSE requested_by_name END AS owner_name, merged_at
  FROM pulls
  WHERE repo_id IN (SELECT value FROM json_each(?1)) AND status = 'merged' AND merged_at IS NOT NULL
)
SELECT repo_id, owner_id,
  (SELECT n.owner_name FROM m n WHERE n.repo_id = m.repo_id AND n.owner_id = m.owner_id
   ORDER BY n.merged_at DESC LIMIT 1) AS owner_name,
  MIN(merged_at) AS first_merged_at, MAX(merged_at) AS last_merged_at, COUNT(*) AS merged,
  COUNT(CASE WHEN merged_at >= ?2 AND merged_at < ?3 THEN 1 END) AS recent
FROM m GROUP BY repo_id, owner_id ORDER BY repo_id, first_merged_at
