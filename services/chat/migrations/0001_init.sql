-- Chat: channels, direct messages, their members and their messages.
-- People and agents are members alike, keyed `user:<id>` or `agent:<id>`.
-- Workspaces are kept by id, so renaming one changes nothing here.

-- A channel, or a direct message (kind `dm`, no name). A direct message's
-- `dm_key` is its members' keys, sorted and joined, so the same people
-- always find the same conversation.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
  name TEXT,
  topic TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  dm_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  last_message_at TEXT
);

CREATE UNIQUE INDEX channels_by_name ON channels (workspace_id, name) WHERE name IS NOT NULL;
CREATE UNIQUE INDEX channels_by_dm_key ON channels (workspace_id, dm_key) WHERE dm_key IS NOT NULL;
-- Browse channels: a workspace's public ones.
CREATE INDEX channels_by_workspace ON channels (workspace_id, kind, private);

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  starred INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  -- The newest message they have read; everything after it is unread.
  last_read_id TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, principal)
);

-- The sidebar: every channel one member is in.
CREATE INDEX channel_members_by_principal ON channel_members (principal, channel_id);

-- Ids are time-sortable, so ordering by id is ordering by time.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'card')),
  body TEXT NOT NULL DEFAULT '',
  -- A MessageCard as JSON, for kind `card`.
  card TEXT,
  -- The handles it @mentions, lowercased, as ` a b ` so one is found with
  -- LIKE '% a %' (src/mentions.ts).
  mentions TEXT NOT NULL DEFAULT '',
  thread_root TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);

CREATE INDEX messages_by_channel ON messages (channel_id, id);
CREATE INDEX messages_by_thread ON messages (thread_root, id) WHERE thread_root IS NOT NULL;

-- Reactions, for later.
CREATE TABLE reactions (
  message_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, principal, emoji)
);

-- Who has been put in a workspace's #general once, so someone who leaves
-- it is not put back (src/index.ts, `sidebar`).
CREATE TABLE general_joined (
  workspace_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal)
);

-- People chatting is included on every plan, but metered raw, so the
-- daily reconciliation sees what chat really costs: messages written and
-- their bytes, per workspace per UTC day.
CREATE TABLE chat_meter (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
