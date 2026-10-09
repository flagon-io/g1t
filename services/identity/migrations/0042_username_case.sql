-- Usernames keep the case their owner chose: `Ana`, not only `ana`.
--
-- `users.username` stays the lowercased name everything finds a person by:
-- its UNIQUE index is what makes names unique whatever their case, and
-- URLs, lookups, mentions, git and every other service join on it. The
-- name as its owner wrote it is kept beside it, for showing. NULL (every
-- account so far) means it is shown as `username`.
ALTER TABLE users ADD COLUMN display_username TEXT;
