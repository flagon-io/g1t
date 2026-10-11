/**
 * Customize's RPC methods (@g1t/contracts workspace-agents.ts, the
 * `marketplaces`, `plugins` and `connectors` calls): marketplaces a
 * workspace reads, what Discover lists, plugins installed and what they
 * brought, and connectors with their sign-ins and grants. The rules are
 * in marketplaces.ts, plugins.ts and connectors.ts; this file reads what
 * they need from identity and repos, checks who may do what (members see,
 * owners change), and writes the audit log.
 */
import { type RepoPath, type Result, type User, fail, identityClient, ok, reposClient } from "@g1t/contracts";

import { type McpServer } from "../../../packages/contracts/src/abilities.ts";
import { type McpServerConfig, parseMarketplaceAddress, parsePluginRef } from "../../../packages/contracts/src/claude-plugin.ts";
import type { AgentConnector, ConnectorInput, CustomizeBundle, Marketplace, PluginAgentTemplate, PluginDetail, PluginInstall, PluginListing, SkillListing, WorkspaceConnector } from "../../../packages/contracts/src/customize.ts";
import type { SkillScope } from "../../../packages/contracts/src/skill-library.ts";
import type { SkillFile } from "../../../packages/contracts/src/skill-format.ts";
import * as connectors from "./connectors.ts";
import type { FetchDeps } from "./customize-fetch.ts";
import { definitionOf } from "./store.ts";
import * as marketplaces from "./marketplaces.ts";
import * as plugins from "./plugins.ts";
import { answerListing } from "./installs.ts";
import type { SessionEnv } from "./sessions.ts";
import { listingRef } from "../../../packages/contracts/src/marketplace.ts";
import type { ViewContext } from "./views.ts";

type CustomizeEnv = SessionEnv & { CONNECTORS_KEY?: string; GITHUB_TOKEN?: string; SITE_URL?: string };

const env = (ctx: ViewContext): CustomizeEnv => ctx.env as CustomizeEnv;

/** This g1t's host, for reading its own repositories by address. */
function hostOf(ctx: ViewContext): string | null {
  try {
    return new URL(env(ctx).SITE_URL ?? "https://g1t.sh").hostname;
  } catch {
    return null;
  }
}

/** Where plugins and marketplaces are read from: GitHub with the token if set, and repositories here the viewer can read. */
function fetchDeps(ctx: ViewContext): FetchDeps {
  const repos = reposClient(env(ctx).REPOS);
  return {
    githubToken: env(ctx).GITHUB_TOKEN ?? null,
    repos: {
      repo: async (full) => {
        const [namespace, name] = full.split("/") as [string, string];
        const found = await repos.get({ namespace, name } as RepoPath, ctx.viewer).catch(() => null);
        return found?.ok ? { id: found.value.id, default_branch: found.value.defaultBranch } : null;
      },
      listFiles: (repoId, ref) => repos.listFiles(repoId, ref, 10_000),
      blobs: async (repoId, hashes) => (await repos.rawBlobs(repoId, hashes, 2 * 1024 * 1024)).map((blob) => ({ hash: blob.hash, data: blob.data })),
    },
  };
}

async function connectorDeps(ctx: ViewContext): Promise<connectors.Deps> {
  return { key: await connectors.sealingKey(env(ctx).CONNECTORS_KEY), site: (env(ctx).SITE_URL ?? "https://g1t.sh").replace(/\/+$/, "") };
}

const owners = (ctx: ViewContext, what: string): Result<null> => (ctx.owner ? ok(null) : fail("forbidden", `Only the workspace's owners ${what}.`));

type Labels = { agents: Map<string, { handle: string; display_name: string }>; teams: Map<string, string> };

async function labels(ctx: ViewContext): Promise<Labels> {
  const [agents, teams] = await Promise.all([
    ctx.db.prepare("SELECT id, handle, display_name FROM agents WHERE workspace_id = ? AND archived_at IS NULL").bind(ctx.workspaceId).all<{ id: string; handle: string; display_name: string }>(),
    identityClient(env(ctx).IDENTITY)
      .listTeams(ctx.viewer, ctx.slug)
      .catch(() => null),
  ]);
  return { agents: new Map(agents.results.map((a) => [a.id, a])), teams: new Map(teams?.ok ? teams.value.map((t) => [t.slug, t.name]) : []) };
}

// ── Marketplaces and Discover ────────────────────────────────────────────

async function loaded(ctx: ViewContext) {
  return marketplaces.loadAll(ctx.db, ctx.workspaceId, fetchDeps(ctx), hostOf(ctx));
}

async function marks(ctx: ViewContext): Promise<marketplaces.InstallMarks> {
  return new Map((await plugins.listInstalls(ctx.db, ctx.workspaceId)).map((row) => [row.ref, { enabled: row.enabled === 1 }]));
}

async function listMarketplaces(ctx: ViewContext): Promise<Result<Marketplace[]>> {
  return ok(marketplaces.marketplacesOut(await loaded(ctx), ctx.owner));
}

async function addMarketplace(ctx: ViewContext, address: unknown, name: unknown): Promise<Result<Marketplace>> {
  const may = owners(ctx, "add marketplaces");
  if (!may.ok) return may;
  const deps = fetchDeps(ctx);
  const parsed = parseMarketplaceAddress(String(address ?? ""), { host: hostOf(ctx) ?? undefined, here: () => false });
  if (!parsed.ok) return fail("invalid", parsed.message);
  // `workspace/name` that is a repository here is read here; otherwise GitHub.
  let source = parsed.value;
  if (source.source === "github" && !String(address).includes("://") && (await deps.repos!.repo(source.repo))) source = { source: "g1t", repo: source.repo, ...(source.ref ? { ref: source.ref } : {}) };
  const added = await marketplaces.addMarketplace(ctx.db, ctx.workspaceId, typeof name === "string" ? name : null, source, ctx.viewer.username, deps, hostOf(ctx));
  if (added.ok) ctx.audit?.("add_marketplace", `customize/marketplaces/${added.value.name}`, `Added the marketplace ${added.value.name} (${added.value.plugins} plugins)`);
  return added;
}

async function removeMarketplace(ctx: ViewContext, name: unknown): Promise<Result<null>> {
  const may = owners(ctx, "remove marketplaces");
  if (!may.ok) return may;
  const removed = await marketplaces.removeMarketplace(ctx.db, ctx.workspaceId, String(name ?? ""));
  if (removed.ok) ctx.audit?.("remove_marketplace", `customize/marketplaces/${String(name)}`, `Removed the marketplace ${String(name)}`);
  return removed;
}

async function refreshMarketplace(ctx: ViewContext, name: unknown): Promise<Result<Marketplace>> {
  const may = owners(ctx, "read marketplaces again");
  if (!may.ok) return may;
  const entry = await marketplaces.marketplaceByName(ctx.db, ctx.workspaceId, String(name ?? ""));
  if (!entry) return fail("not_found", "The workspace reads no marketplace by that name.");
  const row = await marketplaces.refreshRow(ctx.db, entry, fetchDeps(ctx), hostOf(ctx));
  return ok(marketplaces.marketplacesOut([{ row, builtin: !!entry.builtin, manifest: marketplaces.cachedManifest(row) }], ctx.owner)[0]!);
}

export type Discover = { plugins: PluginListing[]; skills: SkillListing[]; marketplaces: Marketplace[] };

async function discover(ctx: ViewContext): Promise<Result<Discover>> {
  const all = await loaded(ctx);
  const listings = marketplaces.discoverPlugins(all, await marks(ctx), hostOf(ctx));
  const { results } = await ctx.db.prepare("SELECT plugin, name FROM skills WHERE workspace_id = ? AND plugin IS NOT NULL AND archived_at IS NULL").bind(ctx.workspaceId).all<{ plugin: string; name: string }>();
  const added = new Set(results.map((r) => `${r.plugin}/${r.name}`));
  return ok({ plugins: listings, skills: marketplaces.discoverSkills(listings, added), marketplaces: marketplaces.marketplacesOut(all, ctx.owner) });
}

// ── Plugins ──────────────────────────────────────────────────────────────

async function listingFor(ctx: ViewContext, ref: unknown) {
  const parsed = parsePluginRef(ref);
  if (!parsed) return fail("invalid", "Name a plugin as name@marketplace.");
  const all = await loaded(ctx);
  const listings = marketplaces.discoverPlugins(all, await marks(ctx), hostOf(ctx));
  const listing = marketplaces.findListing(listings, ref as string);
  const entry = marketplaces.entryOf(all, parsed);
  if (!listing || !entry) return fail("not_found", `No marketplace the workspace reads lists ${String(ref)}.`);
  const manifest = all.find((l) => l.row.name === parsed.marketplace)?.manifest ?? null;
  return ok({ listing, entry, owner: manifest?.owner.name ?? (parsed.marketplace === "g1t" ? "g1t" : null), listings });
}

async function pluginDetail(ctx: ViewContext, ref: unknown): Promise<Result<PluginDetail>> {
  const found = await listingFor(ctx, ref);
  if (!found.ok) return found;
  const { listing, entry, owner } = found.value;
  return ok(await plugins.detail(ctx.db, ctx.workspaceId, listing, entry.entry, { source: entry.source, pluginRoot: entry.pluginRoot, owner }, hostOf(ctx), fetchDeps(ctx)));
}

async function pluginInstalls(ctx: ViewContext): Promise<Result<PluginInstall[]>> {
  const rows = await plugins.listInstalls(ctx.db, ctx.workspaceId);
  const listings = rows.length ? marketplaces.discoverPlugins(await loaded(ctx), await marks(ctx), hostOf(ctx)) : [];
  return ok(plugins.installsOut(rows, listings));
}

async function installPlugin(ctx: ViewContext, ref: unknown): Promise<Result<PluginInstall>> {
  const may = owners(ctx, "install plugins");
  if (!may.ok) return may;
  const found = await listingFor(ctx, ref);
  if (!found.ok) return found;
  const { listing, entry } = found.value;
  const done = await plugins.install(ctx.db, { workspaceId: ctx.workspaceId, listing, entry: entry.entry, marketplace: { name: listing.marketplace, source: entry.source, pluginRoot: entry.pluginRoot }, host: hostOf(ctx), by: ctx.viewer.username, deps: fetchDeps(ctx) });
  if (!done.ok) return done;
  await pluginConnectors(ctx, listing, done.value.plugin.servers, done.value.install.id);
  ctx.audit?.("install_plugin", `customize/plugins/${listing.ref}`, `Installed the plugin ${listing.ref}${done.value.install.version ? ` ${done.value.install.version}` : ""} (${done.value.skills.filter((s) => !s.problem).length} skills, ${done.value.plugin.agents.length} agents)`);
  await answerListing(ctx, listingRef("plugin", listing.ref));
  const fresh = await plugins.installByRef(ctx.db, ctx.workspaceId, listing.ref);
  return ok(fresh ? plugins.installOut(fresh) : done.value.install);
}

/** A plugin's remote servers become connectors, for an owner to sign in or give a key; one the workspace has from this plugin already is left as it is. */
async function pluginConnectors(ctx: ViewContext, listing: PluginListing, servers: McpServerConfig[], installId: string): Promise<void> {
  const deps = await connectorDeps(ctx);
  const have = new Set((await connectors.listConnectors(ctx.db, ctx.workspaceId)).map((row) => JSON.stringify(JSON.parse(row.from_json))));
  for (const server of servers) {
    if ((server.type !== "http" && server.type !== "sse") || !server.url) continue;
    const from = { kind: "plugin" as const, ref: listing.ref, server: server.name };
    if (have.has(JSON.stringify(from))) continue;
    const auth = server.variables.length ? "header" : "oauth";
    const headerName = Object.keys(server.headers)[0] ?? "Authorization";
    const added = await connectors.addConnector(ctx.db, deps, ctx.workspaceId, { from, auth, header: auth === "header" ? { name: headerName, value: "" } : null }, ctx.viewer.username, { title: `${listing.display_name ?? listing.name}: ${server.name}`, url: server.url });
    if (!added.ok) await ctx.db.prepare("UPDATE plugin_installs SET problems = json_insert(problems, '$[#]', ?) WHERE id = ?").bind(`${server.name}: ${added.error.message}`, installId).run();
  }
}

async function updatePlugin(ctx: ViewContext, ref: unknown): Promise<Result<PluginInstall>> {
  const may = owners(ctx, "update plugins");
  if (!may.ok) return may;
  const found = await listingFor(ctx, ref);
  if (!found.ok) return found;
  const { listing, entry } = found.value;
  const done = await plugins.update(ctx.db, { workspaceId: ctx.workspaceId, listing, entry: entry.entry, marketplace: { name: listing.marketplace, source: entry.source, pluginRoot: entry.pluginRoot }, host: hostOf(ctx), by: ctx.viewer.username, deps: fetchDeps(ctx) });
  if (!done.ok) return done;
  if (!done.value.unchanged) {
    await pluginConnectors(ctx, listing, done.value.plugin.servers, done.value.install.id);
    ctx.audit?.("update_plugin", `customize/plugins/${listing.ref}`, `Updated the plugin ${listing.ref}${done.value.install.version ? ` to ${done.value.install.version}` : ""}${done.value.install.sha ? ` (${done.value.install.sha.slice(0, 8)})` : ""}`);
  }
  const fresh = await plugins.installByRef(ctx.db, ctx.workspaceId, listing.ref);
  return ok(fresh ? plugins.installOut(fresh) : done.value.install);
}

async function setPluginEnabled(ctx: ViewContext, ref: unknown, enabled: unknown): Promise<Result<PluginInstall>> {
  const may = owners(ctx, "switch plugins on and off");
  if (!may.ok) return may;
  const changed = await plugins.setEnabled(ctx.db, ctx.workspaceId, String(ref ?? ""), enabled === true);
  if (changed.ok) ctx.audit?.(enabled === true ? "enable_plugin" : "disable_plugin", `customize/plugins/${String(ref)}`, `${enabled === true ? "Switched on" : "Switched off"} the plugin ${String(ref)}`);
  return changed;
}

async function uninstallPlugin(ctx: ViewContext, ref: unknown): Promise<Result<null>> {
  const may = owners(ctx, "uninstall plugins");
  if (!may.ok) return may;
  const removed = await plugins.uninstall(ctx.db, ctx.workspaceId, String(ref ?? ""), ctx.viewer.username);
  if (!removed.ok) return removed;
  const gone = await connectors.removePluginConnectors(ctx.db, await connectorDeps(ctx), ctx.workspaceId, String(ref));
  ctx.audit?.("uninstall_plugin", `customize/plugins/${String(ref)}`, `Uninstalled the plugin ${String(ref)} (${removed.value.skills.length} skills, ${gone} connectors)`);
  return ok(null);
}

async function pluginAgents(ctx: ViewContext): Promise<Result<PluginAgentTemplate[]>> {
  return ok(await plugins.pluginAgents(ctx.db, ctx.workspaceId));
}

// ── Connectors ───────────────────────────────────────────────────────────

async function listConnectors(ctx: ViewContext): Promise<Result<WorkspaceConnector[]>> {
  return ok(await connectors.connectorsOut(ctx.db, ctx.workspaceId, await labels(ctx)));
}

async function oneConnector(ctx: ViewContext, id: unknown): Promise<Result<WorkspaceConnector>> {
  const all = await connectors.connectorsOut(ctx.db, ctx.workspaceId, await labels(ctx));
  const found = all.find((c) => c.id === id);
  return found ? ok(found) : fail("not_found", "There is no such connector.");
}

async function addConnector(ctx: ViewContext, input: unknown): Promise<Result<WorkspaceConnector>> {
  const may = owners(ctx, "add connectors");
  if (!may.ok) return may;
  const given = (input ?? {}) as Partial<ConnectorInput>;
  if (!given.from || typeof given.from !== "object") return fail("invalid", "Say where the connector comes from.");
  const auth = given.auth === "header" || given.auth === "oauth" ? given.auth : "none";
  let pluginServer: { title: string; url: string } | null = null;
  if (given.from.kind === "plugin") {
    const install = await plugins.installByRef(ctx.db, ctx.workspaceId, given.from.ref);
    const server = install ? plugins.installOut(install).components.mcp_servers.find((s) => s.name === (given.from as { server: string }).server) : null;
    if (!install || !server?.url) return fail("not_found", "That plugin isn't installed here, or names no such server.");
    pluginServer = { title: `${install.display_name ?? install.name}: ${server.name}`, url: server.url };
  }
  const added = await connectors.addConnector(ctx.db, await connectorDeps(ctx), ctx.workspaceId, { from: given.from, auth, header: given.header ?? null }, ctx.viewer.username, pluginServer);
  if (!added.ok) return added;
  ctx.audit?.("add_connector", `customize/connectors/${added.value.name}`, `Added the connector ${added.value.title} (${added.value.url})`);
  return oneConnector(ctx, added.value.id);
}

async function rowFor(ctx: ViewContext, id: unknown): Promise<Result<connectors.ConnectorRow>> {
  const row = await connectors.connectorById(ctx.db, ctx.workspaceId, String(id ?? ""));
  return row ? ok(row) : fail("not_found", "There is no such connector.");
}

async function setConnectorKey(ctx: ViewContext, id: unknown, headerName: unknown, value: unknown): Promise<Result<WorkspaceConnector>> {
  const may = owners(ctx, "change connectors");
  if (!may.ok) return may;
  const row = await rowFor(ctx, id);
  if (!row.ok) return row;
  const done = await connectors.setKey(ctx.db, await connectorDeps(ctx), row.value, typeof headerName === "string" ? headerName : null, String(value ?? ""));
  if (!done.ok) return done;
  ctx.audit?.("set_connector_key", `customize/connectors/${row.value.name}`, `Put a key on the connector ${row.value.title}`);
  return oneConnector(ctx, row.value.id);
}

async function removeConnector(ctx: ViewContext, id: unknown): Promise<Result<null>> {
  const may = owners(ctx, "remove connectors");
  if (!may.ok) return may;
  const row = await rowFor(ctx, id);
  if (!row.ok) return row;
  const done = await connectors.removeConnector(ctx.db, await connectorDeps(ctx), ctx.workspaceId, row.value.id);
  if (done.ok) ctx.audit?.("remove_connector", `customize/connectors/${row.value.name}`, `Removed the connector ${row.value.title}`);
  return done;
}

async function refreshConnector(ctx: ViewContext, id: unknown): Promise<Result<WorkspaceConnector>> {
  const may = owners(ctx, "change connectors");
  if (!may.ok) return may;
  const row = await rowFor(ctx, id);
  if (!row.ok) return row;
  await connectors.refreshTools(ctx.db, await connectorDeps(ctx), row.value);
  return oneConnector(ctx, row.value.id);
}

async function startSignIn(ctx: ViewContext, id: unknown, redirectUri: unknown): Promise<Result<{ url: string }>> {
  const may = owners(ctx, "sign connectors in");
  if (!may.ok) return may;
  const row = await rowFor(ctx, id);
  if (!row.ok) return row;
  const redirect = String(redirectUri ?? "");
  const site = (env(ctx).SITE_URL ?? "https://g1t.sh").replace(/\/+$/, "");
  if (!redirect.startsWith(`${site}/`)) return fail("invalid", "The sign-in must come back to this g1t.");
  return connectors.startSignIn(ctx.db, await connectorDeps(ctx), row.value, redirect);
}

async function finishSignIn(ctx: ViewContext, state: unknown, code: unknown): Promise<Result<WorkspaceConnector>> {
  const may = owners(ctx, "sign connectors in");
  if (!may.ok) return may;
  const id = connectors.connectorOfState(String(state ?? ""));
  if (!id) return fail("invalid", "This sign-in isn't one that was started here.");
  const row = await rowFor(ctx, id);
  if (!row.ok) return row;
  const done = await connectors.finishSignIn(ctx.db, await connectorDeps(ctx), row.value, String(state), String(code ?? ""), ctx.viewer.username);
  if (!done.ok) return done;
  ctx.audit?.("sign_in_connector", `customize/connectors/${row.value.name}`, `Signed the connector ${row.value.title} in (${JSON.parse(done.value.tools || "[]").length} tools)`);
  await answerListing(ctx, listingRef("connector", row.value.name));
  return oneConnector(ctx, row.value.id);
}

async function signOut(ctx: ViewContext, id: unknown): Promise<Result<WorkspaceConnector>> {
  const may = owners(ctx, "change connectors");
  if (!may.ok) return may;
  const row = await rowFor(ctx, id);
  if (!row.ok) return row;
  const done = await connectors.signOut(ctx.db, await connectorDeps(ctx), row.value);
  if (!done.ok) return done;
  ctx.audit?.("sign_out_connector", `customize/connectors/${row.value.name}`, `Signed the connector ${row.value.title} out`);
  return oneConnector(ctx, row.value.id);
}

/** `target`: an agent's handle or a team's slug, resolved to what grants keep (the agent's id, the team's slug). */
async function grantTarget(ctx: ViewContext, scope: SkillScope, target: unknown): Promise<Result<string>> {
  if (scope === "workspace") return ok("");
  const key = String(target ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!key) return fail("invalid", "Say which team or agent.");
  if (scope === "agent") {
    const agent = await ctx.db.prepare("SELECT id FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL").bind(ctx.workspaceId, key).first<{ id: string }>();
    return agent ? ok(agent.id) : fail("not_found", `There is no agent called @${key}.`);
  }
  const teams = await identityClient(env(ctx).IDENTITY)
    .listTeams(ctx.viewer, ctx.slug)
    .catch(() => null);
  return teams?.ok && teams.value.some((t) => t.slug === key) ? ok(key) : fail("not_found", `There is no team called ${key}.`);
}

async function grantConnector(ctx: ViewContext, id: unknown, scope: unknown, target: unknown): Promise<Result<WorkspaceConnector>> {
  const may = owners(ctx, "give connectors to agents");
  if (!may.ok) return may;
  const row = await rowFor(ctx, id);
  if (!row.ok) return row;
  const where = scope === "team" || scope === "agent" ? scope : "workspace";
  const resolved = await grantTarget(ctx, where, target);
  if (!resolved.ok) return resolved;
  const done = await connectors.grant(ctx.db, await connectorDeps(ctx), ctx.workspaceId, row.value.id, where, resolved.value, ctx.viewer.username);
  if (!done.ok) return done;
  ctx.audit?.("grant_connector", `customize/connectors/${row.value.name}`, `Gave the connector ${row.value.title} to ${where === "workspace" ? "every agent" : where === "team" ? `the team ${resolved.value}` : `@${String(target).replace(/^@/, "")}`}`);
  return oneConnector(ctx, row.value.id);
}

async function revokeConnector(ctx: ViewContext, id: unknown, grantId: unknown): Promise<Result<WorkspaceConnector>> {
  const may = owners(ctx, "change where connectors reach");
  if (!may.ok) return may;
  const row = await rowFor(ctx, id);
  if (!row.ok) return row;
  const done = await connectors.revoke(ctx.db, ctx.workspaceId, String(grantId ?? ""));
  if (!done.ok) return done;
  ctx.audit?.("revoke_connector", `customize/connectors/${row.value.name}`, `Took the connector ${row.value.title} back from somewhere it reached`);
  return oneConnector(ctx, row.value.id);
}

async function agentConnectors(ctx: ViewContext, handle: unknown): Promise<Result<AgentConnector[]>> {
  const key = String(handle ?? "").trim().replace(/^@/, "").toLowerCase();
  const agent = await ctx.db.prepare("SELECT * FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL").bind(ctx.workspaceId, key).first<Parameters<typeof definitionOf>[0]>();
  if (!agent) return fail("not_found", `There is no agent called @${key}.`);
  const teams = await identityClient(env(ctx).IDENTITY)
    .agentTeams(ctx.slug, agent.id)
    .catch(() => []);
  const reach = await connectors.reaching(ctx.db, ctx.workspaceId, agent.id, teams.map((t) => t.slug));
  const names = new Map(teams.map((t) => [t.slug, t.name]));
  return ok(connectors.agentConnectorsOut(reach, definitionOf(agent).abilities.mcp_servers ?? [], { teamName: (slug) => names.get(slug) ?? slug }));
}

// ── The bundle a runner gets ─────────────────────────────────────────────

/**
 * What a job's Claude Code receives: read with the job's agent token (or a
 * workspace token), so what reaches it is what reaches that agent. Secrets
 * are in it: the API hands it to the runner only.
 */
async function bundle(ctx: ViewContext): Promise<Result<CustomizeBundle>> {
  const kind = ctx.viewer.kind ?? "user";
  if (kind !== "agent" && kind !== "workspace" && !ctx.owner) return fail("forbidden", "The bundle is read by a job's agent token.");
  const agent = kind === "agent" ? await ctx.db.prepare("SELECT id FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL").bind(ctx.workspaceId, ctx.viewer.username.toLowerCase()).first<{ id: string }>() : null;
  const teams = agent
    ? await identityClient(env(ctx).IDENTITY)
        .agentTeams(ctx.slug, agent.id)
        .then((t) => t.map((x) => x.slug))
        .catch(() => [])
    : [];
  const installs = (await plugins.listInstalls(ctx.db, ctx.workspaceId)).filter((row) => row.enabled === 1);
  const skillRows = await ctx.db
    .prepare(
      `SELECT DISTINCT s.id, s.name, s.plugin, a.version FROM skill_attachments a
       JOIN skills s ON s.id = a.skill_id AND s.archived_at IS NULL AND s.status = 'published'
       WHERE a.workspace_id = ?1 AND (a.scope = 'workspace' OR (a.scope = 'agent' AND a.target = ?2) OR (a.scope = 'team' AND a.target IN (SELECT value FROM json_each(?3))))
       LIMIT 200`,
    )
    .bind(ctx.workspaceId, agent?.id ?? "", JSON.stringify(teams))
    .all<{ id: string; name: string; plugin: string | null; version: number }>();
  const skills: CustomizeBundle["skills"] = [];
  for (const row of skillRows.results) {
    // A plugin's skills reach Claude Code with the plugin itself.
    if (row.plugin) continue;
    const version = await ctx.db.prepare("SELECT skill_md, files FROM skill_versions WHERE skill_id = ? AND version = ?").bind(row.id, row.version).first<{ skill_md: string; files: string }>();
    if (!version) continue;
    let files: SkillFile[] = [];
    try {
      files = JSON.parse(version.files) as SkillFile[];
    } catch {
      files = [];
    }
    skills.push({ name: row.name, plugin: null, files: [{ path: "SKILL.md", content: version.skill_md, encoding: "utf8" }, ...files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding ?? "utf8" }))] });
  }
  const deps = await connectorDeps(ctx);
  const reach = agent ? await connectors.reaching(ctx.db, ctx.workspaceId, agent.id, teams) : (await connectors.listConnectors(ctx.db, ctx.workspaceId)).map((row) => ({ row, via: "workspace" as const }));
  const out: CustomizeBundle["connectors"] = [];
  for (const { row } of reach) {
    if (connectors.stateOf(row) !== "connected") continue;
    const headers = await connectors.headersFor(ctx.db, deps, row);
    if (headers) out.push({ name: row.name, url: row.url, headers });
  }
  return ok({
    plugins: installs.map((row) => ({ ref: row.ref, name: row.name, fetch: plugins.installOut(row).fetch, version: row.version })),
    skills,
    connectors: out,
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/** Answers a Customize method, or null when `method` isn't one. */
export async function customizeRpc(
  method: string,
  args: any,
  view: <T>(a: { workspace: string; viewer: User | null }, run: (ctx: ViewContext) => Promise<Result<T>>) => Promise<Result<T>>,
): Promise<Result<unknown> | null> {
  switch (method) {
    case "marketplaces":
      return view(args, listMarketplaces);
    case "add_marketplace":
      return view(args, (ctx) => addMarketplace(ctx, args.address, args.name));
    case "remove_marketplace":
      return view(args, (ctx) => removeMarketplace(ctx, args.name));
    case "refresh_marketplace":
      return view(args, (ctx) => refreshMarketplace(ctx, args.name));
    case "discover":
      return view(args, discover);
    case "plugin":
      return view(args, (ctx) => pluginDetail(ctx, args.ref));
    case "plugin_installs":
      return view(args, pluginInstalls);
    case "install_plugin":
      return view(args, (ctx) => installPlugin(ctx, args.ref));
    case "set_plugin_enabled":
      return view(args, (ctx) => setPluginEnabled(ctx, args.ref, args.enabled));
    case "uninstall_plugin":
      return view(args, (ctx) => uninstallPlugin(ctx, args.ref));
    case "update_plugin":
      return view(args, (ctx) => updatePlugin(ctx, args.ref));
    case "plugin_agents":
      return view(args, pluginAgents);
    case "connectors":
      return view(args, listConnectors);
    case "connector":
      return view(args, (ctx) => oneConnector(ctx, args.id));
    case "add_connector":
      return view(args, (ctx) => addConnector(ctx, args.input));
    case "set_connector_key":
      return view(args, (ctx) => setConnectorKey(ctx, args.id, args.header_name, args.value));
    case "remove_connector":
      return view(args, (ctx) => removeConnector(ctx, args.id));
    case "refresh_connector":
      return view(args, (ctx) => refreshConnector(ctx, args.id));
    case "start_connector_sign_in":
      return view(args, (ctx) => startSignIn(ctx, args.id, args.redirect_uri));
    case "finish_connector_sign_in":
      return view(args, (ctx) => finishSignIn(ctx, args.state, args.code));
    case "sign_out_connector":
      return view(args, (ctx) => signOut(ctx, args.id));
    case "grant_connector":
      return view(args, (ctx) => grantConnector(ctx, args.id, args.scope, args.target));
    case "revoke_connector":
      return view(args, (ctx) => revokeConnector(ctx, args.id, args.grant));
    case "agent_connectors":
      return view(args, (ctx) => agentConnectors(ctx, args.handle));
    case "customize_bundle":
      return view(args, bundle);
    default:
      return null;
  }
}

export type { McpServer };
