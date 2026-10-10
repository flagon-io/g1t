-- The Marketplace: members' install requests (src/installs.ts), where a
-- member asks the workspace's owners to add an agent from the catalog, an
-- integration or an extension; and the extensions a workspace installed
-- (src/extensions.ts).

CREATE TABLE install_requests (
  id TEXT PRIMARY KEY,
  -- By id, not slug: a renamed workspace keeps its requests.
  workspace_id TEXT NOT NULL,
  -- `agent:<template>`, `integration:<connector>` or `extension:<id>` (@g1t/contracts marketplace.ts).
  listing TEXT NOT NULL,
  -- The listing's name when it was asked for, so a request still reads
  -- after the listing changes.
  name TEXT NOT NULL,
  note TEXT,
  requested_by TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  -- open, done or declined.
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at TEXT
);

-- One open request per person and listing: asking twice is one request.
CREATE UNIQUE INDEX install_requests_open ON install_requests (workspace_id, listing, requested_by_id) WHERE status = 'open';
CREATE INDEX install_requests_by_workspace ON install_requests (workspace_id, status, requested_at);

-- Extensions installed in a workspace: which version, on which plan, who
-- installed it, and whether it is switched on. An uninstalled extension
-- keeps its row, with when and by whom.
CREATE TABLE extension_installs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- `extension:<id>`.
  listing TEXT NOT NULL,
  version TEXT NOT NULL,
  -- `free` until listings have prices.
  plan TEXT NOT NULL DEFAULT 'free',
  installed_by TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  -- 1 on, 0 off: the kill switch.
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_by TEXT,
  disabled_at TEXT,
  -- A monthly cap on what it spends, in micro-dollars; null: the workspace's limit.
  budget_monthly_micros INTEGER,
  uninstalled_by TEXT,
  uninstalled_at TEXT
);

-- One live install per workspace and extension.
CREATE UNIQUE INDEX extension_installs_live ON extension_installs (workspace_id, listing) WHERE uninstalled_at IS NULL;
