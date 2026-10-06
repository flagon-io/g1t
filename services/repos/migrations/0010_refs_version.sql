-- Where a repository's refs stand, for the answers that list them, which
-- git asks for first on every clone and fetch and which are kept for a
-- moment (src/refs_cache.rs).
--
-- refs_version: goes up after everything g1t does that changes the refs:
--   a push through git over HTTPS, a merge, a pull request brought up to
--   date, a branch deleted or renamed, the default branch changed, a mirror
--   catching up, an import. An answer is kept under the version it was
--   made at, so a change leaves it behind.
-- refs_open_until: milliseconds since the epoch. Set when a credential
--   that can push is handed out of g1t's hands (`git_access`); until then
--   nothing is kept, because a push with it would not move the version.
ALTER TABLE repos ADD COLUMN refs_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN refs_open_until INTEGER;
