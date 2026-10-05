-- Who pays for a workspace, and on what terms. See src/accounts.rs.

-- A billing account: a workspace's own (`ws_<slug>`, a row only once its
-- terms differ from standard), or an enterprise (`ent_…`) paying for
-- several workspaces.
CREATE TABLE billing_accounts (
  id TEXT PRIMARY KEY,
  -- workspace or enterprise.
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  -- standard, comped or custom.
  terms_kind TEXT NOT NULL DEFAULT 'standard',
  discount_percent INTEGER NOT NULL DEFAULT 0,
  -- Replaces the ceiling trust would give, when set.
  ceiling_micros INTEGER,
  note TEXT NOT NULL DEFAULT '',
  -- When the terms end; standard after.
  terms_until TEXT,
  terms_set_by TEXT,
  terms_set_at TEXT,
  -- The payment provider's customer, for an enterprise's one bill.
  customer_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Workspaces an enterprise pays for. A workspace not here pays for itself.
CREATE TABLE account_members (
  workspace TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);
CREATE INDEX account_members_by_account ON account_members (account_id);

-- Every change made in sudo.g1t.sh, and who made it.
CREATE TABLE admin_actions (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  -- terms, create, attach, detach, credit.
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_actions_by_account ON admin_actions (account, created_at);

-- g1t's own workspace runs comped (it was LIMIT_EXEMPT).
INSERT INTO billing_accounts (id, kind, name, terms_kind, note, terms_set_by, terms_set_at, created_by, created_at)
VALUES ('ws_syntaqx', 'workspace', 'syntaqx', 'comped', 'g1t''s own workspace', 'migration', '2026-10-05T00:00:00Z', 'migration', '2026-10-05T00:00:00Z');
INSERT INTO admin_actions (id, account, action, detail, by, created_at)
VALUES ('adm_migration_syntaqx', 'ws_syntaqx', 'terms', 'standard → comped: g1t''s own workspace', 'migration', '2026-10-05T00:00:00Z');

-- Ceilings set by hand before accounts existed become custom terms.
INSERT INTO billing_accounts (id, kind, name, terms_kind, ceiling_micros, note, terms_set_by, terms_set_at, created_by, created_at)
SELECT 'ws_' || workspace, 'workspace', workspace, 'custom', ceiling_micros, 'Ceiling set before accounts', 'migration',
       '2026-10-05T00:00:00Z', 'migration', '2026-10-05T00:00:00Z'
FROM limits WHERE ceiling_micros IS NOT NULL AND workspace <> 'syntaqx';
