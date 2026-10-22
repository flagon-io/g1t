-- ?1 the workspace, ?2 the first day as `YYYY-MM-DDT00:00:00`, ?3 the day
-- after the last the same way, ?4 the person's id. What their sessions
-- (subagents and all) that started from ?2 to ?3 in the workspace's
-- repositories cost, by day, repository, work item, harness, model and
-- landed.
--
-- A session counts with the pull requests it is tied to (as base.sql's
-- `tied` ties them), else, for a subagent tied to none, its root
-- session's; with none, with the work items it or its root works on, as
-- signals/sessions.sql has it. Its cost (NULL as 0) is split evenly
-- among them. A share landed when its pull request merged, or for a work
-- item, when a push landed it whose commit names the session or its root.
WITH mine AS MATERIALIZED (
  SELECT s.id, s.repo_id, s.harness, s.model, s.cost_usd, substr(s.started_at, 1, 10) AS day
  FROM sessions s JOIN repo_workspaces rw ON rw.repo_id = s.repo_id AND rw.workspace = ?1
  WHERE s.actor_id = ?4 AND s.started_at >= ?2 AND s.started_at < ?3
),
-- Each of them with its root session.
up(id, cur) AS (
  SELECT id, id FROM mine
  UNION SELECT up.id, s.parent_id FROM up JOIN sessions s ON s.id = up.cur WHERE s.parent_id IS NOT NULL
),
roots(id, root) AS MATERIALIZED (
  SELECT up.id, up.cur FROM up JOIN sessions s ON s.id = up.cur WHERE s.parent_id IS NULL
),
asked(id) AS MATERIALIZED (SELECT id FROM mine UNION SELECT root FROM roots),
pulled(session_id, pull_id) AS MATERIALIZED (
  SELECT l.session_id, p.id FROM session_links l JOIN pulls p ON p.repo_id = l.repo_id AND p.number = l.number
    WHERE l.kind = 'pull' AND l.session_id IN (SELECT id FROM asked)
  UNION SELECT s.id, p.id FROM sessions s JOIN pulls p ON p.repo_id = s.repo_id AND p.number = s.pull
    WHERE s.id IN (SELECT id FROM asked)
  UNION SELECT t.session_id, p.id FROM session_touches t
    JOIN pulls p ON p.repo_id = t.repo_id AND p.source_branch = t.value AND p.fork_repo_id IS NULL AND p.head_repo_id IS NULL
    WHERE t.kind = 'branch' AND t.session_id IN (SELECT id FROM asked)
),
pulls_of(id, pull_id) AS MATERIALIZED (
  SELECT m.id, x.pull_id FROM mine m JOIN pulled x ON x.session_id = m.id
  UNION SELECT m.id, x.pull_id FROM mine m JOIN roots r ON r.id = m.id JOIN pulled x ON x.session_id = r.root
    WHERE r.root != m.id AND NOT EXISTS (SELECT 1 FROM pulled o WHERE o.session_id = m.id)
),
own(session_id, item_id) AS MATERIALIZED (
  SELECT l.session_id, l.item_id FROM session_links l
    WHERE l.kind = 'item' AND l.via IN ('claim', 'trailer', 'attached') AND l.session_id IN (SELECT id FROM asked)
  UNION SELECT s.id, s.item_id FROM sessions s WHERE s.item_id IS NOT NULL AND s.id IN (SELECT id FROM asked)
),
items_of(id, item_id) AS (
  SELECT m.id, o.item_id FROM mine m JOIN own o ON o.session_id = m.id
    WHERE NOT EXISTS (SELECT 1 FROM pulls_of x WHERE x.id = m.id)
  UNION SELECT m.id, o.item_id FROM mine m JOIN roots r ON r.id = m.id JOIN own o ON o.session_id = r.root
    WHERE r.root != m.id AND NOT EXISTS (SELECT 1 FROM own x WHERE x.session_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM pulls_of x WHERE x.id = m.id)
),
share(id, item_id, landed) AS MATERIALIZED (
  SELECT x.id, p.item_id, p.status = 'merged' FROM pulls_of x JOIN pulls p ON p.id = x.pull_id
  UNION ALL SELECT i.id, i.item_id, EXISTS (SELECT 1 FROM session_links l JOIN roots r ON r.id = i.id
      WHERE l.session_id IN (i.id, r.root) AND l.kind = 'item' AND l.via = 'trailer' AND l.item_id = i.item_id)
    FROM items_of i
),
n(id, k) AS (SELECT id, COUNT(*) FROM share GROUP BY id)
SELECT m.day, m.repo_id, rw.path AS repo, w.number AS item, m.harness, m.model, COALESCE(sh.landed, 0) AS landed,
  COUNT(DISTINCT m.id) AS sessions, TOTAL(COALESCE(m.cost_usd, 0) / COALESCE(n.k, 1)) AS cost_usd
FROM mine m JOIN repo_workspaces rw ON rw.repo_id = m.repo_id
  LEFT JOIN share sh ON sh.id = m.id LEFT JOIN n ON n.id = m.id
  LEFT JOIN work_items w ON w.id = sh.item_id AND w.workspace = ?1
GROUP BY m.day, m.repo_id, w.number, m.harness, m.model, COALESCE(sh.landed, 0)
ORDER BY cost_usd DESC, m.day DESC
LIMIT 5001
