/**
 * Marketplaces (docs.g1t.sh/guides/customize/, "Marketplaces"): where a
 * workspace reads plugins from. Every workspace starts with the built-in
 * ones (@g1t/contracts claude-plugin.ts `BUILTIN_MARKETPLACES`), whose
 * manifests are cached once for everyone (workspace_id ''), and owners add
 * more by the forms Claude Code takes. A manifest is read when the
 * marketplace is added, again on demand, and again when it is older than
 * `STALE_MS` and someone opens Discover.
 *
 * Discover is built from the cached manifests: one listing per plugin
 * (`PluginListing`) with where g1t would fetch it from and whether it can
 * (`fetchPlan`), and one per skill a plugin names outright
 * (`SkillListing`), so a skills-only plugin lists its skills without a
 * fetch. The rules and the tables are here, tested on SQLite; who may do
 * what, the audit log and telling people are index.ts's.
 */
import type { FailureCode, Result } from "@g1t/contracts";
import {
  BUILTIN_MARKETPLACES,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type MarketplaceSource,
  fetchPlan,
  isReservedMarketplaceName,
  marketplaceNameProblem,
  parseMarketplaceManifest,
  pluginRef,
} from "../../../packages/contracts/src/claude-plugin.ts";
import { MAX_MARKETPLACES, type Marketplace, type PluginAvailability, type PluginListing, type SkillListing } from "../../../packages/contracts/src/customize.ts";
import { newId } from "../../../packages/contracts/src/ids.ts";
import { type FetchDeps, fetchMarketplace } from "./customize-fetch.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: FailureCode, message: string): Result<never> => ({ ok: false, error: { code, message } });

/** A cached manifest older than this is read again when Discover opens. */
export const STALE_MS = 6 * 60 * 60 * 1000;

export type MarketplaceRow = {
  id: string;
  workspace_id: string;
  name: string;
  source: string;
  manifest: string | null;
  fetched_at: string | null;
  problem: string | null;
  added_by: string;
  added_at: string;
};

/** g1t's own marketplace, in code: what g1t builds and will build, under its own name. */
export const G1T_MARKETPLACE: MarketplaceManifest = {
  name: "g1t",
  owner: { name: "g1t" },
  description: "g1t's own plugins: the pages, cards and roles g1t is building for what a team does besides code.",
  version: null,
  pluginRoot: null,
  plugins: [],
  problems: [],
};

export type ManifestCache = { manifest: MarketplaceManifest; sha: string | null; fetched_at: string };

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The source a row keeps. */
export function sourceOf(row: MarketplaceRow): MarketplaceSource {
  return json<MarketplaceSource>(row.source, { source: "builtin", id: row.name });
}

/** The cached manifest a row keeps, parsed again (the cache holds the raw JSON, so parsing improvements apply). */
export function cachedManifest(row: MarketplaceRow): MarketplaceManifest | null {
  const cache = json<{ json: unknown; sha: string | null } | null>(row.manifest, null);
  if (!cache) return null;
  const parsed = parseMarketplaceManifest(cache.json);
  return parsed.ok ? parsed.value : null;
}

/** The marketplaces a workspace reads: the built-in ones (from the shared cache rows), then its own, by name. */
export async function listRows(db: D1Database, workspaceId: string): Promise<{ row: MarketplaceRow | null; builtin: (typeof BUILTIN_MARKETPLACES)[number] | null; name: string }[]> {
  const { results } = await db.prepare("SELECT * FROM marketplaces WHERE workspace_id IN ('', ?) ORDER BY added_at").bind(workspaceId).all<MarketplaceRow>();
  const shared = new Map(results.filter((r) => r.workspace_id === "").map((r) => [r.name, r]));
  const own = results.filter((r) => r.workspace_id === workspaceId);
  return [...BUILTIN_MARKETPLACES.map((b) => ({ row: shared.get(b.name) ?? null, builtin: b, name: b.name })), ...own.map((r) => ({ row: r, builtin: null, name: r.name }))];
}

/** Reads a marketplace's manifest and caches it on its row (a built-in's row is made if missing). */
export async function refreshRow(
  db: D1Database,
  entry: { row: MarketplaceRow | null; builtin: (typeof BUILTIN_MARKETPLACES)[number] | null; name: string },
  deps: FetchDeps,
  host: string | null,
  now = new Date(),
): Promise<MarketplaceRow> {
  const source = entry.builtin ? entry.builtin.source : sourceOf(entry.row!);
  const read = await fetchMarketplace(source, deps, host);
  const at = now.toISOString();
  let manifest: string | null = entry.row?.manifest ?? null;
  let problem: string | null = null;
  if (read.ok) {
    const parsed = parseMarketplaceManifest(read.json);
    if (parsed.ok) {
      if (!entry.builtin && parsed.value.name !== entry.name) problem = `Its marketplace.json calls itself ${parsed.value.name}, not ${entry.name}.`;
      manifest = JSON.stringify({ json: read.json, sha: read.sha });
    } else problem = parsed.message;
  } else problem = read.message;
  if (!entry.row) {
    const row: MarketplaceRow = { id: newId("mkt", now.getTime()), workspace_id: "", name: entry.name, source: JSON.stringify(source), manifest, fetched_at: at, problem, added_by: "g1t", added_at: at };
    await db
      .prepare("INSERT INTO marketplaces (id, workspace_id, name, source, manifest, fetched_at, problem, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, name) DO UPDATE SET manifest = excluded.manifest, fetched_at = excluded.fetched_at, problem = excluded.problem")
      .bind(row.id, row.workspace_id, row.name, row.source, row.manifest, row.fetched_at, row.problem, row.added_by, row.added_at)
      .run();
    return row;
  }
  await db.prepare("UPDATE marketplaces SET manifest = ?, fetched_at = ?, problem = ? WHERE id = ?").bind(manifest, at, problem, entry.row.id).run();
  return { ...entry.row, manifest, fetched_at: at, problem };
}

/** Every marketplace with a fresh enough manifest, reading the stale ones (and the built-ins' first time). */
export async function loadAll(db: D1Database, workspaceId: string, deps: FetchDeps, host: string | null, now = new Date()): Promise<{ row: MarketplaceRow; builtin: boolean; manifest: MarketplaceManifest | null }[]> {
  const out: { row: MarketplaceRow; builtin: boolean; manifest: MarketplaceManifest | null }[] = [];
  for (const entry of await listRows(db, workspaceId)) {
    let row = entry.row;
    const stale = !row?.fetched_at || now.getTime() - Date.parse(row.fetched_at) > STALE_MS;
    if (stale) {
      try {
        row = await refreshRow(db, entry, deps, host, now);
      } catch (error) {
        console.error("agents: a marketplace wasn't read", entry.name, String(error));
      }
    }
    if (!row) continue;
    out.push({ row, builtin: !!entry.builtin, manifest: cachedManifest(row) });
  }
  return out;
}

/** The marketplaces as their page lists them. */
export function marketplacesOut(loaded: { row: MarketplaceRow; builtin: boolean; manifest: MarketplaceManifest | null }[], owner: boolean): Marketplace[] {
  const out = loaded.map(({ row, builtin, manifest }) => ({
    name: row.name,
    source: sourceOf(row),
    builtin,
    about: builtin ? (BUILTIN_MARKETPLACES.find((b) => b.name === row.name)?.about ?? null) : (manifest?.description ?? null),
    owner: manifest?.owner.name ?? null,
    plugins: manifest?.plugins.length ?? 0,
    fetched_at: row.fetched_at,
    problem: row.problem,
    added_by: builtin ? null : row.added_by,
    added_at: builtin ? null : row.added_at,
    can_remove: owner && !builtin,
  }));
  out.push({
    name: G1T_MARKETPLACE.name,
    source: { source: "builtin", id: "g1t" },
    builtin: true,
    about: G1T_MARKETPLACE.description,
    owner: "g1t",
    plugins: G1T_MARKETPLACE.plugins.length,
    fetched_at: null,
    problem: null,
    added_by: null,
    added_at: null,
    can_remove: false,
  });
  return out;
}

/** Adds a marketplace for the workspace and reads it; the row is kept even when the first read fails, so it can be read again. */
export async function addMarketplace(
  db: D1Database,
  workspaceId: string,
  name: string | null,
  source: MarketplaceSource,
  by: string,
  deps: FetchDeps,
  host: string | null,
  now = new Date(),
): Promise<Result<Marketplace>> {
  const count = await db.prepare("SELECT COUNT(*) AS n FROM marketplaces WHERE workspace_id = ?").bind(workspaceId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MARKETPLACES) return fail("limit", `A workspace reads at most ${MAX_MARKETPLACES} marketplaces of its own.`);
  const read = await fetchMarketplace(source, deps, host);
  if (!read.ok) return fail("invalid", read.message);
  const parsed = parseMarketplaceManifest(read.json);
  if (!parsed.ok) return fail("invalid", `Its marketplace.json can't be read: ${parsed.message}`);
  const wanted = name?.trim() || parsed.value.name;
  const problem = marketplaceNameProblem(wanted);
  if (problem) return fail("invalid", problem);
  if (isReservedMarketplaceName(wanted) || wanted === G1T_MARKETPLACE.name) return fail("invalid", `${wanted} is a name kept for a built-in marketplace. Give it another name here.`);
  const at = now.toISOString();
  const row: MarketplaceRow = { id: newId("mkt", now.getTime()), workspace_id: workspaceId, name: wanted, source: JSON.stringify(source), manifest: JSON.stringify({ json: read.json, sha: read.sha }), fetched_at: at, problem: null, added_by: by, added_at: at };
  try {
    await db
      .prepare("INSERT INTO marketplaces (id, workspace_id, name, source, manifest, fetched_at, problem, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.workspace_id, row.name, row.source, row.manifest, row.fetched_at, row.problem, row.added_by, row.added_at)
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return fail("conflict", `The workspace already reads a marketplace called ${wanted}.`);
    throw error;
  }
  return ok(marketplacesOut([{ row, builtin: false, manifest: parsed.value }], true)[0]!);
}

/** Removes one of the workspace's own marketplaces. Plugins installed from it stay installed. */
export async function removeMarketplace(db: D1Database, workspaceId: string, name: string): Promise<Result<null>> {
  if (BUILTIN_MARKETPLACES.some((b) => b.name === name) || name === G1T_MARKETPLACE.name) return fail("invalid", `${name} is built in, so it can't be removed.`);
  const done = await db.prepare("DELETE FROM marketplaces WHERE workspace_id = ? AND name = ?").bind(workspaceId, name).run();
  return done.meta.changes ? ok(null) : fail("not_found", "The workspace reads no marketplace by that name.");
}

/** One marketplace's row by name, the workspace's own or a built-in's shared cache. */
export async function marketplaceByName(db: D1Database, workspaceId: string, name: string): Promise<{ row: MarketplaceRow | null; builtin: (typeof BUILTIN_MARKETPLACES)[number] | null; name: string } | null> {
  const entries = await listRows(db, workspaceId);
  return entries.find((e) => e.name === name) ?? null;
}

// ── Discover ─────────────────────────────────────────────────────────────

/** The installs Discover marks, by ref. */
export type InstallMarks = Map<string, { enabled: boolean }>;

/** A listing for one plugin entry of one marketplace. */
export function listingOf(entry: MarketplacePluginEntry, marketplace: { name: string; source: MarketplaceSource; pluginRoot: string | null }, installs: InstallMarks, host: string | null): PluginListing {
  const ref = pluginRef(entry.name, marketplace.name);
  const plan = fetchPlan(entry.source, marketplace.source, { pluginRoot: marketplace.pluginRoot, host });
  const installed = installs.get(ref);
  const soon = entry.extra.status === "soon";
  const availability: PluginAvailability = installed ? { kind: "installed", enabled: installed.enabled } : soon ? { kind: "soon" } : plan.kind === "unsupported" ? { kind: "unavailable", why: plan.why } : { kind: "available" };
  return {
    ref,
    name: entry.name,
    marketplace: marketplace.name,
    display_name: entry.displayName,
    description: entry.description,
    version: entry.version,
    author: entry.author?.name ?? null,
    homepage: entry.homepage,
    category: entry.category,
    tags: entry.tags,
    keywords: entry.keywords,
    fetch: plan,
    availability,
    skills: entry.skills.filter((s) => s !== ".").map((s) => s.replace(/^.*\//, "")),
  };
}

/** Every plugin every marketplace lists, g1t's own last, in listing order. */
export function discoverPlugins(loaded: { row: MarketplaceRow; manifest: MarketplaceManifest | null }[], installs: InstallMarks, host: string | null): PluginListing[] {
  const out: PluginListing[] = [];
  for (const { row, manifest } of loaded) {
    if (!manifest) continue;
    const source = sourceOf(row);
    for (const entry of manifest.plugins) out.push(listingOf(entry, { name: row.name, source, pluginRoot: manifest.pluginRoot }, installs, host));
  }
  for (const entry of G1T_MARKETPLACE.plugins) out.push(listingOf(entry, { name: G1T_MARKETPLACE.name, source: { source: "builtin", id: "g1t" }, pluginRoot: null }, installs, host));
  return out;
}

/**
 * Every skill a marketplace names outright in a plugin entry (skills-only
 * plugins list theirs), one listing each, with whether the library has it
 * from that plugin already (`added`: by `plugin:name`).
 */
export function discoverSkills(listings: PluginListing[], added: ReadonlySet<string>): SkillListing[] {
  const out: SkillListing[] = [];
  for (const plugin of listings) {
    for (const name of plugin.skills) {
      out.push({
        ref: `${plugin.name}:${name}`,
        name,
        plugin: plugin.name,
        marketplace: plugin.marketplace,
        description: plugin.description,
        category: plugin.category,
        author: plugin.author,
        added: added.has(`${plugin.ref}/${name}`),
        availability: plugin.availability,
      });
    }
  }
  return out;
}

/** A plugin's listing by `name@marketplace`, from what is loaded. */
export function findListing(listings: PluginListing[], ref: string): PluginListing | null {
  return listings.find((l) => l.ref === ref) ?? null;
}

/** The entry behind a listing, for installing: the marketplace's parsed entry and source. */
export function entryOf(loaded: { row: MarketplaceRow; manifest: MarketplaceManifest | null }[], ref: { name: string; marketplace: string }): { entry: MarketplacePluginEntry; source: MarketplaceSource; pluginRoot: string | null } | null {
  if (ref.marketplace === G1T_MARKETPLACE.name) {
    const entry = G1T_MARKETPLACE.plugins.find((p) => p.name === ref.name);
    return entry ? { entry, source: { source: "builtin", id: "g1t" }, pluginRoot: null } : null;
  }
  const found = loaded.find((l) => l.row.name === ref.marketplace);
  const entry = found?.manifest?.plugins.find((p) => p.name === ref.name);
  return found && entry ? { entry, source: sourceOf(found.row), pluginRoot: found.manifest!.pluginRoot } : null;
}
