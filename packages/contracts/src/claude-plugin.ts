/**
 * Deprecated: g1t no longer runs agents of its own. Kept only until
 * apps/mobile drops its Customize screens, which import it; delete it
 * afterwards.
 */
/**
 * The open plugin formats (docs.g1t.sh/guides/customize/, "The formats"):
 * what Claude Code reads, read here the same way, so a marketplace, a
 * plugin, a skill, a subagent or an MCP server published anywhere installs
 * on g1t as it is. g1t adds no keys of its own and ignores what it doesn't
 * know, as Claude Code does.
 *
 * - A **marketplace** is a repository (or a URL) holding
 *   `.claude-plugin/marketplace.json`: a name, an owner and the plugins it
 *   lists, each with a `source` saying where the plugin's files are.
 * - A **plugin** is a folder with an optional `.claude-plugin/plugin.json`
 *   and a known layout: `skills/<name>/SKILL.md`, `commands/*.md`,
 *   `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `bin/`.
 * - A **subagent** is `agents/<name>.md`: front-matter (name, description,
 *   tools, model, skills…) and the system prompt as its body.
 * - `.mcp.json` names MCP servers: `{ mcpServers: { name: { type, url… } } }`.
 *
 * Pure and standalone (no imports), so services, the site, the phone and
 * Node's tests use it as it is. A subagent file's front-matter is split
 * and parsed with ./skill-format.ts's functions, then read here.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

// ── Names ────────────────────────────────────────────────────────────────

/** A marketplace's name: letters, digits, `.`, `_` and `-`, starting with a letter or digit, no `..`. */
export function marketplaceNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "A marketplace has a name.";
  if (name.length > 64) return "A marketplace's name is at most 64 characters.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) return "A marketplace's name is letters, digits, dots, underscores and hyphens, starting with a letter or digit.";
  return null;
}

/**
 * Names Claude Code keeps for its own marketplaces, which g1t keeps the
 * same way: a workspace can't add a marketplace under one of them, so
 * `plugin@claude-plugins-official` always means the real thing.
 */
export const RESERVED_MARKETPLACE_NAMES: readonly string[] = [
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "anthropic-agent-skills",
  "life-sciences",
  "knowledge-work-plugins",
  "claude-for-legal",
  "claude-for-financial-services",
  "financial-services-plugins",
  "first-party-plugins",
  "claude-tag-plugins",
  "claude-community",
  "claude-plugins-community",
  "healthcare",
  "inline",
  "builtin",
  "skills-dir",
  "synced",
  "npm",
  "pip",
  "uv",
  "cargo",
  "github",
  "gh",
  "g1t",
];

/** Whether a marketplace name is reserved (the list above, and anything starting `claudeai-`). */
export function isReservedMarketplaceName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_MARKETPLACE_NAMES.includes(lower) || lower.startsWith("claudeai-");
}

/** A plugin's name: kebab-case, no spaces, `@`, `:` or path separators. */
export function pluginNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "A plugin has a name.";
  if (name.length > 64) return "A plugin's name is at most 64 characters.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) return "A plugin's name is letters, digits, dots, underscores and hyphens, like pr-review-toolkit.";
  return null;
}

/** `name@marketplace`: how a plugin is named everywhere (settings, installs, requests). */
export function pluginRef(name: string, marketplace: string): string {
  return `${name}@${marketplace}`;
}

/** `name@marketplace` split; null when it isn't one. */
export function parsePluginRef(value: unknown): { name: string; marketplace: string } | null {
  if (typeof value !== "string") return null;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  const name = value.slice(0, at);
  const marketplace = value.slice(at + 1);
  if (pluginNameProblem(name) || marketplaceNameProblem(marketplace)) return null;
  return { name, marketplace };
}

/** A plugin's component as it is named to agents and people: `plugin:skill`. */
export function namespaced(plugin: string, component: string): string {
  return `${plugin}:${component}`;
}

// ── Sources ──────────────────────────────────────────────────────────────

/** Where a plugin's files are, as a marketplace entry says (Claude Code's `source`). */
export type PluginSource =
  | { source: "path"; path: string }
  | { source: "github"; repo: string; ref?: string; sha?: string }
  | { source: "url"; url: string; ref?: string; sha?: string }
  | { source: "git-subdir"; url: string; path: string; ref?: string; sha?: string }
  | { source: "npm"; package: string; version?: string; registry?: string }
  | { source: "archive"; url: string; sha256?: string }
  | { source: "command"; command: string; timeout?: number; mode?: "copy" | "link" };

/**
 * Where a marketplace is: a GitHub repository, a git URL, a direct link to
 * its `marketplace.json`, a repository on this g1t, or one g1t builds in.
 */
export type MarketplaceSource =
  | { source: "github"; repo: string; ref?: string }
  | { source: "git"; url: string; ref?: string }
  | { source: "url"; url: string }
  | { source: "g1t"; repo: string; ref?: string }
  | { source: "builtin"; id: string };

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const sha40 = (value: unknown): string | undefined => (typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined);

/** `owner/repo` as GitHub names it; null otherwise. */
export function githubRepoProblem(repo: unknown): string | null {
  if (typeof repo !== "string") return "Name the repository as owner/repo.";
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(repo) && !repo.endsWith(".git") && !repo.includes("..") ? null : "Name the repository as owner/repo.";
}

/** A plugin entry's `source`, read: a relative path, or an object naming where its files are. */
export function parsePluginSource(raw: unknown): Checked<PluginSource> {
  if (typeof raw === "string") {
    if (!raw.startsWith("./") || raw.includes("..")) return bad("A plugin's path starts with ./ and stays inside the marketplace.");
    return { ok: true, value: { source: "path", path: raw.replace(/\/+$/, "") } };
  }
  if (!raw || typeof raw !== "object") return bad("A plugin's source is a path or an object.");
  const s = raw as Record<string, unknown>;
  switch (s.source) {
    case "github": {
      const problem = githubRepoProblem(s.repo);
      if (problem) return bad(problem);
      return { ok: true, value: { source: "github", repo: s.repo as string, ...(str(s.ref) ? { ref: str(s.ref) } : {}), ...(sha40(s.sha) ? { sha: sha40(s.sha) } : {}) } };
    }
    case "url": {
      const url = str(s.url);
      if (!url || !/^https?:\/\//.test(url)) return bad("A url source is an https address.");
      return { ok: true, value: { source: "url", url, ...(str(s.ref) ? { ref: str(s.ref) } : {}), ...(sha40(s.sha) ? { sha: sha40(s.sha) } : {}) } };
    }
    case "git-subdir": {
      const url = str(s.url);
      const path = str(s.path);
      if (!url) return bad("A git-subdir source names the repository's url.");
      if (!path || path.startsWith("/") || path.includes("..")) return bad("A git-subdir source names a folder inside the repository.");
      return { ok: true, value: { source: "git-subdir", url, path: path.replace(/^\.\//, "").replace(/\/+$/, ""), ...(str(s.ref) ? { ref: str(s.ref) } : {}), ...(sha40(s.sha) ? { sha: sha40(s.sha) } : {}) } };
    }
    case "npm": {
      const pkg = str(s.package);
      if (!pkg) return bad("An npm source names the package.");
      return { ok: true, value: { source: "npm", package: pkg, ...(str(s.version) ? { version: str(s.version) } : {}), ...(str(s.registry) ? { registry: str(s.registry) } : {}) } };
    }
    case "archive": {
      const url = str(s.url);
      if (!url || !/^https:\/\//.test(url)) return bad("An archive source is an https address of a zip file.");
      return { ok: true, value: { source: "archive", url, ...(typeof s.sha256 === "string" && /^[0-9a-f]{64}$/i.test(s.sha256) ? { sha256: s.sha256.toLowerCase() } : {}) } };
    }
    case "command": {
      const command = str(s.command);
      if (!command) return bad("A command source says the command.");
      return { ok: true, value: { source: "command", command, ...(typeof s.timeout === "number" ? { timeout: s.timeout } : {}), ...(s.mode === "link" ? { mode: "link" as const } : {}) } };
    }
    default:
      return bad(`g1t doesn't know the plugin source "${String(s.source)}".`);
  }
}

/**
 * A GitHub repository from the ways people write one: `owner/repo`,
 * `owner/repo#ref`, `owner/repo@ref`, or any github.com address (with or
 * without `.git`, with a `/tree/<ref>` path). Null when it isn't one.
 */
export function githubRepoOf(text: string): { repo: string; ref?: string; path?: string } | null {
  const value = text.trim();
  const short = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+?)(?:\.git)?(?:[#@]([^\s#@]+))?$/.exec(value);
  if (short && !value.includes("://") && !value.includes(":")) {
    return { repo: short[1]!, ...(short[2] ? { ref: short[2] } : {}) };
  }
  const web = /^(?:https?:\/\/|git@)(?:www\.)?github\.com[/:]([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?(?:[#@]([^\s#@]+))?$/.exec(value);
  if (!web) return null;
  const ref = web[2] ?? web[4];
  return { repo: web[1]!, ...(ref ? { ref } : {}), ...(web[3] ? { path: web[3].replace(/\/+$/, "") } : {}) };
}

/**
 * A marketplace as someone types it into **Add a marketplace**, the forms
 * Claude Code's `plugin marketplace add` takes: `owner/repo` (GitHub), a
 * github.com or git address, a direct link to `marketplace.json`, or, on
 * g1t, a repository here as `workspace/name` when `here` says that name is
 * one of this g1t's.
 */
export function parseMarketplaceAddress(text: string, options: { here?: (repo: string) => boolean; host?: string } = {}): Checked<MarketplaceSource> {
  const value = text.trim();
  if (!value) return bad("Say where the marketplace is: owner/repo on GitHub, a repository here, or a link.");
  if (/^https?:\/\/.*\/marketplace\.json(\?.*)?$/i.test(value)) return { ok: true, value: { source: "url", url: value } };
  if (options.host) {
    const own = new RegExp(`^https?://(?:www\\.)?${options.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+?)(?:\\.git)?/?(?:[#@]([^\\s#@]+))?$`, "i").exec(value);
    if (own) return { ok: true, value: { source: "g1t", repo: own[1]!, ...(own[2] ? { ref: own[2] } : {}) } };
  }
  const github = githubRepoOf(value);
  if (github && !value.includes("://") && options.here?.(github.repo)) return { ok: true, value: { source: "g1t", repo: github.repo, ...(github.ref ? { ref: github.ref } : {}) } };
  if (github) return { ok: true, value: { source: "github", repo: github.repo, ...(github.ref ? { ref: github.ref } : {}) } };
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(value)) {
    const ref = /[#]([^\s#]+)$/.exec(value)?.[1];
    return { ok: true, value: { source: "git", url: value.replace(/#[^\s#]+$/, ""), ...(ref ? { ref } : {}) } };
  }
  return bad("That isn't a place g1t can read a marketplace from. Give owner/repo on GitHub, a repository here, or a link to its marketplace.json.");
}

// ── marketplace.json ─────────────────────────────────────────────────────

/** One plugin as a marketplace lists it. Any plugin.json field may appear here too. */
export type MarketplacePluginEntry = {
  name: string;
  source: PluginSource;
  description: string;
  version: string | null;
  author: { name: string; email?: string; url?: string } | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  keywords: string[];
  category: string | null;
  tags: string[];
  /** Entry-level component paths (added to the manifest's when `strict`). `skills` may be `.`. */
  skills: string[];
  commands: string[];
  agents: string[];
  /** Entry-level MCP servers, only for plugins without a plugin.json. */
  mcpServers: Record<string, unknown> | null;
  /** Default true: the entry's components are added to the manifest's. */
  strict: boolean;
  displayName: string | null;
  /** Whatever else the entry carried, kept as it was. */
  extra: Record<string, unknown>;
};

export type MarketplaceManifest = {
  name: string;
  owner: { name: string; email?: string; url?: string };
  description: string | null;
  version: string | null;
  /** Bare plugin names resolve under this folder. */
  pluginRoot: string | null;
  plugins: MarketplacePluginEntry[];
  /** Entries that couldn't be read, by index, with why. */
  problems: string[];
};

const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()) : typeof value === "string" && value.trim() ? [value.trim()] : []);

function person(value: unknown): { name: string; email?: string; url?: string } | null {
  if (typeof value === "string") return value.trim() ? { name: value.trim() } : null;
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const name = str(p.name);
  if (!name) return null;
  return { name, ...(str(p.email) ? { email: str(p.email) } : {}), ...(str(p.url) ? { url: str(p.url) } : {}) };
}

/** Component paths as a manifest or entry gives them: strings or a list, `./` kept off, `.` meaning the root. */
function paths(value: unknown): string[] {
  return strList(value).map((p) => (p === "." ? "." : p.replace(/^\.\//, "").replace(/\/+$/, ""))).filter((p) => p && !p.startsWith("/") && !p.split("/").includes(".."));
}

const ENTRY_KEYS = ["name", "source", "description", "version", "author", "homepage", "repository", "license", "keywords", "category", "tags", "skills", "commands", "agents", "mcpServers", "strict", "displayName"];

/** A plugin entry read, or why it can't be. */
export function parseMarketplaceEntry(raw: unknown): Checked<MarketplacePluginEntry> {
  if (!raw || typeof raw !== "object") return bad("A plugin entry is an object.");
  const e = raw as Record<string, unknown>;
  const nameProblem = pluginNameProblem(e.name);
  if (nameProblem) return bad(nameProblem);
  if (e.source === undefined) {
    return bad(`${String(e.name)} has no source.`);
  }
  const source = parsePluginSource(e.source);
  if (!source.ok) return bad(`${String(e.name)}: ${source.message}`);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) if (!ENTRY_KEYS.includes(key)) extra[key] = value;
  return {
    ok: true,
    value: {
      name: e.name as string,
      source: source.value,
      description: (str(e.description) ?? "").slice(0, 2000),
      version: str(e.version) ?? null,
      author: person(e.author),
      homepage: str(e.homepage) ?? null,
      repository: str(e.repository) ?? null,
      license: str(e.license) ?? null,
      keywords: strList(e.keywords).slice(0, 30),
      category: str(e.category)?.toLowerCase() ?? null,
      tags: strList(e.tags).slice(0, 30),
      skills: paths(e.skills),
      commands: paths(e.commands),
      agents: paths(e.agents),
      mcpServers: e.mcpServers && typeof e.mcpServers === "object" && !Array.isArray(e.mcpServers) ? (e.mcpServers as Record<string, unknown>) : null,
      strict: e.strict !== false,
      displayName: str(e.displayName) ?? null,
      extra,
    },
  };
}

/** `marketplace.json` read, its unreadable entries noted rather than refused, as Claude Code loads it. */
export function parseMarketplaceManifest(raw: unknown): Checked<MarketplaceManifest> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("marketplace.json is an object with a name, an owner and plugins.");
  const m = raw as Record<string, unknown>;
  const nameProblem = marketplaceNameProblem(m.name);
  if (nameProblem) return bad(nameProblem);
  const owner = person(m.owner);
  if (!owner) return bad("A marketplace names its owner.");
  if (!Array.isArray(m.plugins)) return bad("A marketplace lists its plugins.");
  const metadata = m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {};
  const plugins: MarketplacePluginEntry[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  m.plugins.forEach((entry, i) => {
    const read = parseMarketplaceEntry(entry);
    if (!read.ok) return problems.push(`Plugin ${i + 1}: ${read.message}`);
    if (names.has(read.value.name)) return problems.push(`Plugin ${i + 1}: ${read.value.name} is listed twice.`);
    names.add(read.value.name);
    plugins.push(read.value);
  });
  const pluginRoot = str(metadata.pluginRoot);
  return {
    ok: true,
    value: {
      name: m.name as string,
      owner,
      description: str(m.description) ?? str(metadata.description) ?? null,
      version: str(m.version) ?? str(metadata.version) ?? null,
      pluginRoot: pluginRoot ? pluginRoot.replace(/^\.\//, "").replace(/\/+$/, "") : null,
      plugins,
      problems,
    },
  };
}

// ── plugin.json ──────────────────────────────────────────────────────────

export type PluginManifest = {
  name: string;
  displayName: string | null;
  version: string | null;
  description: string;
  author: { name: string; email?: string; url?: string } | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  keywords: string[];
  /** Component paths besides the standard folders, as given (`./` kept off; `.` the root). */
  skills: string[];
  commands: string[];
  agents: string[];
  hooks: string[];
  /** MCP servers given in the manifest itself (the same shape as .mcp.json's `mcpServers`), or a path to a file. */
  mcpServers: Record<string, unknown> | string | null;
  lspServers: boolean;
  extra: Record<string, unknown>;
};

const MANIFEST_KEYS = ["$schema", "name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "commands", "agents", "hooks", "mcpServers", "lspServers"];

/** `.claude-plugin/plugin.json` read; only the name is required. */
export function parsePluginManifest(raw: unknown): Checked<PluginManifest> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("plugin.json is an object naming the plugin.");
  const p = raw as Record<string, unknown>;
  const nameProblem = pluginNameProblem(p.name);
  if (nameProblem) return bad(nameProblem);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) if (!MANIFEST_KEYS.includes(key)) extra[key] = value;
  const hooks = typeof p.hooks === "string" ? paths(p.hooks) : p.hooks && typeof p.hooks === "object" ? ["(inline)"] : [];
  return {
    ok: true,
    value: {
      name: p.name as string,
      displayName: str(p.displayName) ?? null,
      version: str(p.version) ?? null,
      description: (str(p.description) ?? "").slice(0, 2000),
      author: person(p.author),
      homepage: str(p.homepage) ?? null,
      repository: str(p.repository) ?? null,
      license: str(p.license) ?? null,
      keywords: strList(p.keywords).slice(0, 30),
      skills: paths(p.skills),
      commands: paths(p.commands),
      agents: paths(p.agents),
      hooks,
      mcpServers: typeof p.mcpServers === "string" ? p.mcpServers.replace(/^\.\//, "") : p.mcpServers && typeof p.mcpServers === "object" ? (p.mcpServers as Record<string, unknown>) : null,
      lspServers: !!p.lspServers,
      extra,
    },
  };
}

// ── .mcp.json ────────────────────────────────────────────────────────────

export type McpTransport = "http" | "sse" | "stdio" | "ws" | "sdk";

/** One server as `.mcp.json` names it, read. Remote servers are what g1t's own agents can use; stdio ones run only where Claude Code runs. */
export type McpServerConfig = {
  name: string;
  type: McpTransport;
  url: string | null;
  headers: Record<string, string>;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  /** The `oauth` block, when the file carries one. */
  oauth: Record<string, unknown> | null;
  /** `${VAR}` references the config makes, by variable name, for the setup screen. */
  variables: string[];
};

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

function variablesIn(...values: unknown[]): string[] {
  const out = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") for (const m of value.matchAll(VARIABLE)) out.add(m[1]!);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(walk);
  };
  values.forEach(walk);
  return [...out].sort();
}

const strMap = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
};

/** The servers of an `.mcp.json` (or a manifest's `mcpServers`), those that can't be read noted. */
export function parseMcpServers(raw: unknown): { servers: McpServerConfig[]; problems: string[] } {
  const servers: McpServerConfig[] = [];
  const problems: string[] = [];
  const map = raw && typeof raw === "object" && !Array.isArray(raw) ? ((raw as Record<string, unknown>).mcpServers ?? raw) : null;
  if (!map || typeof map !== "object" || Array.isArray(map)) return { servers, problems: ["mcpServers is an object of servers by name."] };
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      problems.push(`${name}: a server's name is letters, digits, dots, underscores and hyphens.`);
      continue;
    }
    if (!value || typeof value !== "object") {
      problems.push(`${name}: a server is an object.`);
      continue;
    }
    const s = value as Record<string, unknown>;
    const url = str(s.url);
    const command = str(s.command);
    let type: McpTransport;
    const given = typeof s.type === "string" ? s.type : null;
    if (given === "http" || given === "streamable-http") type = "http";
    else if (given === "sse" || given === "ws" || given === "sdk" || given === "stdio") type = given;
    else if (given === null && command) type = "stdio";
    else if (given === null && url) {
      // Claude Code treats a url without a type as stdio and skips it; g1t says so instead.
      problems.push(`${name}: a remote server says its type (http or sse).`);
      continue;
    } else {
      problems.push(`${name}: g1t doesn't know the transport "${String(given)}".`);
      continue;
    }
    if ((type === "http" || type === "sse" || type === "ws") && !url) {
      problems.push(`${name}: a ${type} server has a url.`);
      continue;
    }
    if (type === "stdio" && !command) {
      problems.push(`${name}: a stdio server has a command.`);
      continue;
    }
    servers.push({
      name,
      type,
      url: url ?? null,
      headers: strMap(s.headers),
      command: command ?? null,
      args: strList(s.args),
      env: strMap(s.env),
      oauth: s.oauth && typeof s.oauth === "object" ? (s.oauth as Record<string, unknown>) : null,
      variables: variablesIn(s.url, s.headers, s.command, s.args, s.env),
    });
  }
  return { servers, problems };
}

// ── Subagents ────────────────────────────────────────────────────────────

/** `agents/<name>.md` read: the front-matter Claude Code reads, and the system prompt. */
export type SubagentFile = {
  name: string;
  description: string;
  /** The tools it may use, as named in the file (Claude Code's names, or MCP tool names); empty means every tool. */
  tools: string[];
  disallowedTools: string[];
  model: string | null;
  /** Skills to preload, by name. */
  skills: string[];
  mcpServers: string[];
  color: string | null;
  /** The system prompt: the body after the front-matter. */
  prompt: string;
  extra: Record<string, unknown>;
};

const AGENT_KEYS = ["name", "description", "tools", "disallowedTools", "model", "skills", "mcpServers", "color"];

/** A subagent's name: at most 256 characters, no colon, not starting with a hyphen. */
export function subagentNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return "A subagent has a name.";
  if (name.length > 256) return "A subagent's name is at most 256 characters.";
  if (name.includes(":") || name.startsWith("-")) return "A subagent's name has no colon and doesn't start with a hyphen.";
  return null;
}

/** A tools list as Claude Code writes it: a comma-separated string or a list. */
function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return strList(value);
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * The file read from its parsed front-matter and body (./skill-format.ts's
 * `splitFrontMatter` and `parseFrontMatter` give them), or why Claude Code
 * would skip it.
 */
export function subagentOf(front: Record<string, unknown>, body: string): Checked<SubagentFile> {
  const nameProblem = subagentNameProblem(front.name);
  if (nameProblem) return bad(nameProblem);
  const description = str(front.description);
  if (!description) return bad(`${String(front.name)} says nothing about when to use it (description).`);
  const prompt = body.trim();
  if (!prompt) return bad(`${String(front.name)} has no instructions after the front-matter.`);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(front)) if (!AGENT_KEYS.includes(key)) extra[key] = value;
  return {
    ok: true,
    value: {
      name: (front.name as string).trim(),
      description: description.slice(0, 2000),
      tools: toolList(front.tools),
      disallowedTools: toolList(front.disallowedTools),
      model: str(front.model) ?? null,
      skills: strList(front.skills),
      mcpServers: strList(front.mcpServers),
      color: str(front.color) ?? null,
      prompt,
      extra,
    },
  };
}

// ── A plugin's layout ────────────────────────────────────────────────────

/** What a plugin's folder holds, found from its file list and manifests. Paths are inside the plugin. */
export type PluginLayout = {
  /** Folders holding a `SKILL.md`, by path (`skills/pdf`), with the skill's folder name. */
  skills: { path: string; name: string }[];
  /** `commands/*.md` files: the older form of a skill, one file each. */
  commands: { path: string; name: string }[];
  /** `agents/**.md` files. */
  agents: { path: string; name: string }[];
  /** `hooks/hooks.json` (or the manifest's), when present. */
  hooks: string[];
  /** `.mcp.json` when present (the manifest may hold servers inline too). */
  mcp: string | null;
  lsp: boolean;
  /** `bin/`: executables on the PATH where Claude Code runs; never on g1t's own agents. */
  bin: boolean;
  outputStyles: boolean;
  readme: string | null;
};

const mdName = (path: string): string => path.replace(/^.*\//, "").replace(/\.md$/i, "");

/**
 * The plugin's components from its files: the standard folders
 * (`skills/`, `commands/`, `agents/`) plus whatever the manifest names,
 * plus the marketplace entry's paths. An entry that is not strict names
 * its components outright instead of the standard folders, as the public
 * skills marketplace does (one repository, one plugin per group of
 * skills). `files` are paths inside the plugin.
 */
export function pluginLayout(files: string[], manifest: PluginManifest | null, entry: MarketplacePluginEntry | null): PluginLayout {
  const set = new Set(files.map((f) => f.replace(/^\.\//, "")));
  const has = (path: string) => set.has(path);
  const under = (dir: string) => [...set].filter((f) => f.startsWith(`${dir}/`));
  const skillDirs = new Set<string>();
  const addSkillDir = (dir: string) => {
    const clean = dir === "." ? "" : dir.replace(/\/+$/, "");
    if (has(clean ? `${clean}/SKILL.md` : "SKILL.md")) skillDirs.add(clean || ".");
    else for (const f of under(clean || ".")) if (/(^|\/)SKILL\.md$/.test(f) && f.slice(clean.length + (clean ? 1 : 0)).split("/").length === 2) skillDirs.add(f.replace(/\/SKILL\.md$/, ""));
  };
  const standard = !(entry && !entry.strict);
  if (standard) addSkillDir("skills");
  for (const dir of [...(manifest?.skills ?? []), ...(entry?.skills ?? [])]) addSkillDir(dir);
  const commandFiles = new Set<string>();
  const addCommands = (path: string) => {
    if (/\.md$/i.test(path) && has(path)) commandFiles.add(path);
    else for (const f of under(path)) if (/\.md$/i.test(f)) commandFiles.add(f);
  };
  if (standard) addCommands("commands");
  for (const p of [...(manifest?.commands ?? []), ...(entry?.commands ?? [])]) addCommands(p);
  const agentFiles = new Set<string>();
  const addAgents = (path: string) => {
    if (/\.md$/i.test(path) && has(path)) agentFiles.add(path);
    else for (const f of under(path)) if (/\.md$/i.test(f)) agentFiles.add(f);
  };
  if (standard) addAgents("agents");
  for (const p of [...(manifest?.agents ?? []), ...(entry?.agents ?? [])]) addAgents(p);
  const hooks = [...(has("hooks/hooks.json") ? ["hooks/hooks.json"] : []), ...(manifest?.hooks ?? []).filter((h) => h === "(inline)" || has(h))];
  return {
    skills: [...skillDirs].sort().map((path) => ({ path, name: path === "." ? (manifest?.name ?? entry?.name ?? "skill") : path.replace(/^.*\//, "") })),
    commands: [...commandFiles].sort().map((path) => ({ path, name: mdName(path) })),
    agents: [...agentFiles].sort().map((path) => ({ path, name: mdName(path) })),
    hooks,
    mcp: has(".mcp.json") ? ".mcp.json" : typeof manifest?.mcpServers === "string" && has(manifest.mcpServers) ? manifest.mcpServers : null,
    lsp: has(".lsp.json") || !!manifest?.lspServers,
    bin: under("bin").length > 0,
    outputStyles: under("output-styles").length > 0,
    readme: ["README.md", "readme.md", "Readme.md"].find(has) ?? null,
  };
}

// ── Where to fetch from ──────────────────────────────────────────────────

/**
 * Where g1t reads a plugin's files from, worked out from its entry and the
 * marketplace it is in: GitHub (public, by tarball at a commit or ref), a
 * repository on this g1t, or a zip archive. Everything else is listed but
 * not installable here, and says why.
 */
export type FetchPlan =
  | { kind: "github"; repo: string; ref: string | null; sha: string | null; path: string }
  | { kind: "g1t"; repo: string; ref: string | null; path: string }
  | { kind: "archive"; url: string; sha256: string | null }
  | { kind: "unsupported"; why: string };

/** The GitHub repository a git URL names, when it is one on github.com. */
function githubOfUrl(url: string): { repo: string } | null {
  const found = githubRepoOf(url);
  return found && /github\.com/i.test(url) ? { repo: found.repo } : null;
}

/** A g1t repository a URL names, when the URL is on this g1t (`host`). */
function g1tOfUrl(url: string, host: string | null): { repo: string } | null {
  if (!host) return null;
  const m = new RegExp(`^https?://(?:www\\.)?${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+?)(?:\\.git)?/?$`, "i").exec(url);
  return m ? { repo: m[1]! } : null;
}

const join = (...parts: (string | null | undefined)[]): string => parts.filter((p) => p && p !== ".").join("/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");

export function fetchPlan(source: PluginSource, marketplace: MarketplaceSource, options: { pluginRoot?: string | null; host?: string | null } = {}): FetchPlan {
  const host = options.host ?? null;
  switch (source.source) {
    case "path": {
      const path = join(options.pluginRoot && !source.path.startsWith("./") ? options.pluginRoot : null, source.path.replace(/^\.\//, ""));
      if (marketplace.source === "github") return { kind: "github", repo: marketplace.repo, ref: marketplace.ref ?? null, sha: null, path };
      if (marketplace.source === "g1t") return { kind: "g1t", repo: marketplace.repo, ref: marketplace.ref ?? null, path };
      if (marketplace.source === "git") {
        const gh = githubOfUrl(marketplace.url);
        if (gh) return { kind: "github", repo: gh.repo, ref: marketplace.ref ?? null, sha: null, path };
        const own = g1tOfUrl(marketplace.url, host);
        if (own) return { kind: "g1t", repo: own.repo, ref: marketplace.ref ?? null, path };
        return { kind: "unsupported", why: "Its marketplace is on a git host g1t doesn't read yet. g1t reads GitHub and repositories here." };
      }
      return { kind: "unsupported", why: "Its marketplace was added by a link to its marketplace.json, so a plugin kept beside that file can't be reached. Add the marketplace by its repository instead." };
    }
    case "github":
      return { kind: "github", repo: source.repo, ref: source.ref ?? null, sha: source.sha ?? null, path: "" };
    case "url":
    case "git-subdir": {
      const path = source.source === "git-subdir" ? source.path : "";
      const gh = githubOfUrl(source.url) ?? (githubRepoProblem(source.url) ? null : { repo: source.url });
      if (gh) return { kind: "github", repo: gh.repo, ref: source.ref ?? null, sha: source.sha ?? null, path };
      const own = g1tOfUrl(source.url, host);
      if (own) return { kind: "g1t", repo: own.repo, ref: source.sha ?? source.ref ?? null, path };
      return { kind: "unsupported", why: "It is on a git host g1t doesn't read yet. g1t reads GitHub and repositories here." };
    }
    case "archive":
      return { kind: "archive", url: source.url, sha256: source.sha256 ?? null };
    case "npm":
      return { kind: "unsupported", why: "It is published on npm, which g1t doesn't install from yet. It still works in Claude Code." };
    case "command":
      return { kind: "unsupported", why: "It is produced by a command on the machine that installs it, which g1t can't run. It still works in Claude Code." };
  }
}

/** The marketplaces every workspace starts with, in Claude Code's own names. */
export const BUILTIN_MARKETPLACES: { name: string; source: MarketplaceSource; about: string }[] = [
  { name: "claude-plugins-official", source: { source: "github", repo: "anthropics/claude-plugins-official" }, about: "Anthropic's reviewed plugins: tools, connectors and skills from Anthropic and the companies behind them." },
  { name: "anthropic-agent-skills", source: { source: "github", repo: "anthropics/skills" }, about: "Anthropic's skills: documents, spreadsheets, presentations, PDFs, design, testing and more." },
];
