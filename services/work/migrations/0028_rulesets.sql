-- Rulesets: what may happen to a repository's branches and tags, and what
-- a pull request needs before it merges. See crates/rules and
-- src/rulesets.rs. Every timestamp is RFC 3339 UTC.

-- A repository's rulesets (level 'repository', with repo_id) and a
-- workspace's (level 'workspace'). `spec` is the ruleset as the API shows
-- it (g1t_contracts::rules::RulesetSpec, JSON); name, enforcement and
-- target are copied out of it for listing.
CREATE TABLE rulesets (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  -- The workspace's slug; for a repository's, its workspace when saved.
  workspace TEXT NOT NULL,
  repo_id TEXT,
  name TEXT NOT NULL,
  enforcement TEXT NOT NULL,
  target TEXT NOT NULL,
  spec TEXT NOT NULL,
  -- 'branch_protection' for the one made from branch protection settings.
  source TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX rulesets_by_repo ON rulesets (repo_id);
CREATE INDEX rulesets_by_workspace ON rulesets (workspace, level);

-- Every evaluation of a ruleset on a push, a merge or another change to a
-- branch or tag: the audit trail, and what `evaluate` rulesets would have
-- refused. `violations` is JSON (Vec<Violation>). Ids sort by time.
CREATE TABLE rule_evaluations (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  ruleset_id TEXT NOT NULL,
  ruleset_name TEXT NOT NULL,
  enforcement TEXT NOT NULL,
  -- push, merge, create_ref, delete_ref, rename_ref or commit.
  action TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  actor TEXT NOT NULL,
  -- person, agent, g1t or token.
  actor_kind TEXT NOT NULL,
  -- pass, fail or bypass.
  verdict TEXT NOT NULL,
  violations TEXT NOT NULL DEFAULT '[]',
  number INTEGER,
  sha TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX rule_evaluations_by_repo ON rule_evaluations (repo_id, id);
CREATE INDEX rule_evaluations_by_workspace ON rule_evaluations (workspace, id);
CREATE INDEX rule_evaluations_by_ruleset ON rule_evaluations (ruleset_id, id);

-- The repos service kept whether pushes to the default branch were refused
-- (its `protected` flag). The first time g1t reads a repository's rulesets
-- after this, it folds that flag into its branch protection ruleset, once.
CREATE TABLE ruleset_adoptions (
  repo_id TEXT PRIMARY KEY,
  adopted_at TEXT NOT NULL
);

-- Who moved a pull request's head last, and when: for approving the most
-- recent push and dismissing approvals that came before it.
ALTER TABLE pulls ADD COLUMN head_pushed_by TEXT;
ALTER TABLE pulls ADD COLUMN head_pushed_at TEXT;

-- The integration that reported a status: actions, deployments, security
-- or g1t. A required check can insist on one.
ALTER TABLE commit_statuses ADD COLUMN source TEXT;

-- Branch protection becomes a ruleset, holding exactly what it held: the
-- default branch's pull request rule (approvals, code owners), required
-- status checks and merge queue. Pushes stay allowed here; repositories
-- that refused them are adopted as described above. Only for repositories
-- whose settings protect anything.
INSERT INTO rulesets (id, level, workspace, repo_id, name, enforcement, target, spec, source, created_by, created_at, updated_by, updated_at)
SELECT
  'rs_' || lower(hex(randomblob(12))),
  'repository',
  '',
  s.repo_id,
  'Default branch protection',
  'active',
  'branch',
  json_object(
    'name', 'Default branch protection',
    'enforcement', 'active',
    'target', 'branch',
    'conditions', json_object('ref_name', json_object('include', json_array('~DEFAULT_BRANCH'), 'exclude', json_array())),
    'bypass_actors', json_array(),
    'rules', (
      SELECT json_group_array(json(rule.value))
      FROM json_each(json_array(
        CASE WHEN s.required_approvals > 0 OR s.require_code_owner_review != 0 THEN json_object(
          'type', 'pull_request',
          'parameters', json_object(
            'required_approvals', s.required_approvals,
            'count_agent_approvals', json(CASE WHEN s.count_agent_approvals != 0 THEN 'true' ELSE 'false' END),
            'dismiss_stale_reviews_on_push', json('false'),
            'require_code_owner_review', json(CASE WHEN s.require_code_owner_review != 0 THEN 'true' ELSE 'false' END),
            'require_last_push_approval', json('false'),
            'allowed_merge_methods', json_array(),
            'allow_direct_pushes', json('true')
          ),
          'applies_to', 'everyone'
        ) END,
        CASE WHEN s.required_checks != '[]' OR s.require_up_to_date != 0 THEN json_object(
          'type', 'required_status_checks',
          'parameters', json_object(
            'checks', (SELECT json_group_array(json_object('context', checks.value)) FROM json_each(s.required_checks) AS checks),
            'strict', json(CASE WHEN s.require_up_to_date != 0 THEN 'true' ELSE 'false' END),
            'paths', json_array(),
            'allow_bypass_on_merge', json(CASE WHEN s.allow_ignoring_checks != 0 THEN 'true' ELSE 'false' END)
          ),
          'applies_to', 'everyone'
        ) END,
        CASE WHEN s.merge_queue != 0 THEN json_object(
          'type', 'merge_queue',
          'parameters', json_object(
            'merge_method', 'merge',
            'max_entries_to_build', 4,
            'min_entries_to_merge', 1,
            'min_entries_wait_minutes', 0,
            'check_response_timeout_minutes', 45
          ),
          'applies_to', 'everyone'
        ) END
      )) AS rule
      WHERE rule.type != 'null'
    )
  ),
  'branch_protection',
  s.updated_by,
  s.updated_at,
  s.updated_by,
  s.updated_at
FROM repo_settings s
WHERE s.required_approvals > 0
   OR s.require_code_owner_review != 0
   OR s.required_checks != '[]'
   OR s.require_up_to_date != 0
   OR s.merge_queue != 0;
