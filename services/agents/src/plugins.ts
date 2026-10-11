/**
 * Plugins installed in a workspace (docs.g1t.sh/guides/customize/,
 * "Plugins"): a plugin from a marketplace, read at a commit, whose parts
 * are spread to where g1t's agents use them:
 *
 * - its skills (`skills/<name>/SKILL.md`, and `commands/*.md` as one-file
 *   skills) go into the skill library, named `plugin:skill`, and are then
 *   attached like any skill (every agent, a team, one agent);
 * - its subagents (`agents/*.md`) become templates to hire from;
 * - the remote MCP servers in its `.mcp.json` become connectors
 *   (connectors.ts), connected by an owner, then given to agents;
 * - hooks, LSP servers, output styles and `bin/` are kept for Claude Code
 *   on a runner, which fetches the plugin whole at the same commit.
 *
 * Uninstalling takes its skills out of the library (and their
 * attachments), its connectors with them, and keeps the row with who did
 * it. The rules and the tables are here, tested on SQLite with a fake
 * fetch; who may do what and the audit log are index.ts's.
 */
import type { FailureCode, Result } from "@g1t/contracts";
import {
  type FetchPlan,
  type MarketplacePluginEntry,
  type MarketplaceSource,
  type McpServerConfig,
  type PluginLayout,
  type PluginManifest,
  type SubagentFile,
  fetchPlan,
  parseMcpServers,
  parsePluginManifest,
  pluginLayout,
  pluginRef,
  subagentOf,
} from "../../../packages/contracts/src/claude-plugin.ts";
import { MAX_PLUGIN_INSTALLS, type PluginAgentTemplate, type PluginComponents, type PluginDetail, type PluginInstall, type PluginListing, componentsOf } from "../../../packages/contracts/src/customize.ts";
import { newId } from "../../../packages/contracts/src/ids.ts";
import { PLUGIN_SKILL_LIMITS, type SkillFile, checkSkillFolder, parseFrontMatter, skillFileBytes, splitFrontMatter } from "../../../packages/contracts/src/skill-format.ts";
import { type FetchDeps, fetchPlugin } from "./customize-fetch.ts";
import { type SkillRow, skillByName, writeVersion } from "./skill-library.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: FailureCode, message: string): Result<never> => ({ ok: false, error: { code, message } });

export type PluginRow = {
  id: string;
  workspace_id: string;
  ref: string;
  name: string;
  marketplace: string;
  display_name: string | null;
  description: string;
  version: string | null;
  sha: string | null;
  fetch: string;
  components: string;
  agents: string;
  problems: string;
  enabled: number;
  installed_by: string;
  installed_at: string;
  updated_at: string;
  uninstalled_by: string | null;
  uninstalled_at: string | null;
};

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const EMPTY: PluginComponents = { skills: [], agents: [], commands: [], mcp_servers: [], hooks: false, lsp: false, bin: false, output_styles: false };

export function installOut(row: PluginRow, update: PluginInstall["update"] = null): PluginInstall {
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    marketplace: row.marketplace,
    display_name: row.display_name,
    description: row.description,
    version: row.version,
    sha: row.sha,
    fetch: json<FetchPlan>(row.fetch, { kind: "unsupported", why: "unknown" }),
    components: json<PluginComponents>(row.components, EMPTY),
    problems: json<string[]>(row.problems, []),
    enabled: row.enabled === 1,
    installed_by: row.installed_by,
    installed_at: row.installed_at,
    update,
  };
}

/** The workspace's live installs, oldest first. */
export async function listInstalls(db: D1Database, workspaceId: string): Promise<PluginRow[]> {
  const { results } = await db.prepare("SELECT * FROM plugin_installs WHERE workspace_id = ? AND uninstalled_at IS NULL ORDER BY installed_at").bind(workspaceId).all<PluginRow>();
  return results;
}

export async function installByRef(db: D1Database, workspaceId: string, ref: string): Promise<PluginRow | null> {
  return db.prepare("SELECT * FROM plugin_installs WHERE workspace_id = ? AND ref = ? AND uninstalled_at IS NULL").bind(workspaceId, ref).first<PluginRow>();
}

// ── Reading a plugin ─────────────────────────────────────────────────────

/** A plugin's files, read and understood: its manifest, layout, servers and subagents. */
export type ReadPlugin = {
  files: SkillFile[];
  sha: string | null;
  manifest: PluginManifest | null;
  layout: PluginLayout;
  servers: McpServerConfig[];
  agents: SubagentFile[];
  components: PluginComponents;
  readme: string | null;
  problems: string[];
};

function textOf(files: SkillFile[], path: string): string | null {
  const file = files.find((f) => f.path === path);
  return file && file.encoding !== "base64" ? file.content : null;
}

/** The files under a folder, re-rooted at it. */
function folder(files: SkillFile[], dir: string): SkillFile[] {
  if (dir === ".") return files;
  const prefix = `${dir}/`;
  return files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
}

/** What a skill's front-matter says about when to use it, or null. */
function descriptionOf(skillMd: string | null): string | null {
  if (!skillMd) return null;
  const split = splitFrontMatter(skillMd);
  if (!split.ok) return null;
  try {
    const front = parseFrontMatter(split.yaml);
    return typeof front.description === "string" ? front.description.replace(/\s+/g, " ").trim().slice(0, 1024) : null;
  } catch {
    return null;
  }
}

/** Makes sense of a plugin's files, with the marketplace entry that listed it. */
export function readPlugin(files: SkillFile[], sha: string | null, entry: MarketplacePluginEntry | null, omitted: string[] = []): ReadPlugin {
  const problems = omitted.map((path) => `${path} was left out (too large to read here).`);
  let manifest: PluginManifest | null = null;
  const manifestText = textOf(files, ".claude-plugin/plugin.json");
  if (manifestText) {
    try {
      const parsed = parsePluginManifest(JSON.parse(manifestText));
      if (parsed.ok) manifest = parsed.value;
      else problems.push(`plugin.json: ${parsed.message}`);
    } catch {
      problems.push("plugin.json isn't JSON.");
    }
  }
  const layout = pluginLayout(
    files.map((f) => f.path),
    manifest,
    entry,
  );
  // MCP servers: .mcp.json, the manifest's inline ones, or (without a manifest) the entry's.
  let servers: McpServerConfig[] = [];
  const mcpText = layout.mcp ? textOf(files, layout.mcp) : null;
  if (mcpText) {
    try {
      const read = parseMcpServers(JSON.parse(mcpText));
      servers = read.servers;
      problems.push(...read.problems.map((p) => `.mcp.json: ${p}`));
    } catch {
      problems.push(".mcp.json isn't JSON.");
    }
  }
  const inline = manifest && manifest.mcpServers && typeof manifest.mcpServers === "object" ? manifest.mcpServers : !manifest && entry?.mcpServers ? entry.mcpServers : null;
  if (inline) {
    const read = parseMcpServers(inline);
    for (const server of read.servers) if (!servers.some((s) => s.name === server.name)) servers.push(server);
    problems.push(...read.problems.map((p) => `mcpServers: ${p}`));
  }
  const agents: SubagentFile[] = [];
  for (const file of layout.agents) {
    const text = textOf(files, file.path);
    if (!text) continue;
    const split = splitFrontMatter(text);
    if (!split.ok) {
      problems.push(`${file.path}: a subagent file starts with front-matter between --- lines.`);
      continue;
    }
    try {
      const read = subagentOf(parseFrontMatter(split.yaml), split.body);
      if (read.ok) agents.push(read.value);
      else problems.push(`${file.path}: ${read.message}`);
    } catch (error) {
      problems.push(`${file.path}: its front-matter can't be read (${(error as Error).message}).`);
    }
  }
  const skillDescriptions: Record<string, string | null> = {};
  for (const skill of layout.skills) skillDescriptions[skill.path] = descriptionOf(textOf(files, skill.path === "." ? "SKILL.md" : `${skill.path}/SKILL.md`));
  const agentDescriptions: Record<string, string | null> = {};
  for (const file of layout.agents) agentDescriptions[file.path] = agents.find((a) => a.name === file.name)?.description ?? null;
  return {
    files,
    sha,
    manifest,
    layout,
    servers,
    agents,
    components: componentsOf(layout, servers, skillDescriptions, agentDescriptions),
    readme: layout.readme ? textOf(files, layout.readme) : null,
    problems,
  };
}

/**
 * A skill's folder cut to what one version holds: its biggest binary files
 * go first, then its biggest other files besides SKILL.md, until it fits
 * `PLUGIN_SKILL_LIMITS`. What was left out is named, for the install's
 * problems and the version's note.
 */
export function fitSkillFolder(files: SkillFile[]): { files: SkillFile[]; omitted: string[] } {
  let total = files.reduce((n, f) => n + skillFileBytes(f), 0);
  if (files.length <= PLUGIN_SKILL_LIMITS.files && total <= PLUGIN_SKILL_LIMITS.bytes) return { files, omitted: [] };
  const keep = new Map(files.map((f) => [f.path, f]));
  const order = [...files]
    .filter((f) => f.path.toLowerCase() !== "skill.md")
    .sort((a, b) => Number(b.encoding === "base64") - Number(a.encoding === "base64") || skillFileBytes(b) - skillFileBytes(a));
  const omitted: string[] = [];
  for (const file of order) {
    if (keep.size <= PLUGIN_SKILL_LIMITS.files && total <= PLUGIN_SKILL_LIMITS.bytes) break;
    keep.delete(file.path);
    total -= skillFileBytes(file);
    omitted.push(file.path);
  }
  return { files: [...keep.values()], omitted: omitted.sort() };
}

/** A command file (`commands/<name>.md`) as a one-file skill: its front-matter's description, or its first line. */
function commandAsSkill(name: string, text: string): SkillFile[] {
  const split = splitFrontMatter(text);
  let body = text;
  let description = "";
  if (split.ok) {
    body = split.body;
    try {
      const front = parseFrontMatter(split.yaml);
      description = typeof front.description === "string" ? front.description : "";
    } catch {
      // Kept as the body alone.
    }
  }
  const first = body.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").trim() ?? "";
  const when = (description || first || `Use when asked to run ${name}.`).replace(/\s+/g, " ").slice(0, 1024);
  return [{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${JSON.stringify(when)}\n---\n\n${body.trim()}\n`, encoding: "utf8" }];
}

// ── Installing ───────────────────────────────────────────────────────────

export type InstallInput = {
  workspaceId: string;
  listing: PluginListing;
  entry: MarketplacePluginEntry;
  marketplace: { name: string; source: MarketplaceSource; pluginRoot: string | null };
  host: string | null;
  by: string;
  deps: FetchDeps;
  now?: Date;
};

/** What installing wrote: the install, and the plugin as read, for connectors to be made from. */
export type Installed = { install: PluginInstall; plugin: ReadPlugin; skills: { name: string; id: string; problem: string | null }[] };

/**
 * Installs a plugin: fetches it, writes its skills into the library under
 * its name, keeps its subagents, and records what it brought. Connectors
 * for its servers are made by the caller (connectors.ts), which holds the
 * sealing key. A conflict when it is installed already.
 */
export async function install(db: D1Database, input: InstallInput): Promise<Result<Installed>> {
  const now = input.now ?? new Date();
  const { listing } = input;
  if (listing.availability.kind === "installed") return fail("conflict", `${listing.name} is installed already.`);
  if (listing.availability.kind === "soon") return fail("invalid", `${listing.name} isn't released yet, so it can't be installed.`);
  if (listing.availability.kind === "unavailable") return fail("invalid", listing.availability.why);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE workspace_id = ? AND uninstalled_at IS NULL").bind(input.workspaceId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PLUGIN_INSTALLS) return fail("limit", `A workspace installs at most ${MAX_PLUGIN_INSTALLS} plugins.`);
  const plan = fetchPlan(input.entry.source, input.marketplace.source, { pluginRoot: input.marketplace.pluginRoot, host: input.host });
  const fetched = await fetchPlugin(plan, input.deps);
  if (!fetched.ok) return fail("invalid", fetched.message);
  const plugin = readPlugin(fetched.files, fetched.sha, input.entry, fetched.omitted);
  const at = now.toISOString();
  const row: PluginRow = {
    id: newId("plg", now.getTime()),
    workspace_id: input.workspaceId,
    ref: listing.ref,
    name: listing.name,
    marketplace: listing.marketplace,
    display_name: plugin.manifest?.displayName ?? listing.display_name,
    description: plugin.manifest?.description || listing.description,
    version: plugin.manifest?.version ?? listing.version,
    sha: plugin.sha,
    fetch: JSON.stringify(plan.kind === "github" && plugin.sha ? { ...plan, sha: plugin.sha } : plan),
    components: JSON.stringify(plugin.components),
    agents: JSON.stringify(plugin.agents),
    problems: "[]",
    enabled: 1,
    installed_by: input.by,
    installed_at: at,
    updated_at: at,
    uninstalled_by: null,
    uninstalled_at: null,
  };
  try {
    await db
      .prepare(
        `INSERT INTO plugin_installs (id, workspace_id, ref, name, marketplace, display_name, description, version, sha, fetch, components, agents, problems, enabled, installed_by, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(row.id, row.workspace_id, row.ref, row.name, row.marketplace, row.display_name, row.description, row.version, row.sha, row.fetch, row.components, row.agents, row.problems, row.installed_by, row.installed_at, row.updated_at)
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return fail("conflict", `${listing.name} is installed already.`);
    throw error;
  }
  // Its skills, into the library under the plugin's name.
  const skills: Installed["skills"] = [];
  const problems = [...plugin.problems];
  const folders: { name: string; path: string; files: SkillFile[] }[] = [
    ...plugin.layout.skills.map((s) => ({ name: s.name, path: s.path, files: folder(plugin.files, s.path) })),
    ...plugin.layout.commands.map((c) => ({ name: c.name, path: c.path, files: commandAsSkill(c.name, textOf(plugin.files, c.path) ?? "") })),
  ];
  const seen = new Set<string>();
  for (const one of folders) {
    const fitted = fitSkillFolder(one.files);
    if (fitted.omitted.length) problems.push(`${one.path}: ${fitted.omitted.length} ${fitted.omitted.length === 1 ? "file" : "files"} left out to fit (${fitted.omitted.slice(0, 5).join(", ")}${fitted.omitted.length > 5 ? "…" : ""}); Claude Code on a runner gets the whole plugin.`);
    const checked = checkSkillFolder(fitted.files, { expectName: one.name, lenient: true, limits: PLUGIN_SKILL_LIMITS });
    if (!checked.ok) {
      problems.push(`${one.path}: ${checked.message}`);
      skills.push({ name: one.name, id: "", problem: checked.message });
      continue;
    }
    if (seen.has(checked.skill.name.toLowerCase())) {
      problems.push(`${one.path}: the plugin has two skills called ${checked.skill.name}.`);
      continue;
    }
    seen.add(checked.skill.name.toLowerCase());
    const existing = await skillByName(db, input.workspaceId, checked.skill.name, listing.ref);
    const written = await writeVersion(db, {
      workspaceId: input.workspaceId,
      existing,
      checked: checked.skill,
      origin: { kind: "plugin", plugin: listing.ref, marketplace: listing.marketplace, path: one.path, sha: plugin.sha },
      note: `From ${listing.ref}${plugin.sha ? ` at ${plugin.sha.slice(0, 8)}` : ""}${fitted.omitted.length ? ` (${fitted.omitted.length} large files left out)` : ""}`,
      by: input.by,
      now,
      status: "published",
      mirrored: false,
      plugin: listing.ref,
      move: () => true,
    });
    if (!written.ok) {
      problems.push(`${one.path}: ${written.error.message}`);
      skills.push({ name: checked.skill.name, id: "", problem: written.error.message });
    } else skills.push({ name: checked.skill.name, id: written.value.id, problem: null });
  }
  if (problems.length) await db.prepare("UPDATE plugin_installs SET problems = ? WHERE id = ?").bind(JSON.stringify(problems.slice(0, 50)), row.id).run();
  return ok({ install: installOut({ ...row, problems: JSON.stringify(problems.slice(0, 50)) }), plugin, skills });
}

/** Switches an install on or off: off, its skills leave agents' prompts and its connectors stop (the kill switch). */
export async function setEnabled(db: D1Database, workspaceId: string, ref: string, enabled: boolean, now = new Date()): Promise<Result<PluginInstall>> {
  const row = await installByRef(db, workspaceId, ref);
  if (!row) return fail("not_found", "That plugin isn't installed.");
  const at = now.toISOString();
  await db.batch([
    db.prepare("UPDATE plugin_installs SET enabled = ?, updated_at = ? WHERE id = ?").bind(enabled ? 1 : 0, at, row.id),
    // Its skills follow: a draft can't be attached, which is how a switched-off plugin's skills stay out of prompts.
    db.prepare("UPDATE skills SET status = ? WHERE workspace_id = ? AND plugin = ? AND archived_at IS NULL").bind(enabled ? "published" : "draft", workspaceId, ref),
  ]);
  return ok(installOut({ ...row, enabled: enabled ? 1 : 0, updated_at: at }));
}

/** Removes an install: its skills are archived with their attachments, and the row kept. Connectors are the caller's. */
export async function uninstall(db: D1Database, workspaceId: string, ref: string, by: string, now = new Date()): Promise<Result<{ skills: string[] }>> {
  const row = await installByRef(db, workspaceId, ref);
  if (!row) return fail("not_found", "That plugin isn't installed.");
  const at = now.toISOString();
  const { results } = await db.prepare("SELECT id, name FROM skills WHERE workspace_id = ? AND plugin = ? AND archived_at IS NULL").bind(workspaceId, ref).all<{ id: string; name: string }>();
  const statements = [
    db.prepare("UPDATE plugin_installs SET uninstalled_by = ?, uninstalled_at = ?, updated_at = ? WHERE id = ?").bind(by, at, at, row.id),
    db.prepare("UPDATE skills SET archived_at = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ? AND plugin = ? AND archived_at IS NULL").bind(at, by, at, workspaceId, ref),
    ...(results.length ? [db.prepare(`DELETE FROM skill_attachments WHERE skill_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(results.map((s) => s.id)))] : []),
  ];
  await db.batch(statements);
  return ok({ skills: results.map((s) => s.name) });
}

/** The subagents installed plugins bring, as templates to hire from. */
export async function pluginAgents(db: D1Database, workspaceId: string): Promise<PluginAgentTemplate[]> {
  const out: PluginAgentTemplate[] = [];
  for (const row of await listInstalls(db, workspaceId)) {
    if (row.enabled !== 1) continue;
    for (const agent of json<SubagentFile[]>(row.agents, [])) {
      out.push({ ref: `${row.name}:${agent.name}`, plugin: row.name, marketplace: row.marketplace, name: agent.name, description: agent.description, prompt: agent.prompt, model: agent.model, skills: agent.skills, tools: agent.tools });
    }
  }
  return out;
}

/** The installs as their page lists them, each with whether its marketplace now lists a newer version. */
export function installsOut(rows: PluginRow[], listings: PluginListing[]): PluginInstall[] {
  return rows.map((row) => {
    const listing = listings.find((l) => l.ref === row.ref);
    const newerVersion = listing?.version && row.version && listing.version !== row.version;
    const newerSha = listing?.fetch.kind === "github" && listing.fetch.sha && row.sha && listing.fetch.sha !== row.sha;
    return installOut(row, listing && (newerVersion || newerSha) ? { version: listing.version, sha: listing.fetch.kind === "github" ? listing.fetch.sha : null } : null);
  });
}

/** A plugin's page: fetched fresh when it isn't installed (so Discover can show what it holds), from the install otherwise. */
export async function detail(db: D1Database, workspaceId: string, listing: PluginListing, entry: MarketplacePluginEntry | null, marketplace: { source: MarketplaceSource; pluginRoot: string | null; owner: string | null }, host: string | null, deps: FetchDeps): Promise<PluginDetail> {
  const row = await installByRef(db, workspaceId, listing.ref);
  const install = row ? installOut(row) : null;
  let read: ReadPlugin | null = null;
  if (listing.availability.kind !== "unavailable" && listing.availability.kind !== "soon") {
    const plan = fetchPlan(entry?.source ?? { source: "path", path: "./" }, marketplace.source, { pluginRoot: marketplace.pluginRoot, host });
    const fetched = await fetchPlugin(row ? json<FetchPlan>(row.fetch, plan) : plan, deps);
    if (fetched.ok) read = readPlugin(fetched.files, fetched.sha, entry, fetched.omitted);
  }
  return {
    listing,
    install,
    components: read?.components ?? install?.components ?? null,
    readme: read?.readme ?? null,
    manifest: read?.manifest ? { name: read.manifest.name, version: read.manifest.version, license: read.manifest.license, repository: read.manifest.repository } : null,
    agents: read?.agents ?? (row ? json<SubagentFile[]>(row.agents, []) : []),
    problems: read?.problems ?? install?.problems ?? [],
    source: { marketplace: listing.marketplace, owner: marketplace.owner },
  };
}

export { pluginRef };
export type { SkillRow };
