-- What a workspace's owners decide members may do in chat (src/settings.ts).
-- Every column has the default a workspace without a row gets, so
-- existing rows (made for `emoji_upload`) keep working unchanged.

-- Who may create public channels, and private ones: every member, or only owners.
ALTER TABLE chat_settings ADD COLUMN public_channels TEXT NOT NULL DEFAULT 'members' CHECK (public_channels IN ('members', 'owners'));
ALTER TABLE chat_settings ADD COLUMN private_channels TEXT NOT NULL DEFAULT 'members' CHECK (private_channels IN ('members', 'owners'));

-- Who may rename, archive and unarchive a channel: its owners and the
-- workspace's owners, or the workspace's owners only.
ALTER TABLE chat_settings ADD COLUMN manage_channels TEXT NOT NULL DEFAULT 'channel_owners' CHECK (manage_channels IN ('channel_owners', 'owners'));

-- The public channels someone new is put in the first time they open
-- Chat, as a JSON array of channel ids. NULL: #general.
ALTER TABLE chat_settings ADD COLUMN default_channels TEXT;
