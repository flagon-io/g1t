-- Many email addresses per account, one of them primary. Every timestamp
-- is RFC 3339 UTC. See src/emails.rs and src/security.rs.
--
-- users.email stays, as a copy of the primary address that identity keeps
-- in step, and users.email_verified_at as the primary's verified_at: other
-- services and older queries read them, and "the account is confirmed"
-- still means exactly that the primary is. user_emails is the source of
-- truth for every address.

CREATE TABLE IF NOT EXISTS user_emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Trimmed and lowercased: what uniqueness and lookups use.
  email TEXT NOT NULL,
  -- As the person typed it, for showing.
  display TEXT NOT NULL,
  -- Null until a link sent to the address is followed.
  verified_at TEXT,
  -- When a confirmation link was last sent, to space out resends.
  sent_at TEXT,
  created_at TEXT NOT NULL
);
-- A confirmed address belongs to one account. Anyone may add an address
-- they have not confirmed; the first account to confirm it keeps it, and
-- everyone else's unconfirmed claim to it is dropped (src/emails.rs).
CREATE UNIQUE INDEX IF NOT EXISTS user_emails_verified ON user_emails (email) WHERE verified_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_emails_per_user ON user_emails (user_id, email);
CREATE INDEX IF NOT EXISTS user_emails_email ON user_emails (email);

-- The primary address: where account mail and password resets go.
ALTER TABLE users ADD COLUMN primary_email_id TEXT;
-- A second confirmed address that also gets security notices. Null: the
-- primary only.
ALTER TABLE users ADD COLUMN backup_email_id TEXT;
-- Commits g1t makes for the person on the web use their noreply address
-- (<id suffix>+<username>@users.noreply.g1t.sh) instead of the primary.
-- On by default, so no address is ever published without asking.
ALTER TABLE users ADD COLUMN private_email INTEGER NOT NULL DEFAULT 1;
-- Refuse pushes whose commits carry one of the person's private addresses.
-- Stored now; enforced by repos once it asks (see docs).
ALTER TABLE users ADD COLUMN block_private_pushes INTEGER NOT NULL DEFAULT 0;

-- Which address a confirmation link is for. Null on links sent before
-- this migration: those confirm the primary.
ALTER TABLE email_tokens ADD COLUMN email_id TEXT;

-- When the session's owner last proved who they are (signed in, or typed
-- their password again). Sensitive changes need it to be recent
-- (src/security.rs). Null on older sessions: never recent.
ALTER TABLE sessions ADD COLUMN authenticated_at TEXT;

-- The addresses accounts have now. users.email has been unique, so no two
-- rows collide on the confirmed index.
INSERT OR IGNORE INTO user_emails (id, user_id, email, display, verified_at, created_at)
SELECT 'eml_' || lower(hex(randomblob(13))), id, lower(trim(email)), trim(email), email_verified_at, created_at
FROM users
WHERE email IS NOT NULL AND trim(email) <> '';

UPDATE users SET primary_email_id = (
  SELECT user_emails.id FROM user_emails
  WHERE user_emails.user_id = users.id AND user_emails.email = lower(trim(users.email))
)
WHERE email IS NOT NULL AND trim(email) <> '';

-- Uniqueness moves to confirmed addresses (above): two accounts may both
-- have an unconfirmed address, and then neither has it yet.
DROP INDEX IF EXISTS users_email;

-- Every place an account is made (password, invite, GitHub) inserts into
-- users with an email; this gives that address its row and makes it the
-- primary, so none of them has to know about user_emails. An account made
-- with a confirmed address (GitHub's) also wins it from anyone's
-- unconfirmed claim. An address another account has confirmed fails the
-- insert with a UNIQUE error, which those places report as taken.
CREATE TRIGGER IF NOT EXISTS users_primary_email AFTER INSERT ON users
WHEN NEW.email IS NOT NULL AND trim(NEW.email) <> ''
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: user_emails.email')
  WHERE EXISTS (
    SELECT 1 FROM user_emails
    WHERE email = lower(trim(NEW.email)) AND verified_at IS NOT NULL AND user_id <> NEW.id
  );
  UPDATE users SET email = NULL, email_verified_at = NULL, primary_email_id = NULL
  WHERE NEW.email_verified_at IS NOT NULL AND id <> NEW.id
    AND primary_email_id IN (
      SELECT id FROM user_emails WHERE email = lower(trim(NEW.email)) AND verified_at IS NULL
    );
  DELETE FROM user_emails
  WHERE NEW.email_verified_at IS NOT NULL AND user_id <> NEW.id
    AND email = lower(trim(NEW.email)) AND verified_at IS NULL;
  INSERT INTO user_emails (id, user_id, email, display, verified_at, created_at)
  VALUES ('eml_' || lower(hex(randomblob(13))), NEW.id, lower(trim(NEW.email)), trim(NEW.email),
    NEW.email_verified_at, NEW.created_at);
  UPDATE users SET email = lower(trim(NEW.email)), primary_email_id = (
    SELECT id FROM user_emails WHERE user_id = NEW.id AND email = lower(trim(NEW.email))
  ) WHERE id = NEW.id;
END;

-- What happened to an account's security: addresses added, confirmed,
-- removed or made primary, passwords changed. Shown to the person as their
-- security log, and to staff. Never another person's address in `detail`.
CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- email_added, email_verified, email_removed, primary_email_changed,
  -- backup_email_changed, email_privacy_changed, password_changed.
  kind TEXT NOT NULL,
  -- The address concerned, or what changed, in words.
  detail TEXT,
  -- Who did it: the person (null), or staff, by email.
  staff TEXT,
  -- Why staff did it.
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS security_events_user ON security_events (user_id, created_at);

-- Guessing passwords, and asking for mail, slowed down (src/throttle.rs).
-- `key` such as `signin.account:usr_…`, `signin.client:<sha256 of the IP>`
-- or `reset.email:<sha256 of the address>`.
CREATE TABLE IF NOT EXISTS auth_throttle (
  key TEXT PRIMARY KEY,
  -- Failures (or requests) since window_start.
  hits INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  -- Nothing more is tried for this key until then. Null: not locked.
  locked_until TEXT,
  -- When the account's owner was last told it was locked.
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_throttle_window ON auth_throttle (window_start);
