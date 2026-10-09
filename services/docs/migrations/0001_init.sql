-- Docs: spaces, pages, history, suggestions, templates and search
-- (docs/WORKSPACE.md, "Docs"). A page's live content is a Yjs document in
-- its Durable Object (src/room.ts); this database keeps everything around
-- it and the Markdown rendition the room saves after each burst of edits.
-- Workspaces are kept by id; members are keys: `user:<id>`, `agent:<id>`,
-- `team:<slug>`.

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  -- workspace: every member gets default_role; team: the team's members do;
  -- private: only listed members.
  kind TEXT NOT NULL CHECK (kind IN ('workspace', 'team', 'private')),
  team TEXT,
  default_role TEXT CHECK (default_role IN ('view', 'comment', 'edit', 'manage')),
  agent_mode TEXT NOT NULL DEFAULT 'suggest' CHECK (agent_mode IN ('suggest', 'edit')),
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (workspace_id, slug)
);

-- One General space per workspace, made the first time Docs is opened.
CREATE UNIQUE INDEX spaces_default ON spaces (workspace_id) WHERE is_default = 1;

CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('view', 'comment', 'edit', 'manage')),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (space_id, principal)
);

-- Projects (repositories, `owner/name` lowercased) a space is about.
CREATE TABLE space_projects (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  PRIMARY KEY (space_id, repo)
);
CREATE INDEX space_projects_repo ON space_projects (repo);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  parent_id TEXT,
  position REAL NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  cover TEXT,
  -- As the room last saved it: the read view, search, agents and export.
  markdown TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  archived_by TEXT,
  -- People already told they were mentioned in the page, so a save tells only the new ones.
  mentioned TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX pages_tree ON pages (space_id, parent_id, position);
CREATE INDEX pages_recent ON pages (workspace_id, updated_at);

CREATE TABLE page_owners (
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  principal TEXT NOT NULL,
  PRIMARY KEY (page_id, principal)
);
CREATE INDEX page_owners_principal ON page_owners (principal);

CREATE TABLE page_projects (
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  PRIMARY KEY (page_id, repo)
);
CREATE INDEX page_projects_repo ON page_projects (repo);

-- Links from one page to another, rebuilt on each save: backlinks.
CREATE TABLE page_links (
  from_page TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  to_page TEXT NOT NULL,
  PRIMARY KEY (from_page, to_page)
);
CREATE INDEX page_links_to ON page_links (to_page);

CREATE TABLE page_views (
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX page_views_user ON page_views (user_id, viewed_at);

CREATE TABLE favorites (
  user_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

-- History: the Yjs state (for an exact restore) and its Markdown (for
-- reading and diffs). `state` is null when it was too large to keep; a
-- restore then rebuilds the page from the Markdown.
CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'edit', 'agent', 'suggestion', 'restore')),
  authors TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  markdown TEXT NOT NULL,
  state BLOB
);
CREATE INDEX page_versions_page ON page_versions (page_id, created_at);

-- Agents' tracked changes, waiting for a person.
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  asked_by TEXT,
  target TEXT NOT NULL,
  before_markdown TEXT NOT NULL,
  after_markdown TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'stale')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX suggestions_page ON suggestions (page_id, status);

-- The workspace's own templates; the built-in ones are in src/templates.ts.
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '📄',
  markdown TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX templates_workspace ON templates (workspace_id);

-- Files put in pages, kept in the files bucket under `key`.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  page_id TEXT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Full text over titles and Markdown; rebuilt for a page on each save.
CREATE VIRTUAL TABLE pages_fts USING fts5 (page_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
