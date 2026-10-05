-- When the app was paused because its workspace reached its limit for
-- usage not yet paid for. Paused apps answer with a notice; they are
-- rebuilt from the same commit once the workspace is under it again.
ALTER TABLE apps ADD COLUMN paused_at TEXT;
