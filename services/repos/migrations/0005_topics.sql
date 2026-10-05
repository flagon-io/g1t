-- What a repository is about, for search and Explore: a JSON array of
-- lowercase topics such as ["cli", "rust"], set from its settings.
ALTER TABLE repos ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';
