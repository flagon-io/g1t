-- A repository transferred to another workspace keeps its id, its git
-- store key and its name; only its namespace changes. The path it left
-- points at its id here, so old links, git remotes and API calls resolve
-- to wherever it is now, however many times it has moved since. A
-- redirect stops when a repository is made at its path (`create` deletes
-- it). There is no expiry: a deleted workspace's slug is never given to
-- anyone else, so its paths cannot be taken. See src/transfer.rs.
CREATE TABLE IF NOT EXISTS repo_redirects (
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, name)
);
CREATE INDEX IF NOT EXISTS repo_redirects_by_repo ON repo_redirects (repo_id);
