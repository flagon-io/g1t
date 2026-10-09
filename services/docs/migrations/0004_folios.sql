-- Folios: what people call artifacts. Artifacts mode is one mode for docs,
-- slides, designs and dashboards (docs/ARTIFACTS_MODE.md, section 2.2).
-- A folio's live content is a Yjs document in its room (FolioRoom,
-- src/folios/room.ts); these tables keep everything around it and the
-- text rendition the room saves after each burst of edits.
--
-- This migration only adds tables. Docs' pages keep working on theirs
-- until Phase 7 drops them. Keys are as in Docs: `user:<id>`,
-- `agent:<id>`, `team:<slug>`.

CREATE TABLE folios (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('doc', 'slides', 'design', 'dashboard')),
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  cover TEXT,
  -- Always a person: `user:<id>`. An agent's folio is owned by whoever it acted for.
  owner TEXT NOT NULL,
  -- NULL: the owner's Private section.
  space_id TEXT REFERENCES spaces (id),
  -- Only a doc is ever a parent. Children share their parent's space.
  parent_id TEXT REFERENCES folios (id),
  position REAL NOT NULL,
  -- 1: follows its parent (or, at the top, its space). 0: "Only people invited".
  inherit INTEGER NOT NULL DEFAULT 1,
  -- The nearest of itself and its ancestors with inherit = 0 or no parent.
  acl_root TEXT NOT NULL,
  -- '/<top id>/…/<id>/', for subtree updates.
  path TEXT NOT NULL,
  general_access TEXT NOT NULL DEFAULT 'none' CHECK (general_access IN ('none', 'workspace', 'link')),
  general_role TEXT CHECK (general_role IN ('view', 'comment', 'edit')),
  -- NULL: the space's, or 'suggest' in Private.
  agent_mode TEXT CHECK (agent_mode IN ('suggest', 'edit')),
  -- The kind's text rendition: search, recall, the read view, export.
  text TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  -- Small JSON a card draws; never data values.
  preview TEXT,
  -- JSON { title, href }: where it was written up from.
  source TEXT,
  -- People already told they were mentioned in it.
  mentioned TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Any change: rename, move, share.
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  -- Content changes: "Edited 45m ago".
  edited_by TEXT,
  edited_at TEXT NOT NULL,
  trashed_at TEXT,
  trashed_by TEXT
);
CREATE INDEX folios_tree ON folios (workspace_id, space_id, parent_id, position);
CREATE INDEX folios_owner ON folios (owner, edited_at) WHERE trashed_at IS NULL;
CREATE INDEX folios_recent ON folios (workspace_id, edited_at) WHERE trashed_at IS NULL;
CREATE INDEX folios_trashed ON folios (workspace_id, trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX folios_root ON folios (acl_root);
CREATE INDEX folios_path ON folios (path);
CREATE INDEX folios_parent ON folios (parent_id);

-- Explicit shares, as they were set.
CREATE TABLE folio_grants (
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('view', 'comment', 'edit', 'manage')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (folio_id, principal)
);

-- Effective explicit access, per folio, for list and search SQL: the
-- owner, the owners of ancestors it inherits from (as `manage`), and every
-- grant from the folio up to its acl_root, highest role each. Rebuilt for
-- a subtree (by `path`) on a grant, move, restriction or ownership change
-- (src/folios/access-store.ts).
CREATE TABLE folio_access (
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  principal TEXT NOT NULL,
  role TEXT NOT NULL,
  -- The folio whose grant or owner this is (itself or an ancestor).
  via TEXT NOT NULL,
  -- For "Shared with you" ordering.
  since TEXT NOT NULL,
  PRIMARY KEY (folio_id, principal)
);
CREATE INDEX folio_access_principal ON folio_access (principal, since);

-- Recent, and link access once opened.
CREATE TABLE folio_visits (
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (folio_id, user_id)
);
CREATE INDEX folio_visits_user ON folio_visits (user_id, last_at);

CREATE TABLE folio_favorites (
  user_id TEXT NOT NULL,
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  position REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, folio_id)
);

-- Open spaces a member shows in their sidebar.
CREATE TABLE space_joins (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  position REAL NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX space_joins_user ON space_joins (user_id);

-- History: the Yjs state (an exact restore) and the text (reading, diffs).
CREATE TABLE folio_versions (
  id TEXT PRIMARY KEY,
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'edit', 'agent', 'suggestion', 'proposal', 'restore')),
  authors TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  text TEXT NOT NULL,
  -- The Yjs state when it is at most 1.5 MB.
  state BLOB,
  -- Else its key in the file store.
  state_key TEXT
);
CREATE INDEX folio_versions_folio ON folio_versions (folio_id, created_at);

-- A doc's agents' tracked changes, as `suggestions` for pages.
CREATE TABLE folio_suggestions (
  id TEXT PRIMARY KEY,
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  asked_by TEXT,
  target TEXT NOT NULL,
  before_markdown TEXT NOT NULL,
  after_markdown TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'stale')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  marks_current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX folio_suggestions_folio ON folio_suggestions (folio_id, status);

-- Other kinds: an agent's whole change as a Yjs update, previewed and applied or rejected.
CREATE TABLE folio_proposals (
  id TEXT PRIMARY KEY,
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  asked_by TEXT,
  note TEXT,
  base_vector BLOB NOT NULL,
  update_blob BLOB,
  update_key TEXT,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'stale')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX folio_proposals_folio ON folio_proposals (folio_id, status);

-- The workspace's own templates; the built-in ones are in code.
CREATE TABLE folio_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('doc', 'slides', 'design', 'dashboard')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  -- Markdown (doc, slides) or a JSON spec (design, dashboard).
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX folio_templates_ws ON folio_templates (workspace_id, kind);

-- Files put in folios, kept in the file store under `docs/<key>` like pages' files.
CREATE TABLE folio_files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  folio_id TEXT REFERENCES folios (id) ON DELETE SET NULL,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX folio_files_folio ON folio_files (folio_id);

-- Links from one folio to another, rebuilt on each save: backlinks.
CREATE TABLE folio_links (
  from_folio TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  to_folio TEXT NOT NULL,
  PRIMARY KEY (from_folio, to_folio)
);
CREATE INDEX folio_links_to ON folio_links (to_folio);

-- Projects (repositories, `owner/name` lowercased) a folio is about.
CREATE TABLE folio_projects (
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  PRIMARY KEY (folio_id, repo)
);
CREATE INDEX folio_projects_repo ON folio_projects (repo);

-- Code a folio cites, as `citations` for pages.
CREATE TABLE folio_citations (
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('path', 'symbol', 'endpoint', 'env')),
  label TEXT NOT NULL DEFAULT '',
  ref TEXT,
  source TEXT NOT NULL CHECK (source IN ('body', 'header')),
  PRIMARY KEY (folio_id, source, repo, path, kind, label)
);
CREATE INDEX folio_citations_repo ON folio_citations (repo);

-- Changes that touched code a folio cites, as `page_changes`.
CREATE TABLE folio_changes (
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  pull_number INTEGER,
  pull_title TEXT,
  paths TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL,
  cleared_at TEXT,
  cleared_by TEXT,
  PRIMARY KEY (folio_id, repo, commit_sha)
);
CREATE INDEX folio_changes_open ON folio_changes (folio_id) WHERE cleared_at IS NULL;
CREATE INDEX folio_changes_recent ON folio_changes (detected_at) WHERE cleared_at IS NULL;

-- Full text over titles and text renditions; rebuilt for a folio on each save.
CREATE VIRTUAL TABLE folios_fts USING fts5 (folio_id UNINDEXED, kind UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');

-- Folios' passages for the semantic index (Vectorize `g1t-folios`) and
-- recall. `scope` is 'space:<id>' when the folio's access is exactly its
-- space's, else 'folio:<acl_root>'; every hit is checked again against
-- these tables before anyone sees it. Projects' docs keep `doc_chunks`.
CREATE TABLE folio_chunks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  folio_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  seq INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  vector_hash TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX folio_chunks_folio ON folio_chunks (folio_id, seq);
CREATE INDEX folio_chunks_workspace ON folio_chunks (workspace_id);
CREATE INDEX folio_chunks_unembedded ON folio_chunks (workspace_id) WHERE vector_hash IS NULL OR vector_hash <> hash;

CREATE VIRTUAL TABLE folio_chunks_fts USING fts5 (chunk_id UNINDEXED, scope UNINDEXED, folio_id UNINDEXED, heading, text, tokenize = 'unicode61 remove_diacritics 2');
