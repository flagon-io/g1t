-- Customize (docs.g1t.sh/guides/customize/): marketplaces a workspace
-- reads plugins from, the plugins it installed, and its connectors (MCP
-- servers connected once and given to agents). Formats are the open ones
-- Claude Code reads (@g1t/contracts claude-plugin.ts). Requests stay in
-- install_requests (0005), whose listings now name plugins, skills and
-- connectors too. extension_installs (0005) is no longer written.

-- A marketplace: where it is (MarketplaceSource, JSON) and its manifest as
-- last read (marketplace.json, JSON), so Discover lists from the cache.
-- The built-in marketplaces (claude-plugins-official, anthropic-agent-skills)
-- have no row of their own per workspace: their manifests are cached
-- under workspace_id '' and read by every workspace.
CREATE TABLE marketplaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  manifest TEXT,
  fetched_at TEXT,
  -- Why the manifest couldn't be read last time, if so.
  problem TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);
CREATE UNIQUE INDEX marketplaces_name ON marketplaces (workspace_id, name);

-- A plugin installed in a workspace: `name@marketplace`, where its files
-- were read from (FetchPlan, JSON) and at which commit, what it brought
-- (PluginComponents, JSON), and whether it is switched on. Uninstalling
-- keeps the row with when and by whom.
CREATE TABLE plugin_installs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  name TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  display_name TEXT,
  description TEXT NOT NULL DEFAULT '',
  version TEXT,
  sha TEXT,
  fetch TEXT NOT NULL,
  components TEXT NOT NULL DEFAULT '{}',
  -- The subagents in full (SubagentFile[], JSON), as hireable templates.
  agents TEXT NOT NULL DEFAULT '[]',
  problems TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_by TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  uninstalled_by TEXT,
  uninstalled_at TEXT
);
CREATE UNIQUE INDEX plugin_installs_live ON plugin_installs (workspace_id, ref) WHERE uninstalled_at IS NULL;

-- A library skill that came with a plugin keeps the plugin's ref, and its
-- name is unique within that plugin rather than the library: agents call
-- it as `plugin:name`.
ALTER TABLE skills ADD COLUMN plugin TEXT;
DROP INDEX skills_name;
CREATE UNIQUE INDEX skills_name ON skills (workspace_id, COALESCE(plugin, ''), name) WHERE archived_at IS NULL;

-- A connector: an MCP server the workspace connected. Its secrets (a
-- header's value, OAuth tokens and the client registration) are sealed
-- with AES-GCM under CONNECTORS_KEY, bound to the connector's id, and
-- never returned. `from` says where it came from (ConnectorFrom, JSON);
-- `tools` is the server's tool list as last read (McpTool[], JSON).
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT,
  about TEXT,
  -- none, header or oauth.
  auth TEXT NOT NULL DEFAULT 'none',
  header_name TEXT,
  -- Sealed JSON: { header?: value, oauth?: { client_id, client_secret?, access_token, refresh_token?, expires_at?, token_endpoint, scopes? } }.
  secrets TEXT,
  -- What the server said about who signed in, when the sign-in was done.
  signed_in_as TEXT,
  signed_in_at TEXT,
  -- An OAuth sign-in in progress: the state, the PKCE verifier and the endpoints, sealed; cleared when it completes.
  pending TEXT,
  pending_at TEXT,
  from_json TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT,
  problem TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE UNIQUE INDEX connectors_name ON connectors (workspace_id, name) WHERE removed_at IS NULL;

-- Where a connector reaches: every agent (scope workspace, target ''), a
-- team's agents (team, the team's slug), or one agent (agent, its id).
CREATE TABLE connector_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL
);
CREATE UNIQUE INDEX connector_grants_once ON connector_grants (connector_id, scope, target);
CREATE INDEX connector_grants_reach ON connector_grants (workspace_id, scope, target);
