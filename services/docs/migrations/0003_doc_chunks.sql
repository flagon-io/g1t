-- Passages: pages and projects' docs files split by heading, for the
-- semantic index (Vectorize `g1t-docs`) and agents' recall
-- (docs/WORKSPACE.md, "Agents and docs"; services/docs src/chunks.ts,
-- src/indexer.ts).

-- One passage. `id` is `<page or file id>:<seq>`, the same as its
-- vector's. `hash` is of what is embedded (title, heading, text);
-- `vector_hash` is the hash the index holds a vector for, NULL when it
-- holds none yet: the two differ until the passage is embedded, which a
-- later save or the backfill retries. For a project's docs file,
-- `space_id` is the repo space's id, `repo_file_id` is `rf_<hash of space
-- and path>`, and `path` the file's.
CREATE TABLE doc_chunks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  page_id TEXT,
  repo_file_id TEXT,
  repo_id TEXT,
  path TEXT,
  seq INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  vector_hash TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((page_id IS NULL) <> (repo_file_id IS NULL))
);
CREATE INDEX doc_chunks_page ON doc_chunks (page_id, seq) WHERE page_id IS NOT NULL;
CREATE INDEX doc_chunks_file ON doc_chunks (repo_file_id, seq) WHERE repo_file_id IS NOT NULL;
CREATE INDEX doc_chunks_space ON doc_chunks (space_id);
CREATE INDEX doc_chunks_workspace ON doc_chunks (workspace_id);
CREATE INDEX doc_chunks_unembedded ON doc_chunks (workspace_id) WHERE vector_hash IS NULL OR vector_hash <> hash;

-- Full text over passages: recall's word fallback, and the heading a
-- search hit sits under.
CREATE VIRTUAL TABLE doc_chunks_fts USING fts5 (chunk_id UNINDEXED, space_id UNINDEXED, doc_id UNINDEXED, heading, text, tokenize = 'unicode61 remove_diacritics 2');

-- Passages embedded per workspace and hour: the cap (src/indexer.ts
-- EMBED_PER_HOUR) and what it cost (`tokens`, estimated as characters / 4).
CREATE TABLE doc_embed_usage (
  workspace_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  chunks INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, hour)
);

-- A workspace's backfill: (re)indexing its existing pages and projects'
-- docs in batches on the queue. `cursor` is where the next batch starts.
CREATE TABLE doc_index_runs (
  workspace_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  cursor TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0
);
