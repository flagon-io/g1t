-- Issues became work items of a workspace (the work service's
-- 0049_work_items). Items are kept by key: a work item by its id, a pull
-- request by its repository and number. A work item keeps its workspace,
-- its number there, its origin (where it was filed, if anywhere) and every
-- repository it is linked to.
--
-- Pull requests are copied as they are. Issues are dropped: they are
-- indexed again as work items, by id, when the work service's move
-- announces them (`work.migrated`), with their workspace and new number.

DROP TRIGGER items_ai;
DROP TRIGGER items_ad;
DROP TRIGGER items_au;
DROP TABLE items_fts;

CREATE TABLE items_next (
  iid INTEGER PRIMARY KEY,
  -- item or pull.
  kind TEXT NOT NULL,
  -- A work item's id; a pull request's repository id and number, `rep_…/12`.
  key TEXT NOT NULL UNIQUE,
  -- A pull request's repository; a work item's origin, if it has one.
  repo_id TEXT,
  -- A work item's workspace, lowercase.
  workspace TEXT,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- open or closed.
  state TEXT NOT NULL,
  -- A work item: open, completed or not_planned. A pull request: draft,
  -- open, merged or closed.
  status TEXT NOT NULL,
  -- Lowercase username.
  author TEXT NOT NULL,
  requested_by TEXT,
  -- Lowercase, each between bars: |bug|good first issue|.
  labels TEXT NOT NULL DEFAULT '|',
  -- A work item's linked repositories by id, each between bars:
  -- |rep_1|rep_2|.
  repos TEXT NOT NULL DEFAULT '|',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO items_next
  (iid, kind, key, repo_id, workspace, number, title, body, state, status, author, requested_by, labels, repos,
   created_at, updated_at)
SELECT iid, kind, repo_id || '/' || number, repo_id, NULL, number, title, body, state, status, author, requested_by,
  labels, '|', created_at, updated_at
FROM items WHERE kind = 'pull';

DROP TABLE items;
ALTER TABLE items_next RENAME TO items;

CREATE INDEX items_recent ON items (kind, updated_at);
CREATE INDEX items_by_author ON items (author);
CREATE INDEX items_by_repo ON items (repo_id);
CREATE INDEX items_by_workspace ON items (workspace, number);

CREATE VIRTUAL TABLE items_fts USING fts5(
  title, body,
  content = 'items', content_rowid = 'iid',
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
INSERT INTO items_fts (items_fts) VALUES ('rebuild');
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
