-- Permanent tombstones for erased people and workspaces (src/erasure.ts),
-- and the channels a purge still has to visit.
CREATE TABLE erased_subjects (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
CREATE TABLE purge_channels (subject_id TEXT NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY(subject_id, channel_id));

-- A purge finds a person's messages, reactions and channels without scanning every row.
CREATE INDEX messages_by_author ON messages (author);
CREATE INDEX reactions_by_principal ON reactions (principal);
CREATE INDEX channels_by_creator ON channels (created_by);

-- Late, in-flight writes cannot recreate the erased person's membership,
-- messages or reactions. Each looks the tombstone up by its key.
CREATE TRIGGER erased_message BEFORE INSERT ON messages WHEN NEW.author LIKE 'user:%' AND EXISTS (
  SELECT 1 FROM erased_subjects WHERE id = substr(NEW.author, 6) AND kind = 'user'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_member BEFORE INSERT ON channel_members WHEN NEW.principal LIKE 'user:%' AND EXISTS (
  SELECT 1 FROM erased_subjects WHERE id = substr(NEW.principal, 6) AND kind = 'user'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_reaction BEFORE INSERT ON reactions WHEN (NEW.principal LIKE 'user:%' AND EXISTS (
  SELECT 1 FROM erased_subjects WHERE id = substr(NEW.principal, 6) AND kind = 'user'
)) OR NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.message_id) BEGIN SELECT RAISE(IGNORE); END;

-- Nothing of an erased workspace comes back.
CREATE TRIGGER erased_channel BEFORE INSERT ON channels WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE id = NEW.workspace_id AND kind = 'workspace'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_general_joined BEFORE INSERT ON general_joined WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE id = NEW.workspace_id AND kind = 'workspace'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_custom_emoji BEFORE INSERT ON custom_emoji WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE id = NEW.workspace_id AND kind = 'workspace'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_chat_settings BEFORE INSERT ON chat_settings WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE id = NEW.workspace_id AND kind = 'workspace'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_chat_meter BEFORE INSERT ON chat_meter WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE id = NEW.workspace_id AND kind = 'workspace'
) BEGIN SELECT RAISE(IGNORE); END;

-- A message or member of a channel that is gone (an erased one) is not kept.
CREATE TRIGGER orphan_message BEFORE INSERT ON messages WHEN NOT EXISTS (
  SELECT 1 FROM channels WHERE id = NEW.channel_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER orphan_member BEFORE INSERT ON channel_members WHEN NOT EXISTS (
  SELECT 1 FROM channels WHERE id = NEW.channel_id
) BEGIN SELECT RAISE(IGNORE); END;
