-- g1t is the author of the pull requests it makes and of the issues its
-- agent files while at work. The person who asked for the work is kept
-- beside it as requested_by, and answers for it as its author would:
-- every rule that read the author reads COALESCE(requested_by, author)
-- now (Pull::owner in the contracts).
ALTER TABLE pulls ADD COLUMN requested_by_id TEXT;
ALTER TABLE pulls ADD COLUMN requested_by_name TEXT;
ALTER TABLE issues ADD COLUMN requested_by_id TEXT;
ALTER TABLE issues ADD COLUMN requested_by_name TEXT;

-- A person's own work, and the work g1t made for them, for their lists:
-- what they are working on, and their profile.
CREATE INDEX IF NOT EXISTS pulls_by_owner ON pulls (COALESCE(requested_by_id, author_id), status);
CREATE INDEX IF NOT EXISTS issues_by_owner ON issues (COALESCE(requested_by_id, author_id), created_at);

-- The pull requests g1t made until now, stored as the person who asked.
-- What marks one is what made_by_g1t reads: g1t's agent, hosted, in a
-- fork of its own. Work g1t started itself is stored as g1t already
-- (its id, or an older one) and nobody asked for it: it stays as it is.
UPDATE pulls
SET requested_by_id = author_id,
    requested_by_name = author_name,
    author_id = 'usr_g1t_agent',
    author_name = 'g1t'
WHERE agent = 'g1t'
  AND runtime = 'hosted'
  AND fork_namespace IS NOT NULL
  AND fork_name IS NOT NULL
  AND requested_by_id IS NULL
  AND author_id NOT IN ('usr_g1t_agent', 'g1t', 'g1t_policy', 'svc_runner', 'g1t_runner');

-- The issues g1t's agent filed are stored as g1t already; who it was
-- working for was not kept. It is the person who asked for the pull
-- request whose run was going in that workspace when the issue was
-- filed, where exactly one person's was. Where none or several were,
-- nobody is named rather than the wrong person.
UPDATE issues
SET requested_by_id = (
      SELECT p.requested_by_id
      FROM agent_runs r JOIN pulls p ON p.id = r.pull_id
      WHERE p.requested_by_id IS NOT NULL
        AND (r.repo_id = issues.repo_id
             OR r.workspace IN (SELECT workspace FROM agent_runs WHERE repo_id = issues.repo_id))
        AND COALESCE(r.started_at, r.created_at) <= issues.created_at
        AND COALESCE(r.finished_at, r.updated_at) >= issues.created_at
      LIMIT 1),
    requested_by_name = (
      SELECT p.requested_by_name
      FROM agent_runs r JOIN pulls p ON p.id = r.pull_id
      WHERE p.requested_by_id IS NOT NULL
        AND (r.repo_id = issues.repo_id
             OR r.workspace IN (SELECT workspace FROM agent_runs WHERE repo_id = issues.repo_id))
        AND COALESCE(r.started_at, r.created_at) <= issues.created_at
        AND COALESCE(r.finished_at, r.updated_at) >= issues.created_at
      LIMIT 1)
WHERE author_id = 'usr_g1t_agent'
  AND requested_by_id IS NULL
  AND (
    SELECT count(DISTINCT p.requested_by_id)
    FROM agent_runs r JOIN pulls p ON p.id = r.pull_id
    WHERE p.requested_by_id IS NOT NULL
      AND (r.repo_id = issues.repo_id
           OR r.workspace IN (SELECT workspace FROM agent_runs WHERE repo_id = issues.repo_id))
      AND COALESCE(r.started_at, r.created_at) <= issues.created_at
      AND COALESCE(r.finished_at, r.updated_at) >= issues.created_at
  ) = 1;
