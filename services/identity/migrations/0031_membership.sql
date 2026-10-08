-- Membership as GitHub has it (crates/contracts/src/members.rs). Identity
-- 0030 is taken by another change; this starts at 0031.
--
-- Wrangler applies it once; each ALTER must run once, like 0019's.

-- Roles that add to a member: a billing manager manages billing as an
-- owner does; a security manager reads every repository and manages its
-- security. 1 for yes. Owners have both whatever these say.
ALTER TABLE workspace_members ADD COLUMN billing_manager INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_members ADD COLUMN security_manager INTEGER NOT NULL DEFAULT 0;

-- What the workspace lets its members do, as JSON
-- (g1t_contracts::MemberPrivileges); NULL, or a field left out, is its
-- default. Set by an owner on Settings -> Member privileges.
ALTER TABLE workspaces ADD COLUMN member_privileges TEXT;

-- 1 when members and outside collaborators need two-factor
-- authentication to use the workspace (security.rs). Off for every
-- workspace until an owner turns it on.
ALTER TABLE workspaces ADD COLUMN require_two_factor INTEGER NOT NULL DEFAULT 0;

-- The base permission. A new workspace now starts at 'read' (as on
-- GitHub); create_workspace writes it. Every existing workspace keeps the
-- value it has: the column has been NOT NULL DEFAULT 'write' since 0020,
-- so each row already says; this only makes sure none is blank.
UPDATE workspaces SET base_permission = 'write' WHERE base_permission IS NULL OR trim(base_permission) = '';
