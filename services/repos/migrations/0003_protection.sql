-- A protected repository's default branch changes only by merging a pull
-- request. Pushes to it are refused.
ALTER TABLE repos ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
