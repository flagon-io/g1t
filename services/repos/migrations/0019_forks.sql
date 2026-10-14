-- Forks people make into their workspaces (network.rs). Unlike a pull
-- request's working copy (`fork_of`, namespace `pulls`, hidden), a fork is
-- an ordinary repository of its workspace that remembers where it came
-- from, so it can be synced and can open pull requests there. Cleared
-- when the fork is detached, or when its parent changes who can see it.
ALTER TABLE repos ADD COLUMN parent_id TEXT REFERENCES repos(id);
CREATE INDEX repos_parent ON repos(parent_id) WHERE parent_id IS NOT NULL;
-- What it was made a fork of, never cleared: what forks start with
-- (Actions and issues off) holds once it is detached, and its pull
-- requests into the parent still merge. No reference, as the parent may
-- be purged.
ALTER TABLE repos ADD COLUMN forked_from TEXT;

-- When the hourly sweep last checked that whoever made a private fork can
-- still read its parent (network.rs); a fork whose maker cannot is
-- deleted, restorable for 30 days.
ALTER TABLE repos ADD COLUMN fork_checked_ms INTEGER;
CREATE INDEX repos_private_forks ON repos(fork_checked_ms) WHERE parent_id IS NOT NULL AND is_private = 1;

-- A private repository's admins let others fork it. Public repositories
-- can always be forked.
ALTER TABLE repos ADD COLUMN allow_forking INTEGER NOT NULL DEFAULT 0;
