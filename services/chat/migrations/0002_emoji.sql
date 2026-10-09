-- A workspace's own emoji, and who may add them. Reactions use the
-- `reactions` table from 0001.

-- An emoji's image is kept by the SHA-256 of its bytes in the avatars KV
-- namespace, under `emoji/<file>`, and served from the usercontent origin
-- at `/emoji/<file>`. An alias names another emoji and shows its image, so
-- it keeps that emoji's file too. A removed emoji keeps its row, so its
-- name can be used again and what it was stays on record.
CREATE TABLE custom_emoji (
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  alias_of TEXT,
  file TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/gif', 'image/webp')),
  bytes INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

-- One live emoji per name in a workspace; the picker lists them by name.
CREATE UNIQUE INDEX custom_emoji_by_name ON custom_emoji (workspace_id, name) WHERE deleted_at IS NULL;

-- A workspace's chat settings. No row: the defaults.
CREATE TABLE chat_settings (
  workspace_id TEXT PRIMARY KEY,
  -- Who may add emoji: every member, or only owners.
  emoji_upload TEXT NOT NULL DEFAULT 'members' CHECK (emoji_upload IN ('members', 'admins'))
);

-- Whether any live emoji still shows an image, before it is forgotten.
CREATE INDEX custom_emoji_by_file ON custom_emoji (file) WHERE deleted_at IS NULL;
