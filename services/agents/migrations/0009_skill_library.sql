-- The skill library (docs.g1t.sh/guides/agent-skills/): a workspace's own
-- skills, each a SKILL.md folder (@g1t/contracts skill-format.ts), every
-- change a new version, attached to agents, teams or the whole workspace.

-- One row per skill: its newest version's summary, for lists. A draft
-- (saved from a session) waits for a person to publish it and can't be
-- attached. `mirrored` skills follow the repository in skill_mirrors.
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  version INTEGER NOT NULL,
  description TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  requires_computer INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  -- Where the newest version came from (SkillOrigin, JSON).
  origin TEXT NOT NULL,
  mirrored INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX skills_name ON skills (workspace_id, name) WHERE archived_at IS NULL;

-- Every version as written: SKILL.md and the folder's other files (JSON
-- SkillFile[], text as it is and anything else as base64), at most 1 MB.
-- `digest` tells an unchanged import or push from a new version.
CREATE TABLE skill_versions (
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  description TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  requires_computer INTEGER NOT NULL DEFAULT 0,
  skill_md TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  bytes INTEGER NOT NULL,
  origin TEXT NOT NULL,
  note TEXT,
  digest TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (skill_id, version)
);

-- Where a skill is attached, and the version its agents use there.
-- `target` is the agent's id, the team's slug, or '' for the workspace.
CREATE TABLE skill_attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  attached_by TEXT NOT NULL,
  attached_at TEXT NOT NULL
);
CREATE UNIQUE INDEX skill_attachments_once ON skill_attachments (skill_id, scope, target);
CREATE INDEX skill_attachments_reach ON skill_attachments (workspace_id, scope, target);

-- The repository a workspace's library follows: `.g1t/skills/<name>/` on
-- its default branch, read when it is linked and after every push there.
CREATE TABLE skill_mirrors (
  workspace_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT,
  synced_at TEXT,
  error TEXT,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL
);
CREATE INDEX skill_mirrors_repo ON skill_mirrors (repo_id);
