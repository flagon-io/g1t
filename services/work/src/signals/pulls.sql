-- ?2 the workspace, ?3 the start of `since` as `YYYY-MM-DDT00:00:00`.
-- Pull requests opened or merged since then, newest first, one more than
-- are returned so the caller knows when there were more. A pull
-- request's milestone is its work item's, else its own when that is one
-- of the workspace's (until the move to work items finishes, a pull
-- request may still hold its repository's old number).
--
-- A pull request's session cost is its share of what its sessions cost:
-- the sessions tied to it as `tied` ties them, and the subagents of those
-- that are not tied to anything themselves (a subagent counts with its
-- root session's ties). Each session's own cost (NULL as 0) is split
-- evenly among the pull requests it counts with.
,
-- Every session of the repositories, with its root session.
anc(id, root) AS (
  SELECT id, id FROM sessions WHERE repo_id IN (SELECT value FROM json_each(?1)) AND parent_id IS NULL
  UNION SELECT s.id, anc.root FROM anc JOIN sessions s ON s.parent_id = anc.id
    WHERE s.repo_id IN (SELECT value FROM json_each(?1))
),
-- The pull requests each session counts with.
counts_with(session_id, pull_id) AS MATERIALIZED (
  SELECT session_id, pull_id FROM tied
  UNION SELECT anc.id, t.pull_id FROM anc JOIN tied t ON t.session_id = anc.root
    WHERE anc.id != anc.root AND NOT EXISTS (SELECT 1 FROM tied o WHERE o.session_id = anc.id)
),
share(pull_id, usd) AS (
  SELECT c.pull_id, TOTAL(COALESCE(s.cost_usd, 0) / n.pulls)
  FROM counts_with c JOIN sessions s ON s.id = c.session_id
    JOIN (SELECT session_id, COUNT(*) AS pulls FROM counts_with GROUP BY session_id) n ON n.session_id = c.session_id
  GROUP BY c.pull_id
)
SELECT pr.repo_id, pr.number, pr.title, pr.status, pr.agent, pr.agent_rule, pr.owner_id, pr.owner_name,
  pr.created_at, pr.merged_at, i.number AS item,
  COALESCE(i.milestone,
    (SELECT m.number FROM milestones m WHERE m.workspace = ?2 AND m.number = pr.milestone)) AS milestone,
  COALESCE(share.usd, 0.0) AS session_cost_usd
FROM pr LEFT JOIN work_items i ON i.id = pr.item_id AND i.workspace = ?2
  LEFT JOIN share ON share.pull_id = pr.id
WHERE pr.created_at >= ?3 OR (pr.status = 'merged' AND pr.merged_at >= ?3)
ORDER BY pr.created_at DESC, pr.repo_id, pr.number DESC
LIMIT 3001
