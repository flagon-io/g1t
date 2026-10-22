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
    json_extract(value, '$.from') AS lo_at, json_extract(value, '$.to') AS hi_at,
    julianday(json_extract(value, '$.from')) AS lo,
    julianday(json_extract(value, '$.to')) AS hi,
    julianday(json_extract(value, '$.cut')) AS cut
  FROM json_each(?2)
),
-- The earliest and the latest cut.
cuts AS (SELECT MIN(cut) AS lo, MAX(cut) AS hi FROM w),
x AS MATERIALIZED (
  SELECT pr.id, pr.repo_id, pr.number, pr.status, pr.agent, pr.draft_seconds, pr.head_commit,
    julianday(pr.created_at) AS c, julianday(pr.merged_at) AS m, julianday(pr.updated_at) AS u,
    julianday(pr.head_pushed_at) AS pushed,
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
),
-- The pull requests that may be stalled at some cut: opened three days
-- before the latest, and not finished before the earliest (a closed one's
-- updated_at stands in for when it closed, which pulls do not keep).
-- Only their activity is read, each by its own index.
cand AS MATERIALIZED (
  SELECT x.* FROM x, cuts
  WHERE x.c <= cuts.hi - 3 AND NOT COALESCE(x.m < cuts.lo, 0)
    AND NOT (x.status = 'closed' AND COALESCE(x.u < cuts.lo, 0))
),
-- What each of them saw, as spans [t0, t1] (a moment where t0 = t1).
-- CROSS JOIN keeps each read starting from the few candidates. D1 takes
-- at most five terms in one compound SELECT, so the sources are read in
-- two halves of four and joined.
act_a(pull_id, t0, t1) AS MATERIALIZED (
  -- Comments of every kind: reviews, and the timeline's events (labels,
  -- assignees, review requests, milestones, ready, draft, closed,
  -- reopened, base changes, the merge queue, auto-merge, branches deleted
  -- and restored). Pushes are no timeline event.
  SELECT k.id, julianday(cm.created_at), julianday(cm.created_at)
    FROM cand k CROSS JOIN comments cm ON cm.repo_id = k.repo_id AND cm.number = k.number
  -- Its latest push, the only one pulls keep.
  UNION ALL SELECT k.id, k.pushed, k.pushed FROM cand k WHERE k.pushed IS NOT NULL
  -- Entries recorded on it.
  UNION ALL SELECT k.id, julianday(e.at), julianday(e.at) FROM cand k CROSS JOIN session_entries e ON e.pull_id = k.id
  -- Its acceptance checks, from queued to finished.
  UNION ALL SELECT k.id, julianday(cr.created_at), julianday(COALESCE(cr.finished_at, cr.created_at))
    FROM cand k CROSS JOIN check_runs cr ON cr.pull_id = k.id
),
act_b(pull_id, t0, t1) AS MATERIALIZED (
  -- Statuses and check runs on its head commit, the one commit pulls keep
  -- (a status keeps only when it last changed).
  SELECT k.id, julianday(st.updated_at), julianday(st.updated_at)
    FROM cand k CROSS JOIN commit_statuses st ON st.repo_id = k.repo_id AND st.sha = k.head_commit
  UNION ALL SELECT k.id, julianday(ck.created_at), julianday(ck.updated_at)
    FROM cand k CROSS JOIN commit_check_runs ck ON ck.repo_id = k.repo_id AND ck.head_sha = k.head_commit
  -- The sessions tied to it, and their subagents, from start to last
  -- heartbeat: a session that ran then counts, busy or not.
  UNION ALL SELECT k.id, julianday(s.started_at), julianday(s.last_seen_at)
    FROM cand k CROSS JOIN tied t ON t.pull_id = k.id CROSS JOIN sessions s ON s.id = t.session_id
  UNION ALL SELECT k.id, julianday(s.started_at), julianday(s.last_seen_at)
    FROM cand k CROSS JOIN tied t ON t.pull_id = k.id CROSS JOIN sessions s ON s.parent_id = t.session_id
),
act(pull_id, t0, t1) AS (SELECT * FROM act_a UNION ALL SELECT * FROM act_b),
-- Each week a pull request saw something in the three days before its cut.
busy AS MATERIALIZED (
  SELECT DISTINCT a.pull_id, w.start FROM act a JOIN w ON a.t0 < w.cut AND a.t1 >= w.cut - 3
),
pw AS (
  SELECT x.repo_id, w.start,
    COUNT(CASE WHEN x.status = 'merged' AND x.m >= w.lo AND x.m < w.hi THEN 1 END) AS merged,
    COUNT(CASE WHEN x.status = 'merged' AND x.m >= w.lo AND x.m < w.hi AND x.agent THEN 1 END) AS agent_merged,
    COUNT(CASE WHEN x.status = 'merged' AND x.m >= w.lo AND x.m < w.hi AND x.reworked THEN 1 END) AS agent_reworked,
    -- Opened in the week by an agent whose session started first.
    COUNT(CASE WHEN x.agent AND x.draft_seconds IS NOT NULL AND x.c >= w.lo AND x.c < w.hi THEN 1 END) AS agent_drafted,
    TOTAL(CASE WHEN x.agent AND x.c >= w.lo AND x.c < w.hi THEN x.draft_seconds END) AS agent_draft_seconds,
    COUNT(CASE WHEN x.r >= w.lo AND x.r < w.hi THEN 1 END) AS reviewed,
    TOTAL(CASE WHEN x.r >= w.lo AND x.r < w.hi THEN MAX(0, (x.r - x.c) * 86400) END) AS review_seconds,
    0 AS stalled, 0.0 AS session_cost_usd, 0 AS agent_commits
  FROM x CROSS JOIN w
  GROUP BY x.repo_id, w.start
),
-- Open at the cut (not merged, and not closed, before it), opened at
-- least three days before, and nothing in the three days before it.
sx AS (
  SELECT k.repo_id, w.start, 0 AS merged, 0 AS agent_merged, 0 AS agent_reworked, 0 AS agent_drafted,
    0.0 AS agent_draft_seconds, 0 AS reviewed, 0.0 AS review_seconds, COUNT(*) AS stalled, 0.0 AS session_cost_usd, 0 AS agent_commits
  FROM cand k CROSS JOIN w LEFT JOIN busy b ON b.pull_id = k.id AND b.start = w.start
  WHERE b.pull_id IS NULL AND k.c <= w.cut - 3
    AND NOT COALESCE(k.m < w.cut, 0)
    AND NOT (k.status = 'closed' AND COALESCE(k.u < w.cut, 0))
  GROUP BY k.repo_id, w.start
),
-- What the sessions started in the week cost, subagents and all: each
-- reports only its own transcript's.
sw AS (
  SELECT s.repo_id, w.start, 0 AS merged, 0 AS agent_merged, 0 AS agent_reworked, 0 AS agent_drafted,
    0.0 AS agent_draft_seconds, 0 AS reviewed, 0.0 AS review_seconds, 0 AS stalled,
    TOTAL(s.cost_usd) AS session_cost_usd, 0 AS agent_commits
  FROM sessions s JOIN w ON s.started_at >= w.lo_at AND s.started_at < w.hi_at
  WHERE s.repo_id IN (SELECT value FROM json_each(?1))
    AND s.started_at >= (SELECT MIN(lo_at) FROM w) AND s.started_at < (SELECT MAX(hi_at) FROM w)
  GROUP BY s.repo_id, w.start
),
-- The commits agents pushed outside any pull request (base.sql's
-- `direct`), each once.
cw AS (
  SELECT d.repo_id, w.start, 0 AS merged, 0 AS agent_merged, 0 AS agent_reworked, 0 AS agent_drafted,
    0.0 AS agent_draft_seconds, 0 AS reviewed, 0.0 AS review_seconds, 0 AS stalled, 0.0 AS session_cost_usd,
    COUNT(DISTINCT d.sha) AS agent_commits
  FROM direct d JOIN w ON d.at >= w.lo_at AND d.at < w.hi_at
  GROUP BY d.repo_id, w.start
)
SELECT repo_id, start, SUM(merged) AS merged, SUM(agent_merged) AS agent_merged,
  SUM(agent_reworked) AS agent_reworked, SUM(agent_drafted) AS agent_drafted,
  TOTAL(agent_draft_seconds) AS agent_draft_seconds, SUM(reviewed) AS reviewed,
  TOTAL(review_seconds) AS review_seconds, SUM(stalled) AS stalled, TOTAL(session_cost_usd) AS session_cost_usd,
  SUM(agent_commits) AS agent_commits
FROM (SELECT * FROM pw UNION ALL SELECT * FROM sx UNION ALL SELECT * FROM sw UNION ALL SELECT * FROM cw)
GROUP BY repo_id, start
HAVING SUM(merged) + SUM(agent_drafted) + SUM(reviewed) + SUM(stalled) + SUM(agent_commits) > 0 OR TOTAL(session_cost_usd) > 0
ORDER BY start, repo_id
