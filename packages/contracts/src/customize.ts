/**
 * Deprecated: g1t no longer runs agents of its own. Kept only until
 * apps/mobile drops its Customize screens, which import it; delete it
 * afterwards.
 */
/**
 * Customize (docs.g1t.sh/guides/customize/): one place for what shapes
 * how a workspace's agents work, in three parts, each with what the
 * workspace has (**Yours**) and what it can add (**Discover**). It is the
 * Marketplace's successor on the site and the phone.
 *
 * - **Skills**: what agents know how to do, in the open SKILL.md format
 *   (./skill-library.ts, ./skill-format.ts): g1t's foundational skills,
 *   the workspace's library, and every skill published in a marketplace.
 * - **Connectors**: what agents can reach: MCP servers (./claude-plugin.ts
 *   `.mcp.json`, the directory in ./connectors.ts, and any address an
 *   owner adds), and g1t's own integrations (GitHub, trackers, alerts,
 *   model providers).
 * - **Plugins**: folders in the open plugin format (./claude-plugin.ts),
 *   found in marketplaces, each bringing skills, agents and connectors to
 *   g1t's agents and everything else to Claude Code on a runner.
 *
 * Everything installable keeps the names the open ecosystem uses:
 * `name@marketplace` for a plugin, `plugin:skill` for a skill inside one.
 * Wire shapes are snake_case. No imports beyond types, so it runs
 * anywhere: services, the site, the phone.
 */

import type { FetchPlan, MarketplaceSource, McpServerConfig, PluginLayout, SubagentFile } from "./claude-plugin";
import type { ConnectorCategory } from "./connectors";
import type { ListingKind } from "./marketplace";

/** A tool an MCP server offers, as it describes it. */
export type McpTool = {
  name: string;
  description: string;
  /** `read` when the server says the tool only reads; `write` otherwise, which is also what an unknown tool is. */
  kind: "read" | "write";
  /** Its arguments, as the server describes them (JSON Schema). */
  input_schema: Record<string, unknown>;
};

/** What a skill was attached to. */
export type SkillScope = "agent" | "team" | "workspace";

export type CustomizeSection = "skills" | "connectors" | "plugins";

export const CUSTOMIZE_SECTIONS: readonly CustomizeSection[] = ["skills", "connectors", "plugins"];

export type CustomizeSectionInfo = {
  id: CustomizeSection;
  title: string;
  /** One line, for the section's row. */
  description: string;
  /** Where the site shows it, with `:workspace` to fill in. */
  sitePath: string;
};

export const CUSTOMIZE: Record<CustomizeSection, CustomizeSectionInfo> = {
  skills: {
    id: "skills",
    title: "Skills",
    description: "What agents know how to do: the skills every agent has, your workspace's library, and public skills to add.",
    sitePath: "/:workspace/-/customize/skills",
  },
  connectors: {
    id: "connectors",
    title: "Connectors",
    description: "What agents can reach: MCP servers and the tools your team already uses, connected once and given to agents.",
    sitePath: "/:workspace/-/customize/connectors",
  },
  plugins: {
    id: "plugins",
    title: "Plugins",
    description: "Skills, agents and connectors published together, from any marketplace in the open plugin format.",
    sitePath: "/:workspace/-/customize/plugins",
  },
};

/** The part of Customize that shows a listing of this kind. */
export function sectionOfListing(kind: ListingKind): CustomizeSection {
  if (kind === "integration" || kind === "connector") return "connectors";
  if (kind === "skill") return "skills";
  return "plugins";
}

/** Customize's pages, under `/<workspace>/-/customize`. */
export function customizePath(section: CustomizeSection | "" | "requests" | "marketplaces", workspace: string, rest = ""): string {
  const base = `/${encodeURIComponent(workspace)}/-/customize`;
  return `${base}${section ? `/${section}` : ""}${rest ? `/${rest}` : ""}`;
}

// ── Marketplaces ─────────────────────────────────────────────────────────

/** A marketplace a workspace reads plugins from, as its page lists it. */
export type Marketplace = {
  /** Its name, as its manifest says and as `name@marketplace` uses. */
  name: string;
  source: MarketplaceSource;
  /** Built in: every workspace has it, and it can't be removed. */
  builtin: boolean;
  about: string | null;
  owner: string | null;
  /** How many plugins it lists, and how many of those carry skills. */
  plugins: number;
  /** RFC 3339: when its manifest was last read, and why it couldn't be, if so. */
  fetched_at: string | null;
  problem: string | null;
  added_by: string | null;
  added_at: string | null;
  can_remove: boolean;
};

/** Whether a plugin from Discover can be installed here, now. */
export type PluginAvailability =
  /** Installable now. */
  | { kind: "available" }
  /** The workspace has it (switched off, if `enabled` is false). */
  | { kind: "installed"; enabled: boolean }
  /** Listed but not something g1t can fetch (npm, a command, a git host g1t doesn't read), with why. It still works in Claude Code. */
  | { kind: "unavailable"; why: string }
  /** g1t's own, announced but not released. */
  | { kind: "soon" };

/** What a plugin would bring, worked out from its layout, before or after installing. */
export type PluginComponents = {
  /** Skills by name (`plugin:name` to agents). */
  skills: { name: string; description: string | null; path: string }[];
  /** Subagents by name, as hireable starting points. */
  agents: { name: string; description: string | null; path: string }[];
  /** Commands: the older one-file form of a skill. */
  commands: { name: string; path: string }[];
  /** MCP servers it names: remote ones become connectors; stdio ones are for Claude Code only. */
  mcp_servers: { name: string; type: McpServerConfig["type"]; url: string | null; remote: boolean }[];
  /** What only Claude Code on a runner uses. */
  hooks: boolean;
  lsp: boolean;
  bin: boolean;
  output_styles: boolean;
};

/** One plugin as Discover lists it, from a marketplace. */
export type PluginListing = {
  /** `name@marketplace`. */
  ref: string;
  name: string;
  marketplace: string;
  display_name: string | null;
  description: string;
  version: string | null;
  author: string | null;
  homepage: string | null;
  category: string | null;
  tags: string[];
  keywords: string[];
  /** Where g1t would read it from, when it can. */
  fetch: FetchPlan;
  availability: PluginAvailability;
  /** Skills the entry names outright (a skills-only plugin), so Discover can list them without fetching. */
  skills: string[];
};

/** A plugin the workspace installed. */
export type PluginInstall = {
  id: string;
  /** `name@marketplace`. */
  ref: string;
  name: string;
  marketplace: string;
  display_name: string | null;
  description: string;
  version: string | null;
  /** The commit it was read at, when the source has one; the ref otherwise. */
  sha: string | null;
  fetch: FetchPlan;
  components: PluginComponents;
  /** What couldn't be read when it was installed. */
  problems: string[];
  enabled: boolean;
  installed_by: string;
  installed_at: string;
  /** A newer version in the marketplace, when the listing moved on. */
  update: { version: string | null; sha: string | null } | null;
};

/** A plugin's page: the listing, the install if any, and what it holds, read from its source. */
export type PluginDetail = {
  listing: PluginListing;
  install: PluginInstall | null;
  components: PluginComponents | null;
  readme: string | null;
  /** The plugin's manifest, when it has one. */
  manifest: { name: string; version: string | null; license: string | null; repository: string | null } | null;
  /** The subagents in full, for the hire flow. */
  agents: SubagentFile[];
  problems: string[];
  /** The marketplace it is listed in, for the header. */
  source: { marketplace: string; owner: string | null };
};

// ── Skills in Discover ───────────────────────────────────────────────────

/** One skill as Discover lists it: a skill inside a marketplace's plugin. */
export type SkillListing = {
  /** `plugin:skill`. */
  ref: string;
  name: string;
  plugin: string;
  marketplace: string;
  /** The plugin's description until the skill's own is read. */
  description: string;
  category: string | null;
  author: string | null;
  /** Whether the workspace's library already has it from this plugin. */
  added: boolean;
  /** Whether the plugin it is in can be fetched here. */
  availability: PluginAvailability;
};

// ── Connectors ───────────────────────────────────────────────────────────

/** How a connector signs in to its server. */
export type ConnectorAuth = "none" | "header" | "oauth";

/** Where a connector came from. */
export type ConnectorFrom =
  | { kind: "directory"; id: string }
  | { kind: "plugin"; ref: string; server: string }
  | { kind: "address" }
  /** An MCP server kept on one agent before connectors existed. */
  | { kind: "agent"; handle: string };

/** Whether a connector can be used now. */
export type ConnectorState = "connected" | "needs_sign_in" | "needs_key" | "problem";

/** A workspace's connector: an MCP server connected once, then given to agents. */
export type WorkspaceConnector = {
  /** `con_…`. */
  id: string;
  /** 2 to 32 lowercase letters, digits and hyphens; tools are offered as `<name>__<tool>`. */
  name: string;
  /** For the page: the directory's name, or the name again. */
  title: string;
  url: string;
  category: ConnectorCategory | null;
  about: string | null;
  auth: ConnectorAuth;
  state: ConnectorState;
  /** Why it is a problem, when it is. */
  problem: string | null;
  from: ConnectorFrom;
  tools: McpTool[];
  /** RFC 3339: when its tools were last listed. */
  checked_at: string | null;
  /** The header's name when `auth` is header (its value is never shown). */
  header_name: string | null;
  /** For OAuth: who it is signed in as, if the server said, and when the sign-in was done. */
  signed_in_as: string | null;
  signed_in_at: string | null;
  grants: ConnectorGrant[];
  added_by: string;
  added_at: string;
};

/** Where a connector reaches: every agent, a team's, or one. */
export type ConnectorGrant = {
  id: string;
  scope: SkillScope;
  /** The agent's handle, the team's slug, or null for the workspace. */
  target: string | null;
  label: string;
  granted_by: string;
  granted_at: string;
};

/** What an owner sends to add a connector. */
export type ConnectorInput = {
  /** From the directory (its id), a plugin's server (`ref` and `server`), or by address. */
  from: { kind: "directory"; id: string } | { kind: "plugin"; ref: string; server: string } | { kind: "address"; name: string; url: string };
  auth: ConnectorAuth;
  /** For `header`: the header's name and its value, kept sealed. */
  header?: { name: string; value: string } | null;
};

/** Starting an OAuth sign-in for a connector: where the browser goes. */
export type ConnectorSignIn = { url: string };

// ── Agents and what reaches them ─────────────────────────────────────────

/** A connector as one agent's Abilities tab lists it. */
export type AgentConnector = {
  id: string;
  name: string;
  title: string;
  state: ConnectorState;
  /** How the agent has it. */
  via: SkillScope | "agent-only";
  via_label: string;
  tools: number;
};

// ── The bundle a runner gets ─────────────────────────────────────────────

/**
 * What a job's Claude Code receives from the workspace's Customize
 * (docs.g1t.sh/guides/self-hosted-runners/, "What a run gets from
 * Customize"): plugins to fetch at their pinned commit, the library's skills
 * as files, and connectors with the headers that sign them in. Read with
 * the job's agent token, once per job.
 */
export type CustomizeBundle = {
  plugins: { ref: string; name: string; fetch: FetchPlan; version: string | null }[];
  /** Library skills, each a folder: SKILL.md and its files, as `path` and content. */
  skills: { name: string; plugin: string | null; files: { path: string; content: string; encoding: "utf8" | "base64" }[] }[];
  /** Connectors the job's agent has, with what to send; secrets included, so this never leaves the runner. */
  connectors: { name: string; url: string; headers: Record<string, string> }[];
};

/** Something to hire from a plugin's `agents/` folder, as a template. */
export type PluginAgentTemplate = {
  /** `plugin:agent`. */
  ref: string;
  plugin: string;
  marketplace: string;
  name: string;
  description: string;
  /** The system prompt, as the agent's instructions. */
  prompt: string;
  model: string | null;
  skills: string[];
  tools: string[];
};

/** The layout of a plugin turned into what it brings. */
export function componentsOf(layout: PluginLayout, servers: McpServerConfig[], skillDescriptions: Record<string, string | null> = {}, agentDescriptions: Record<string, string | null> = {}): PluginComponents {
  return {
    skills: layout.skills.map((s) => ({ name: s.name, description: skillDescriptions[s.path] ?? null, path: s.path })),
    agents: layout.agents.map((a) => ({ name: a.name, description: agentDescriptions[a.path] ?? null, path: a.path })),
    commands: layout.commands.map((c) => ({ name: c.name, path: c.path })),
    mcp_servers: servers.map((s) => ({ name: s.name, type: s.type, url: s.url, remote: s.type === "http" || s.type === "sse" })),
    hooks: layout.hooks.length > 0,
    lsp: layout.lsp,
    bin: layout.bin,
    output_styles: layout.outputStyles,
  };
}

/** The most marketplaces a workspace adds, and the most plugins it installs. */
export const MAX_MARKETPLACES = 20;
export const MAX_PLUGIN_INSTALLS = 100;
/** The most connectors a workspace keeps. */
export const MAX_CONNECTORS = 50;
