-- Search across all of g1t: repositories, code on default branches, issues
-- and pull requests, people and workspaces. Each kind is a table of what
-- is shown and an FTS5 index over it, kept in step by triggers. Prose is
-- tokenized as words (unicode61, so `pars*` finds `parser`); code by
-- trigram, so any run of three characters or more is found, as in an
-- editor. Who may see a row is decided when a query runs, from `repos`:
-- every row of code, issues and pull requests joins its repository.
-- Every timestamp is RFC 3339 UTC.

-- Every repository that is not a pull request's fork, public or private.
CREATE TABLE repos (
  rid INTEGER PRIMARY KEY,
  repo_id TEXT NOT NULL UNIQUE,
  -- Lowercase, as the address has them.
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- Space-separated, lowercase.
  topics TEXT NOT NULL DEFAULT '',
  -- The opening of the README on its default branch.
  readme TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- What most of its indexed code is written in.
  language TEXT,
  -- The commit its code was last indexed at.
  head TEXT,
  -- `pending`, `indexing`, `done`, or `partial` when it was too large to
  -- index all of.
  state TEXT NOT NULL DEFAULT 'pending',
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX repos_by_path ON repos (namespace, name);
CREATE INDEX repos_active ON repos (private, pushed_at);
CREATE INDEX repos_new ON repos (private, created_at);
CREATE INDEX repos_by_language ON repos (private, language);

CREATE VIRTUAL TABLE repos_fts USING fts5(
  namespace, name, description, topics, readme,
  content = 'repos', content_rowid = 'rid',
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE TRIGGER repos_ai AFTER INSERT ON repos BEGIN
  INSERT INTO repos_fts (rowid, namespace, name, description, topics, readme)
  VALUES (new.rid, new.namespace, new.name, new.description, new.topics, new.readme);
END;
CREATE TRIGGER repos_ad AFTER DELETE ON repos BEGIN
  INSERT INTO repos_fts (repos_fts, rowid, namespace, name, description, topics, readme)
  VALUES ('delete', old.rid, old.namespace, old.name, old.description, old.topics, old.readme);
END;
CREATE TRIGGER repos_au AFTER UPDATE OF namespace, name, description, topics, readme ON repos BEGIN
  INSERT INTO repos_fts (repos_fts, rowid, namespace, name, description, topics, readme)
  VALUES ('delete', old.rid, old.namespace, old.name, old.description, old.topics, old.readme);
  INSERT INTO repos_fts (rowid, namespace, name, description, topics, readme)
  VALUES (new.rid, new.namespace, new.name, new.description, new.topics, new.readme);
END;

-- A repository's topics, one row each, for Explore.
CREATE TABLE repo_topics (
  topic TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  PRIMARY KEY (topic, repo_id)
);
CREATE INDEX repo_topics_by_repo ON repo_topics (repo_id);

-- Each file of a default branch: indexed, or recorded as skipped so it is
-- not read again until its blob changes.
CREATE TABLE files (
  fid INTEGER PRIMARY KEY,
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  language TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  -- Why it is not indexed: vendored, lockfile, binary, minified, too large.
  skipped TEXT,
  UNIQUE (repo_id, path)
);
CREATE INDEX files_by_language ON files (language);

-- A file in pieces of at most 120 lines, so a match reads only the piece
-- it is in. `path` is repeated so a query matches names and contents
-- together.
CREATE TABLE chunks (
  cid INTEGER PRIMARY KEY,
  fid INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX chunks_by_file ON chunks (fid, start_line);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  path, content,
  content = 'chunks', content_rowid = 'cid',
  tokenize = 'trigram'
);
-- A match in a file's path counts four times one in its contents. Read
-- through the rank column, which a query may take the minimum of.
INSERT INTO chunks_fts (chunks_fts, rank) VALUES ('rank', 'bm25(4.0, 1.0)');
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, path, content) VALUES (new.cid, new.path, new.content);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, path, content) VALUES ('delete', old.cid, old.path, old.content);
END;

-- Files a push or a backfill changed, waiting to be read: `blob` null to
-- remove the file. Drained a capped number at a time.
CREATE TABLE pending (
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob TEXT,
  queued_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
);

-- Issues and pull requests.
CREATE TABLE items (
  iid INTEGER PRIMARY KEY,
  repo_id TEXT NOT NULL,
  -- issue or pull.
  kind TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- open or closed.
  state TEXT NOT NULL,
  -- An issue: open, completed or not_planned. A pull request: draft,
  -- open, merged or closed.
  status TEXT NOT NULL,
  -- Lowercase username.
  author TEXT NOT NULL,
  -- Lowercase, each between bars: |bug|good first issue|.
  labels TEXT NOT NULL DEFAULT '|',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, kind, number)
);
CREATE INDEX items_recent ON items (kind, updated_at);
CREATE INDEX items_by_author ON items (author);

CREATE VIRTUAL TABLE items_fts USING fts5(
  title, body,
  content = 'items', content_rowid = 'iid',
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, title, body) VALUES (new.iid, new.title, new.body);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.iid, old.title, old.body);
END;
CREATE TRIGGER items_au AFTER UPDATE OF title, body ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.iid, old.title, old.body);
  INSERT INTO items_fts (rowid, title, body) VALUES (new.iid, new.title, new.body);
END;

-- People and workspaces, as their public pages show them.
CREATE TABLE people (
  pid INTEGER PRIMARY KEY,
  -- user or workspace.
  kind TEXT NOT NULL,
  -- A username, or a workspace's id (its slug can change).
  ref TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT,
  bio TEXT,
  avatar TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, ref)
);
CREATE INDEX people_by_slug ON people (slug);

CREATE VIRTUAL TABLE people_fts USING fts5(
  slug, name, bio,
  content = 'people', content_rowid = 'pid',
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE TRIGGER people_ai AFTER INSERT ON people BEGIN
  INSERT INTO people_fts (rowid, slug, name, bio) VALUES (new.pid, new.slug, new.name, new.bio);
END;
CREATE TRIGGER people_ad AFTER DELETE ON people BEGIN
  INSERT INTO people_fts (people_fts, rowid, slug, name, bio) VALUES ('delete', old.pid, old.slug, old.name, old.bio);
END;
CREATE TRIGGER people_au AFTER UPDATE OF slug, name, bio ON people BEGIN
  INSERT INTO people_fts (people_fts, rowid, slug, name, bio) VALUES ('delete', old.pid, old.slug, old.name, old.bio);
  INSERT INTO people_fts (rowid, slug, name, bio) VALUES (new.pid, new.slug, new.name, new.bio);
END;

-- The service's own state: when the backfill started and finished.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
