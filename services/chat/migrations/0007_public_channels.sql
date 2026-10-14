-- Public channels and guests (docs.g1t.sh/guides/chat/, "Public channels"
-- and "Guests").
--
-- A public channel is open to anyone signed in to g1t, not only the
-- workspace's members: they read it, join it and talk in it. Only a
-- channel that is not private can be public.
ALTER TABLE channels ADD COLUMN public INTEGER NOT NULL DEFAULT 0;

-- Someone outside the workspace asked into one of its channels: a guest.
-- They join it when they accept; until then the channel is not theirs to
-- read. One open invitation per person and channel.
CREATE TABLE channel_invitations (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  -- 'user:<id>'
  invitee TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  -- 1 accepted, 0 declined or revoked; null while open.
  accepted INTEGER
);
CREATE UNIQUE INDEX channel_invitations_open ON channel_invitations (channel_id, invitee) WHERE answered_at IS NULL;
CREATE INDEX channel_invitations_by_invitee ON channel_invitations (invitee, answered_at);
CREATE INDEX channel_invitations_by_channel ON channel_invitations (channel_id, accepted);

-- Someone asking to be let into a channel they cannot open: a private one,
-- or one kept to the workspace when they are not in it. Whoever could add
-- them answers. Asked by the channel's name from its link, and stored only
-- when there is such a channel, so asking says nothing of one that is not
-- theirs to see. One open request per person and channel.
CREATE TABLE channel_requests (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  -- 'user:<id>'
  requester TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by TEXT,
  -- 1 let in, 0 turned down or withdrawn; null while open.
  approved INTEGER
);
CREATE UNIQUE INDEX channel_requests_open ON channel_requests (channel_id, requester) WHERE answered_at IS NULL;
CREATE INDEX channel_requests_by_channel ON channel_requests (channel_id, answered_at);

-- People removed from a channel by its owners or the workspace's: someone
-- outside the workspace removed from a public channel cannot join it again
-- on their own. Asking them in again lifts it.
CREATE TABLE channel_removals (
  channel_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  removed_by TEXT NOT NULL,
  removed_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, principal)
);
