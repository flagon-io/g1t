-- ?1 the repositories' ids as a JSON array; ?2 and ?3 the period's bounds.
-- A first review is the first approval or request for changes from a person
-- other than the pull request's owner: g1t's review agent gives verdicts
-- too, and workspace agents keep theirs in agent_verdict, so neither counts.
WITH selected AS (
  SELECT p.*,
    (SELECT MIN(c.created_at) FROM comments c
     WHERE c.repo_id = p.repo_id AND c.number = p.number
       AND c.verdict IN ('approve', 'request_changes')
       AND c.author_id != COALESCE(p.requested_by_id, p.author_id)
       AND c.author_id != 'usr_g1t_agent' AND c.agent_id IS NULL) AS reviewed_at
  FROM pulls p WHERE p.repo_id IN (SELECT value FROM json_each(?1))
)
SELECT repo_id,
  SUM(created_at >= ?2 AND created_at < ?3) AS opened,
  SUM(status = 'merged' AND merged_at >= ?2 AND merged_at < ?3) AS merged,
  SUM(status IN ('draft', 'open')) AS active,
  SUM(status = 'open' AND reviewed_at IS NULL) AS unreviewed,
  SUM(status IN ('draft', 'open') AND EXISTS (
    SELECT 1 FROM queue_entries q WHERE q.pull_id = selected.id AND q.state IN ('waiting', 'testing', 'passed')
  )) AS queued,
  SUM(CASE WHEN status = 'merged' AND merged_at >= ?2 AND merged_at < ?3
    THEN MAX(0, (julianday(merged_at) - julianday(created_at)) * 86400) ELSE 0 END) AS lead_seconds,
  SUM(CASE WHEN reviewed_at >= ?2 AND reviewed_at < ?3
    THEN MAX(0, (julianday(reviewed_at) - julianday(created_at)) * 86400) ELSE 0 END) AS review_seconds,
  SUM(COALESCE(reviewed_at >= ?2 AND reviewed_at < ?3, 0)) AS reviewed
FROM selected GROUP BY repo_id
