-- ?2 the workspace, ?3 the start of `since` as `YYYY-MM-DDT00:00:00`.
-- What the sessions started since then that count with no pull request
-- cost (pulls.sql counts the rest), by repository, work item and the day
-- each started, one more row than are returned so the caller knows when
-- there were more.
--
-- A session counts with no pull request when neither it nor its root
-- session is tied to one (a subagent tied to none counts with its root's,
-- as pulls.sql has it). Its work items are the ones it claimed, landed by
-- a push whose commit names it (`G1t-Session`) or said it works on (a link,
-- or its own item); a subagent with none has its root's. A work item only
-- named in a prompt does not count. Its cost (sessions with none are left
-- out) is split evenly among them; with none, it counts with its
-- repository alone (item NULL), as does a work item of another workspace.
,
-- Every session of the repositories, with its root session.
anc(id, root) AS (
  SELECT id, id FROM sessions WHERE repo_id IN (SELECT value FROM json_each(?1)) AND parent_id IS NULL
  UNION SELECT s.id, anc.root FROM anc JOIN sessions s ON s.parent_id = anc.id
    WHERE s.repo_id IN (SELECT value FROM json_each(?1))
),
loose(id, repo_id, root, day, usd) AS MATERIALIZED (
  SELECT s.id, s.repo_id, anc.root, substr(s.started_at, 1, 10), s.cost_usd
  FROM anc JOIN sessions s ON s.id = anc.id
  WHERE s.started_at >= ?3 AND s.cost_usd > 0
    AND NOT EXISTS (SELECT 1 FROM tied t WHERE t.session_id = anc.id OR t.session_id = anc.root)
),
-- The work items each of them, or its root, works on.
own(session_id, item_id) AS MATERIALIZED (
  SELECT l.session_id, l.item_id FROM session_links l
    WHERE l.kind = 'item' AND l.via IN ('claim', 'trailer', 'attached')
      AND l.session_id IN (SELECT id FROM loose UNION SELECT root FROM loose)
  UNION SELECT s.id, s.item_id FROM sessions s
    WHERE s.item_id IS NOT NULL AND s.id IN (SELECT id FROM loose UNION SELECT root FROM loose)
),
items_of(id, item_id) AS (
  SELECT l.id, o.item_id FROM loose l JOIN own o ON o.session_id = l.id
  UNION SELECT l.id, o.item_id FROM loose l JOIN own o ON o.session_id = l.root
    WHERE l.root != l.id AND NOT EXISTS (SELECT 1 FROM own x WHERE x.session_id = l.id)
),
n(id, items) AS (SELECT id, COUNT(*) FROM items_of GROUP BY id)
SELECT l.repo_id, i.number AS item, l.day, TOTAL(l.usd / COALESCE(n.items, 1)) AS session_cost_usd
FROM loose l LEFT JOIN items_of o ON o.id = l.id LEFT JOIN n ON n.id = l.id
  LEFT JOIN work_items i ON i.id = o.item_id AND i.workspace = ?2
GROUP BY l.repo_id, i.number, l.day
ORDER BY l.day DESC, l.repo_id, i.number
LIMIT 3001
