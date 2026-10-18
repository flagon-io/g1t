-- ?2 the workspace, ?3 the start of `since` as `YYYY-MM-DDT00:00:00`.
-- Pull requests opened or merged since then, newest first, one more than
-- are returned so the caller knows when there were more. A pull
-- request's milestone is its work item's, else its own when that is one
-- of the workspace's (until the move to work items finishes, a pull
-- request may still hold its repository's old number).
SELECT pr.repo_id, pr.number, pr.title, pr.status, pr.agent, pr.owner_id, pr.owner_name,
  pr.created_at, pr.merged_at, i.number AS item,
  COALESCE(i.milestone,
    (SELECT m.number FROM milestones m WHERE m.workspace = ?2 AND m.number = pr.milestone)) AS milestone
FROM pr LEFT JOIN work_items i ON i.id = pr.item_id AND i.workspace = ?2
WHERE pr.created_at >= ?3 OR (pr.status = 'merged' AND pr.merged_at >= ?3)
ORDER BY pr.created_at DESC, pr.repo_id, pr.number DESC
LIMIT 3001
