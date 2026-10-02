-- Unix seconds. Null means the token does not expire.
ALTER TABLE access_tokens ADD COLUMN expires_at INTEGER;
