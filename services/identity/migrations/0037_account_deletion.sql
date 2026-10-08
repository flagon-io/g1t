-- Deleting an account is soft first. The row stays, with when, by whom and
-- until when g1t's staff can restore it, and every read that resolves a
-- person leaves it out: it cannot sign in, its profile is not found, and
-- nobody can add it to anything. Its sessions, tokens, keys and
-- memberships are removed at once (src/account_deletion.rs). The row keeps
-- the username from anyone else meanwhile. Once purge_after passes, the
-- scheduled purge removes it with its personal data.
--
-- `deleted_by`: the account itself when the person deleted it; null when
-- staff did (who, and why, are in `deleted_went`).
-- `deleted_went`: JSON, what went with it, counted when it was deleted,
-- and the memberships, teams and repository roles it left, so a restore
-- can put them back.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN deleted_by TEXT;
ALTER TABLE users ADD COLUMN purge_after TEXT;
ALTER TABLE users ADD COLUMN deleted_went TEXT;

CREATE INDEX IF NOT EXISTS users_purge_after ON users (purge_after) WHERE deleted_at IS NOT NULL;

-- A purged account's username, kept so it is never given to another
-- account or workspace: links, mentions and commits that name it keep
-- meaning what they meant. Nothing personal: the id is random.
CREATE TABLE IF NOT EXISTS deleted_users (
  username TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  purged_at TEXT NOT NULL
);

-- `ghost`: who wrote what a purged account wrote. A row of its own, so a
-- workspace whose creator is purged still names an account. It has no
-- password and no address, and is marked deleted with no purge time, so it
-- can never sign in, is never listed, and is never purged. `ghost` is a
-- reserved name, so nobody can register it.
INSERT OR IGNORE INTO users (id, username, password_hash, created_at, deleted_at)
VALUES ('usr_ghost', 'ghost', '', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z');
