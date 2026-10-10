-- Agent skills (docs.g1t.sh/guides/agent-skills/): every agent starts with
-- g1t's foundational skills (@g1t/contracts skills.ts), and a workspace's
-- owners can turn any of them off for one agent. Part of the definition,
-- so a change is a new version like any other: a JSON list of skill ids,
-- empty for all of them on.
ALTER TABLE agents ADD COLUMN skills_off TEXT NOT NULL DEFAULT '[]';
