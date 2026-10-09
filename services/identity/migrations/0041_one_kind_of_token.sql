-- One kind of access token. Classic tokens (scopes, reaching whatever
-- their owner can) and fine-grained ones (a resource owner, repositories
-- and named permissions, 0034) become the same thing: permissions,
-- a level for each resource, stored as scopes (the highest of each
-- resource), and a reach. See src/token_reach.rs and
-- crates/contracts/src/tokens.rs.
--
-- Nothing a token can do changes. Every check already read `scopes`, and
-- a token's reach is read from the columns it already has:
--   owner_workspace_id set               made for that workspace
--   owner_workspace_id null, selection
--     'public'                           made for no workspace: its owner's
--                                        account and public repositories
--     anything else                      made for every workspace its
--                                        owner belongs to (a classic token)
-- A workspace's own token reaches its workspace, as before.
--
-- Running this twice changes nothing the second time.

-- Full access, set out as permissions. A person's tokens made on purpose
-- (listed, or never expiring: settings and `g1t login`) whose scopes are
-- `*`, or null (made before scopes, full access), get every resource at
-- its highest level. Applications' and agents' credentials keep theirs.
UPDATE access_tokens
SET scopes = 'repo:admin code:write security:write packages:delete issues:write pull_requests:write agents:run workflows:write workflow_files:write checks:write deployments:write memory:write account:write notifications:write workspace:admin billing:write access:admin webhooks:admin secrets:admin runners:admin models:write'
WHERE (scopes IS NULL OR scopes = '*')
  AND user_id IS NOT NULL AND workspace_id IS NULL
  AND agent_scope IS NULL AND job_id IS NULL
  AND (expires_at IS NULL OR listed = 1);

-- A workspace's own tokens with full access: every resource but a
-- person's account. One an owner gave Admin keeps Repositories: admin;
-- one without has Repositories: write and Who has access: read, all its
-- Write role ever let it use.
UPDATE access_tokens
SET scopes = 'repo:admin code:write security:write packages:delete issues:write pull_requests:write agents:run workflows:write workflow_files:write checks:write deployments:write memory:write workspace:admin billing:write access:admin webhooks:admin secrets:admin runners:admin models:write'
WHERE (scopes IS NULL OR scopes = '*')
  AND workspace_id IS NOT NULL AND agent_scope IS NULL AND job_id IS NULL
  AND COALESCE(admin, 0) = 1;
UPDATE access_tokens
SET scopes = 'repo:write code:write security:write packages:delete issues:write pull_requests:write agents:run workflows:write workflow_files:write checks:write deployments:write memory:write workspace:admin billing:write access:read webhooks:admin secrets:admin runners:admin models:write'
WHERE (scopes IS NULL OR scopes = '*')
  AND workspace_id IS NOT NULL AND agent_scope IS NULL AND job_id IS NULL
  AND COALESCE(admin, 0) = 0;

-- A token made for every workspace says so, rather than by a null.
UPDATE access_tokens SET repository_selection = 'all'
WHERE repository_selection IS NULL AND owner_workspace_id IS NULL
  AND agent_scope IS NULL AND job_id IS NULL
  AND (expires_at IS NULL OR listed = 1);

-- `kind` and the old named `permissions` are retired: the scopes those
-- permissions gave are what the token holds, and nothing reads either
-- column any more. They are left as they are, not cleared, so the identity
-- worker from before this change still reads every token correctly in the
-- moments between this migration and its deploy; D1 cannot drop them in
-- place.

-- token_policies keeps its columns: `allow_classic` is now "tokens made
-- for every workspace of their owner may reach this one", and
-- `allow_fine_grained` "tokens may be made for this workspace alone". Their
-- meaning for every existing token is the same as before.
