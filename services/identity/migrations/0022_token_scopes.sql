-- Scopes for access tokens and applications signed in with OAuth: what each
-- may do, and which workspaces or repositories it reaches. See
-- crates/contracts/src/scopes.rs and src/tokens.rs.
--
-- `scopes` is the scopes, space-separated (`repo:read issues:write`), or
-- `*` for full access. Null marks a token or grant made before scopes:
-- it keeps full access, so nothing that uses one breaks, and settings
-- show it as legacy with a way to narrow it. No existing row is changed.
--
-- `resources` is JSON: {"kind":"all"}, {"kind":"workspaces","workspaces":
-- [<workspace ids>]} or {"kind":"repositories","repositories":
-- ["owner/name"]}. Null means all.
ALTER TABLE access_tokens ADD COLUMN scopes TEXT;
ALTER TABLE access_tokens ADD COLUMN resources TEXT;
-- A token a person made with an expiry is still theirs to see and delete;
-- tokens issued to applications and agents, which expire too, are not
-- listed.
ALTER TABLE access_tokens ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE oauth_codes ADD COLUMN scopes TEXT;
ALTER TABLE oauth_codes ADD COLUMN resources TEXT;
ALTER TABLE oauth_grants ADD COLUMN scopes TEXT;
ALTER TABLE oauth_grants ADD COLUMN resources TEXT;
