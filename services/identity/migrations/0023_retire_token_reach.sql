-- Tokens are classic: a token reaches whatever its owner can (a person's
-- token, their workspaces and repositories; a workspace's token, that
-- workspace), and only its scopes narrow that. The per-token limit to some
-- workspaces or repositories that 0022 stored in `resources` is retired.
--
-- The `resources` columns stay, since D1 cannot drop a column in place
-- safely; nothing reads or writes them any more.
--
-- A token or application that was limited would otherwise widen silently
-- to everything its owner can reach. Instead it fails closed: its scopes
-- are emptied, so it can only say who it is (and read public code) until
-- its owner gives it scopes again under Settings, Access tokens or
-- Applications. Then the limits are cleared. Running this twice changes
-- nothing the second time.
UPDATE access_tokens SET scopes = '' WHERE resources IS NOT NULL;
UPDATE oauth_grants SET scopes = '' WHERE resources IS NOT NULL;
UPDATE access_tokens SET resources = NULL WHERE resources IS NOT NULL;
UPDATE oauth_grants SET resources = NULL WHERE resources IS NOT NULL;
-- A code still waiting to be exchanged (they last five minutes) is dropped;
-- the application asks again.
DELETE FROM oauth_codes WHERE resources IS NOT NULL;
