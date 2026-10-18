-- ?2 the weeks as a JSON array of { start, from, to, cut }: the first UTC
-- day, the bounds (from inclusive, to exclusive) and when the week is read
-- as ended for stalled pull requests (to, or now when that is earlier).
--
-- A person's verdict is an approval or request for changes by someone
-- other than the owner, not g1t's review agent, and not a workspace agent
-- (which keeps its verdict apart): the first one is the first review, as
-- insights.sql counts it.
,
w AS (
  SELECT json_extract(value, '$.start') AS start,
    julianday(json_extract(value, '$.from')) AS lo,
    julianday(json_extract(value, '$.to')) AS hi,
    julianday(json_extract(value, '$.cut')) AS cut
  FROM json_each(?2)
),
x AS MATERIALIZED (
  SELECT pr.repo_id, pr.status, pr.agent, pr.draft_seconds,
    julianday(pr.created_at) AS c, julianday(pr.merged_at) AS m, julianday(pr.updated_at) AS u,
    julianday((SELECT MIN(cm.created_at) FROM comments cm
      WHERE cm.repo_id = pr.repo_id AND cm.number = pr.number
        AND cm.verdict IN ('approve', 'request_changes')
        AND cm.author_id != pr.owner_id AND cm.author_id != 'usr_g1t_agent' AND cm.agent_id IS NULL)) AS r,
    -- An agent's merged pull request a person asked for changes on before it merged.
    (pr.agent AND pr.status = 'merged' AND EXISTS (SELECT 1 FROM comments cm
      WHERE cm.repo_id = pr.repo_id AND cm.number = pr.number AND cm.verdict = 'request_changes'
        AND cm.author_id != pr.owner_id AND cm.author_id != 'usr_g1t_agent' AND cm.agent_id IS NULL
        AND julianday(cm.created_at) < julianday(pr.merged_at))) AS reworked
  FROM pr
)
SELECT x.repo_id, w.start,
  COUNT(CASE WHEN x.status = 'merged' AND x.m >= w.lo AND x.m < w.hi THEN 1 END) AS merged,
  COUNT(CASE WHEN x.status = 'merged' AND x.m >= w.lo AND x.m < w.hi AND x.agent THEN 1 END) AS agent_merged,
  COUNT(CASE WHEN x.status = 'merged' AND x.m >= w.lo AND x.m < w.hi AND x.reworked THEN 1 END) AS agent_reworked,
  -- Opened in the week by an agent whose session started first.
  COUNT(CASE WHEN x.agent AND x.draft_seconds IS NOT NULL AND x.c >= w.lo AND x.c < w.hi THEN 1 END) AS agent_drafted,
  TOTAL(CASE WHEN x.agent AND x.c >= w.lo AND x.c < w.hi THEN x.draft_seconds END) AS agent_draft_seconds,
  COUNT(CASE WHEN x.r >= w.lo AND x.r < w.hi THEN 1 END) AS reviewed,
  TOTAL(CASE WHEN x.r >= w.lo AND x.r < w.hi THEN MAX(0, (x.r - x.c) * 86400) END) AS review_seconds,
  -- Open over seven days when the week ended, and not finished by then:
  -- not merged, and not closed (a closed one's updated_at stands in for
  -- when it closed, which pulls do not keep).
  COUNT(CASE WHEN x.c < w.cut - 7
    AND NOT COALESCE(x.m < w.cut, 0)
    AND NOT (x.status = 'closed' AND COALESCE(x.u < w.cut, 0)) THEN 1 END) AS stalled
FROM x CROSS JOIN w
GROUP BY x.repo_id, w.start
HAVING merged + agent_drafted + reviewed + stalled > 0
ORDER BY w.start, x.repo_id
