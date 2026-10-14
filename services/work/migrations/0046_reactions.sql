-- Emoji reactions to an issue's or a pull request's description and to
-- the comments on it (reactions.rs). `subject` is the comment's id, or
-- the issue's or pull request's own id for its description; `number`
-- is the issue or pull request, so a conversation's reactions are read
-- with its comments in one statement.
CREATE TABLE reactions (
  subject TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject, user_id, content)
);

CREATE INDEX reactions_by_thread ON reactions (repo_id, number);
CREATE INDEX reactions_by_user ON reactions (user_id);
