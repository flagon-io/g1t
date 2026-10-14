-- The commits a pull request's default merge messages read (merging.rs),
-- kept when its mergeability is worked out after a push (mergeability.rs),
-- so the merge box reads them here rather than from the git store.
-- `head` and `merge_base` are what they were read for: the list changes
-- only when one of them moves. `pair` is the mergeable_key ("head..base")
-- they were last confirmed for; they are used only while it is the pull
-- request's mergeable_key and `head` its head.
CREATE TABLE pull_message_commits (
  pull_id TEXT PRIMARY KEY,
  head TEXT NOT NULL,
  merge_base TEXT,
  pair TEXT NOT NULL,
  commits TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
