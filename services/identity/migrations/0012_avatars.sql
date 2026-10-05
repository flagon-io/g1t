-- Uploaded icons, as GitHub's organizations and people have. Each is the
-- SHA-256 of the image's bytes, which is also its key in the g1t-avatars
-- KV namespace, so an address never serves a stale image. Null means the
-- generated letter avatar.
ALTER TABLE workspaces ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;
