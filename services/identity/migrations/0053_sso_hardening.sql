-- Single sign-on, after review. See src/sso.rs.

-- A SAML trip is bound to the browser that set off: the hash of a value
-- kept in a SameSite=None cookie, which the provider's cross-site POST
-- carries back (the session cookie, SameSite=Lax, does not).
ALTER TABLE sso_states ADD COLUMN browser TEXT;

-- Every stable id the provider gave for the person (the subject first,
-- and Entra's object id), as a JSON array: SCIM finds them by any of
-- them, and a new app registration with another subject is still them.
ALTER TABLE sso_identities ADD COLUMN ids TEXT NOT NULL DEFAULT '[]';
-- Their address, when the provider vouched for it.
ALTER TABLE sso_identities ADD COLUMN trusted_email TEXT;

-- A person's links, for their tokens and keys on every request.
CREATE INDEX IF NOT EXISTS sso_identities_by_user ON sso_identities (user_id);
-- SCIM looks people up by externalId.
CREATE INDEX IF NOT EXISTS scim_users_by_external ON scim_users (workspace_id, external_id);
