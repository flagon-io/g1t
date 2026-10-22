-- ?2 the workspace. Open pull requests (not drafts) no person has given a
-- first review yet, oldest first: their work item's number, and the
-- numbers of the workspace's open work items blocked by it, as a JSON
-- array.
SELECT pr.repo_id, pr.number, pr.title, pr.created_at, pr.agent, pr.agent_rule, pr.draft_seconds,
  i.number AS item,
  CASE WHEN i.id IS NULL THEN '[]' ELSE (SELECT json_group_array(number) FROM (
    SELECT b.number FROM work_items b
    WHERE b.workspace = ?2 AND b.state = 'open' AND b.number IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(b.blocked_by) j WHERE j.value = i.id)
    ORDER BY b.number)) END AS blocks
FROM pr LEFT JOIN work_items i ON i.id = pr.item_id AND i.workspace = ?2
WHERE pr.status = 'open' AND NOT EXISTS (SELECT 1 FROM comments cm
  WHERE cm.repo_id = pr.repo_id AND cm.number = pr.number
    AND cm.verdict IN ('approve', 'request_changes')
    AND cm.author_id != pr.owner_id AND cm.author_id != 'usr_g1t_agent' AND cm.agent_id IS NULL)
ORDER BY pr.created_at, pr.repo_id, pr.number
LIMIT 50
