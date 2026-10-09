-- A repository that mirrors a remote which leads (see crates/contracts
-- src/mirrors.rs). The integrations service owns the link and sets this
-- through `set_mirror`; it is kept here so pushes, merges and agents are
-- refused or allowed without asking anyone.
--
-- mirror: JSON `RepoMirror` (state standby | ci | takeover | handing_back,
--   the remote's name and address, since, and the workflow levers). Null
--   for a repository that leads.
ALTER TABLE repos ADD COLUMN mirror TEXT;
