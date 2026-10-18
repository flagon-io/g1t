-- ?2 and ?3 the first day's start and the day after the last's, as
-- `YYYY-MM-DDT00:00:00`. One row per repository and UTC day that had
-- anything in it. Reviews are comments of any kind on a pull request by a
-- person other than its owner (not g1t's agent, a workspace agent or g1t
-- itself); reworked, the ones of them that ask for changes. Agent commits
-- are those agent sessions pushed outside any pull request (weeks.sql).
,
ev(repo_id, day, opened, merged, agent_merged, reworked, reviews, sessions, agent_commits) AS (
  SELECT repo_id, substr(created_at, 1, 10), 1, 0, 0, 0, 0, 0, 0 FROM pr
    WHERE created_at >= ?2 AND created_at < ?3
  UNION ALL SELECT repo_id, substr(merged_at, 1, 10), 0, 1, agent, 0, 0, 0, 0 FROM pr
    WHERE status = 'merged' AND merged_at >= ?2 AND merged_at < ?3
  UNION ALL SELECT c.repo_id, substr(c.created_at, 1, 10), 0, 0, 0, c.verdict IS 'request_changes', 1, 0, 0
    FROM comments c JOIN pr ON pr.repo_id = c.repo_id AND pr.number = c.number
    WHERE c.repo_id IN (SELECT value FROM json_each(?1)) AND c.created_at >= ?2 AND c.created_at < ?3
      AND c.author_id != pr.owner_id AND c.agent_id IS NULL
      AND c.author_id NOT IN ('usr_g1t_agent', 'g1t', 'g1t_policy', 'svc_runner', 'g1t_runner')
  UNION ALL SELECT repo_id, substr(started_at, 1, 10), 0, 0, 0, 0, 0, 1, 0 FROM sessions
    WHERE repo_id IN (SELECT value FROM json_each(?1)) AND started_at >= ?2 AND started_at < ?3
  UNION ALL SELECT t.repo_id, substr(t.at, 1, 10), 0, 0, 0, 0, 0, 0, COUNT(DISTINCT t.value) FROM session_touches t
    WHERE t.repo_id IN (SELECT value FROM json_each(?1)) AND t.kind = 'commit' AND t.at >= ?2 AND t.at < ?3
      AND t.session_id NOT IN (SELECT session_id FROM tied)
    GROUP BY t.repo_id, substr(t.at, 1, 10)
)
SELECT repo_id, day, SUM(opened) AS opened, SUM(merged) AS merged, SUM(agent_merged) AS agent_merged,
  SUM(reworked) AS reworked, SUM(reviews) AS reviews, SUM(sessions) AS sessions,
  SUM(agent_commits) AS agent_commits
FROM ev GROUP BY repo_id, day ORDER BY day, repo_id
