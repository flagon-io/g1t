-- When a comment's text was last edited, for "edited" beside it.
ALTER TABLE comments ADD COLUMN edited_at TEXT;

-- What a pull request was when it was closed (draft or open), so that
-- reopening it brings it back as that.
ALTER TABLE pulls ADD COLUMN closed_from TEXT;
