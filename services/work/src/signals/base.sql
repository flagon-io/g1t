-- ?1 the repositories' ids as a JSON array. Every read of workspace_signals
-- about pull requests starts with this, and goes on with its own CTEs.
--
-- tied: the harness sessions tied to each pull request, as PULL_SESSIONS
-- (coordination/links.rs) ties them: a link, the pull request the session
-- said when it started, or a push to its branch (not a fork's).
WITH tied(pull_id, session_id) AS (
  SELECT p.id, l.session_id FROM session_links l
    JOIN pulls p ON p.repo_id = l.repo_id AND p.number = l.number
    WHERE l.repo_id IN (SELECT value FROM json_each(?1)) AND l.kind = 'pull'
  UNION SELECT p.id, s.id FROM sessions s
    JOIN pulls p ON p.repo_id = s.repo_id AND p.number = s.pull
    WHERE s.repo_id IN (SELECT value FROM json_each(?1))
  UNION SELECT p.id, t.session_id FROM session_touches t
    JOIN pulls p ON p.repo_id = t.repo_id AND p.source_branch = t.value
      AND p.fork_repo_id IS NULL AND p.head_repo_id IS NULL
    WHERE t.repo_id IN (SELECT value FROM json_each(?1)) AND t.kind = 'branch'
),
-- When each tied pull request's first session started, as a Julian day.
first_session(pull_id, started) AS (
  SELECT tied.pull_id, MIN(julianday(s.started_at)) FROM tied JOIN sessions s ON s.id = tied.session_id
  GROUP BY tied.pull_id
),
-- The pull requests, with whose they are (the person who asked for it,
-- else its author), whether an agent's (g1t's agent opened it, it was
-- opened as an agent's, or a session is tied to it), and, when its first
-- session started before it opened, the seconds in between.
pr AS (
  SELECT p.id, p.repo_id, p.number, p.title, p.status, p.item_id, p.milestone,
    p.created_at, p.updated_at, p.merged_at,
    COALESCE(p.requested_by_id, p.author_id) AS owner_id,
    CASE WHEN p.requested_by_id IS NULL THEN p.author_name ELSE p.requested_by_name END AS owner_name,
    (p.agent = 'agent' OR p.author_id = 'usr_g1t_agent' OR f.pull_id IS NOT NULL) AS agent,
    CASE WHEN f.started < julianday(p.created_at)
      THEN MAX(0, (julianday(p.created_at) - f.started) * 86400) END AS draft_seconds
  FROM pulls p LEFT JOIN first_session f ON f.pull_id = p.id
  WHERE p.repo_id IN (SELECT value FROM json_each(?1))
)
