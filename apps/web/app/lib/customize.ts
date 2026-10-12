/**
 * Customize (routes/workspace/customize/): Skills, Connectors and Plugins,
 * each with what the workspace has (Yours) and what it can add (Discover),
 * read against what its people asked for. The wire shapes are
 * @g1t/contracts customize.ts; this file is the site's reading of them:
 * which view and search the address asks for, filters and grouping for
 * Discover, where a request is answered, and what the forms post.
 *
 * No Workers or React imports, so it can be tested under Node.
 */
import type { ConnectorState, InstallRequest, InstallRequestStatus, ListingKind, PluginAgentTemplate, PluginAvailability, PluginComponents, PluginListing, SkillListing, SkillScope, WorkspaceConnector } from "@g1t/contracts";
import { type ConnectorView, connectorPath } from "@g1t/contracts/connectors";
import { type ConnectorAuth, type CustomizeSection, customizePath } from "@g1t/contracts/customize";
import { type FetchPlan, parsePluginRef } from "@g1t/contracts/claude-plugin";
import { listingRef, parseListing } from "@g1t/contracts/marketplace";

import { type AgentDraft, BLANK_DRAFT, cleanHandle } from "./agent-form.ts";
import type { ConnectedState } from "./connectors.ts";

// ── The address ──────────────────────────────────────────────────────────

/** What a tab shows: what the workspace has, or what it can add. */
export type CustomizeView = "yours" | "discover";

/** The view the address asks for (`?view=discover`); Yours otherwise. */
export function readView(params: URLSearchParams): CustomizeView {
  return params.get("view") === "discover" ? "discover" : "yours";
}

/** What was typed into the search (`?q=`), trimmed. */
export function readQuery(params: URLSearchParams): string {
  return (params.get("q") ?? "").trim();
}

/**
 * The same page with `changes` applied to its query: a value of null takes
 * the key out, and so does the default view, so Yours has a clean address.
 */
export function withParams(pathname: string, params: URLSearchParams, changes: Record<string, string | null>): string {
  const query = nextParams(params, changes).toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** The query with `changes` applied, as `withParams` applies them. */
export function nextParams(params: URLSearchParams, changes: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value == null || value === "" || (key === "view" && value === "yours")) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

/** The tab a Customize address is on, when it is one of the three tabs' own pages. */
export function tabOf(pathname: string): CustomizeSection | null {
  const match = /^\/[^/]+\/-\/customize\/(skills|connectors|plugins)\/?$/.exec(pathname.replace(/\.data$/, ""));
  return match ? (match[1] as CustomizeSection) : null;
}

/** One plugin's page: its ref (`name@marketplace`) in the address, encoded. */
export function pluginPath(slug: string, ref: string): string {
  return customizePath("plugins", slug, encodeURIComponent(ref));
}

/** One connector's page. */
export function connectorPagePath(slug: string, id: string): string {
  return customizePath("connectors", slug, encodeURIComponent(id));
}

/** Where a connector is added: from the directory entry `directory`, or by address. */
export function connectorNewPath(slug: string, directory?: string | null): string {
  return `${customizePath("connectors", slug, "new")}${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`;
}

/** Where a connector's sign-in comes back to, as a path on this site. */
export function connectorCallbackPath(slug: string): string {
  return customizePath("connectors", slug, "callback");
}

// ── Listings and requests ────────────────────────────────────────────────

/** The reference a request names for a skill in a marketplace: `skill:<plugin@marketplace>/<name>`. */
export function skillListingRef(listing: Pick<SkillListing, "plugin" | "marketplace" | "name">): string {
  return listingRef("skill", `${listing.plugin}@${listing.marketplace}/${listing.name}`);
}

/** The reference a request names for a plugin. */
export function pluginListingRef(listing: Pick<PluginListing, "ref">): string {
  return listingRef("plugin", listing.ref);
}

/** The reference a request names for a connector from the directory. */
export function connectorListingRef(directoryId: string): string {
  return listingRef("connector", directoryId);
}

/** The requests still waiting on an owner. */
export function openRequests(requests: readonly InstallRequest[]): InstallRequest[] {
  return requests.filter((request) => request.status === "open");
}

/** Whether `username` has asked for `ref` and is still waiting. */
export function requestedBy(requests: readonly InstallRequest[], ref: string, username: string): boolean {
  return requests.some((request) => request.status === "open" && request.listing === ref && request.requested_by.toLowerCase() === username.toLowerCase());
}

/** How many people are waiting for `ref`. */
export function waitingFor(requests: readonly InstallRequest[], ref: string): number {
  return openRequests(requests).filter((request) => request.listing === ref).length;
}

/** What a request asked for, in a word. */
export function kindWord(kind: ListingKind): string {
  switch (kind) {
    case "plugin":
      return "Plugin";
    case "skill":
      return "Skill";
    case "connector":
      return "Connector";
    case "integration":
      return "Integration";
    case "extension":
      return "Extension";
  }
}

/**
 * Where an owner goes to add what a request asks for: the plugin's page, the
 * page of the plugin that brings a skill, the connector's connect page, or
 * an integration's setup page from the directory `views`. Null when there
 * is nowhere, or the request names something that isn't added here.
 */
export function addPath(request: Pick<InstallRequest, "listing">, slug: string, views: readonly ConnectorView[]): string | null {
  const parsed = parseListing(request.listing);
  if (!parsed) return null;
  if (parsed.kind === "plugin") return parsePluginRef(parsed.id) ? pluginPath(slug, parsed.id) : null;
  if (parsed.kind === "skill") {
    const slash = parsed.id.indexOf("/");
    const plugin = slash > 0 ? parsed.id.slice(0, slash) : null;
    return plugin && parsePluginRef(plugin) ? pluginPath(slug, plugin) : null;
  }
  if (parsed.kind === "connector") return connectorNewPath(slug, parsed.id);
  if (parsed.kind === "integration") {
    const view = views.find((v) => v.id === parsed.id);
    return view?.href ? connectorPath(view.href, slug) : null;
  }
  return null;
}

/** What the requests page's forms ask for, read from one. */
export type CustomizeForm = { intent: "request"; listing: string; note: string | null } | { intent: "resolve"; id: string; status: Exclude<InstallRequestStatus, "open"> };

/** A requests form's request; null when it asks for nothing that makes sense. */
export function customizeForm(form: FormData): CustomizeForm | null {
  const intent = form.get("intent");
  if (intent === "request") {
    const listing = String(form.get("listing") ?? "");
    if (!parseListing(listing)) return null;
    const note = String(form.get("note") ?? "").trim();
    return { intent, listing, note: note || null };
  }
  if (intent === "resolve") {
    const id = String(form.get("id") ?? "");
    const status = form.get("status");
    if (!id || (status !== "done" && status !== "declined")) return null;
    return { intent, id, status };
  }
  return null;
}

// ── Search and filters ───────────────────────────────────────────────────

/** Lowercased, without accents or punctuation, for matching. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether every word typed appears somewhere in `fields`. */
export function matches(fields: readonly (string | null | undefined)[], query: string): boolean {
  const words = fold(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(fields.filter((field): field is string => !!field).join(" "));
  const compact = haystack.replace(/ /g, "");
  return words.every((word) => haystack.includes(word) || compact.includes(word));
}

export type PluginSort = "marketplace" | "name";

/** What Discover's plugins are narrowed and ordered by, from the address. */
export type PluginFilters = { q: string; category: string | null; marketplace: string | null; sort: PluginSort };

export function readPluginFilters(params: URLSearchParams): PluginFilters {
  return {
    q: readQuery(params),
    category: params.get("category") || null,
    marketplace: params.get("marketplace") || null,
    sort: params.get("sort") === "name" ? "name" : "marketplace",
  };
}

/** The categories the listings name, once each, in order of how many name them. */
export function categoriesOf(listings: readonly { category: string | null }[]): string[] {
  const counts = new Map<string, number>();
  for (const listing of listings) if (listing.category) counts.set(listing.category, (counts.get(listing.category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category]) => category);
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** The plugins that pass `filters`, by marketplace then name, or by name alone. */
export function filterPlugins(listings: readonly PluginListing[], filters: PluginFilters): PluginListing[] {
  const kept = listings.filter(
    (listing) =>
      (!filters.category || listing.category === filters.category) &&
      (!filters.marketplace || listing.marketplace === filters.marketplace) &&
      matches([listing.name, listing.display_name, listing.description, listing.author, listing.category, listing.marketplace, ...listing.tags, ...listing.keywords, ...listing.skills], filters.q),
  );
  return filters.sort === "name" ? kept.sort(byName) : kept.sort((a, b) => a.marketplace.localeCompare(b.marketplace) || byName(a, b));
}

/** The skills that match what was typed and the category chosen, by name. */
export function filterSkills(listings: readonly SkillListing[], filters: { q: string; category: string | null }): SkillListing[] {
  return listings
    .filter((listing) => (!filters.category || listing.category === filters.category) && matches([listing.name, listing.description, listing.plugin, listing.author, listing.category, listing.marketplace], filters.q))
    .sort(byName);
}

/** Listings grouped under their marketplace, in the order they come. */
export function groupByMarketplace<T extends { marketplace: string }>(items: readonly T[]): { marketplace: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.marketplace);
    if (group) group.push(item);
    else groups.set(item.marketplace, [item]);
  }
  return [...groups.entries()].map(([marketplace, items]) => ({ marketplace, items }));
}

// ── What a listing says about itself ─────────────────────────────────────

/** A plugin's availability in a word, with a tone for its badge. */
export function availabilityWord(availability: PluginAvailability): { label: string; tone: "success" | "neutral" | "warn" | "accent" } {
  switch (availability.kind) {
    case "available":
      return { label: "Available", tone: "neutral" };
    case "installed":
      return availability.enabled ? { label: "Installed", tone: "success" } : { label: "Switched off", tone: "warn" };
    case "unavailable":
      return { label: "Not available here", tone: "neutral" };
    case "soon":
      return { label: "Soon", tone: "accent" };
  }
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a plugin brings g1t's agents, as short chips: "3 skills", "1 agent", "2 connectors". */
export function componentChips(components: PluginComponents): string[] {
  const chips: string[] = [];
  const skills = components.skills.length + components.commands.length;
  if (skills) chips.push(count(skills, "skill"));
  if (components.agents.length) chips.push(count(components.agents.length, "agent"));
  const remote = components.mcp_servers.filter((server) => server.remote).length;
  if (remote) chips.push(count(remote, "connector"));
  return chips;
}

/** What only Claude Code on a runner uses, in words: hooks, LSP, output styles, bin, and stdio servers. */
export function claudeCodeOnly(components: PluginComponents): string[] {
  const parts: string[] = [];
  if (components.hooks) parts.push("hooks");
  if (components.lsp) parts.push("LSP");
  if (components.output_styles) parts.push("output styles");
  if (components.bin) parts.push("bin");
  const local = components.mcp_servers.filter((server) => !server.remote).length;
  if (local) parts.push(count(local, "local MCP server"));
  return parts;
}

/** Where a plugin is read from, in a few words; what keeps it from being read, when something does. */
export function fetchWords(fetch: FetchPlan): string {
  switch (fetch.kind) {
    case "github":
      return `github.com/${fetch.repo}${fetch.path ? `/${fetch.path}` : ""}${fetch.ref ? ` at ${fetch.ref}` : ""}`;
    case "g1t":
      return `${fetch.repo}${fetch.path ? `/${fetch.path}` : ""} on this g1t${fetch.ref ? ` at ${fetch.ref}` : ""}`;
    case "archive":
      return fetch.url;
    case "unsupported":
      return fetch.why;
  }
}

/** Each connector state in words, with a tone for its badge. */
export const CONNECTOR_STATES: Record<ConnectorState, { label: string; tone: "success" | "warn" | "danger" | "neutral" }> = {
  connected: { label: "Connected", tone: "success" },
  needs_sign_in: { label: "Needs sign-in", tone: "warn" },
  needs_key: { label: "Needs a key", tone: "warn" },
  problem: { label: "Problem", tone: "danger" },
};

/** How a connector signs in, in words. */
export const AUTH_WORDS: Record<ConnectorAuth, string> = {
  none: "No sign-in",
  header: "A key",
  oauth: "Signs in with the browser",
};

/** The auth a form names, or none. */
export function readAuth(value: unknown): ConnectorAuth {
  return value === "header" || value === "oauth" ? value : "none";
}

/** Where a connector came from, in a few words. */
export function fromWords(from: WorkspaceConnector["from"]): string {
  switch (from.kind) {
    case "directory":
      return "From the directory";
    case "plugin":
      return `Brought by ${from.ref}`;
    case "address":
      return "Added by address";
    case "agent":
      return `Moved from @${from.handle}`;
  }
}

// ── The connectors directory ─────────────────────────────────────────────

/** An MCP-backed entry of the directory, with the workspace's connector from it, if any. */
export type McpDirectoryEntry = { view: ConnectorView; connector: WorkspaceConnector | null };

/** One of g1t's own integrations in the directory: connected, connectable (with where), or not available here (with why). */
export type IntegrationEntry = { view: ConnectorView; state: ConnectedState | null; why: string | null; href: string | null };

export type ConnectorsDirectory = {
  /** Remote MCP servers, connected from Customize: the ones not yet connected first. */
  mcp: McpDirectoryEntry[];
  /** g1t's own integrations, set up on their own pages: connected ones first. */
  integrations: IntegrationEntry[];
  /** Planned, not built. */
  soon: ConnectorView[];
};

/**
 * The directory for a workspace: its MCP-backed entries against the
 * workspace's connectors (by directory id), g1t's integrations against what
 * is connected (lib/connected.server.ts) and what this g1t can't connect,
 * and what is coming. `query` narrows every part.
 */
export function connectorsDirectory(
  views: readonly ConnectorView[],
  connectors: readonly WorkspaceConnector[],
  connected: Record<string, ConnectedState>,
  unavailable: Record<string, string>,
  slug: string,
  query = "",
): ConnectorsDirectory {
  const shown = views.filter((view) => matches([view.name, view.description, view.category, ...view.capabilities, ...view.keywords], query));
  const fromDirectory = new Map(connectors.filter((c) => c.from.kind === "directory").map((c) => [(c.from as { id: string }).id, c]));
  const mcp = shown.filter((view) => view.mcp && view.status === "available").map((view) => ({ view, connector: fromDirectory.get(view.id) ?? null }));
  mcp.sort((a, b) => Number(!!a.connector) - Number(!!b.connector));
  const integrations = shown
    .filter((view) => !view.mcp && view.status === "available")
    .map((view) => {
      const state = connected[view.id] ?? null;
      const why = state ? null : (unavailable[view.id] ?? null);
      return { view, state, why, href: state?.manage ?? (view.href && !why ? connectorPath(view.href, slug) : null) };
    });
  integrations.sort((a, b) => Number(!!b.state) - Number(!!a.state));
  return { mcp, integrations, soon: shown.filter((view) => view.status === "soon") };
}

/** What each person connects for themselves, available today. */
export function personalDirectory(views: readonly ConnectorView[], query = ""): ConnectorView[] {
  return views.filter((view) => view.status === "available" && view.href != null && matches([view.name, view.description, ...view.keywords], query));
}

// ── Where something reaches ──────────────────────────────────────────────

/** Where a skill or a connector reaches: every agent, a team's, or one agent. */
export type Reach = { id: string; scope: SkillScope; target: string | null; label: string };

/** Who may be given something: owners every agent and any agent, team maintainers their teams. */
export type ReachTargets = { can_manage: boolean; teams: readonly { slug: string; name: string }[]; agents: readonly { handle: string; display_name: string }[] };

export type ReachOption = { value: string; label: string; checked: boolean; reach: Reach | null };

/** `scope:target` as the menu carries it, split. */
export function splitTarget(value: string): { scope: SkillScope; target: string | null } {
  const colon = value.indexOf(":");
  const scope = (colon > 0 ? value.slice(0, colon) : value) as SkillScope;
  const target = colon > 0 ? value.slice(colon + 1) : "";
  return { scope: scope === "team" || scope === "agent" ? scope : "workspace", target: target || null };
}

/** Every place the viewer may give something, each saying whether it already reaches there. */
export function reachOptions(reach: readonly Reach[], targets: ReachTargets): ReachOption[] {
  const has = (scope: SkillScope, target: string | null) => reach.find((r) => r.scope === scope && (r.target ?? "").toLowerCase() === (target ?? "").toLowerCase()) ?? null;
  const options: ReachOption[] = [];
  const add = (scope: SkillScope, target: string | null, label: string) => {
    const found = has(scope, target);
    options.push({ value: `${scope}:${target ?? ""}`, label, checked: !!found, reach: found });
  };
  if (targets.can_manage) add("workspace", null, "Every agent");
  for (const team of targets.teams) add("team", team.slug, `Team ${team.name}`);
  if (targets.can_manage) for (const agent of targets.agents) add("agent", agent.handle, `@${agent.handle}`);
  return options;
}

/** Where something reaches, in one line: "Every agent", "QA and @margo", "no agent yet". */
export function reachWords(reach: readonly Reach[]): string {
  if (reach.length === 0) return "no agent yet";
  if (reach.some((r) => r.scope === "workspace")) return "Every agent";
  const labels = reach.map((r) => r.label);
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
}

// ── Hiring a plugin's agent ──────────────────────────────────────────────

/** "code-reviewer" as a name: "Code Reviewer". */
export function titleOf(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A plugin's subagent as the new-agent form starts: its name, its
 * description as what it is responsible for, its system prompt as the
 * instructions, and its model (haiku, sonnet, opus) as a routing limit.
 */
export function pluginAgentDraft(template: PluginAgentTemplate): AgentDraft {
  const model = (template.model ?? "").toLowerCase();
  const routing = { ...BLANK_DRAFT.routing };
  if (model.includes("haiku")) routing.ceiling = "small";
  else if (model.includes("opus")) routing.floor = "frontier";
  else if (model.includes("sonnet")) routing.floor = "large";
  const display = titleOf(template.name);
  return {
    ...BLANK_DRAFT,
    handle: cleanHandle(template.name),
    display_name: display,
    title: display,
    responsibilities: template.description ? [template.description] : [],
    instructions: template.prompt,
    routing,
  };
}

// ── Reloading ────────────────────────────────────────────────────────────

/**
 * Whether a Customize page's data is read again for a move from `current`
 * to `next`: typing a search or picking a filter changes only the address,
 * so nothing is reloaded; another page, the other view, or a form that
 * posted is read again.
 */
export function needsReload(current: URL, next: URL, formMethod: string | undefined): boolean {
  if (formMethod && formMethod.toUpperCase() !== "GET") return true;
  if (current.pathname !== next.pathname) return true;
  return readView(current.searchParams) !== readView(next.searchParams);
}

// ── A page's flash ───────────────────────────────────────────────────────

/** What a page says it just did, from its address (`?signed_in=1`, `?added=1`, `?problem=…`). */
export function flashOf(params: URLSearchParams): { tone: "success" | "danger"; text: string } | null {
  const problem = params.get("problem");
  if (problem) return { tone: "danger", text: problem };
  if (params.get("signed_in") === "1") return { tone: "success", text: "Signed in. Its tools are listed below; give it to agents with Available to." };
  if (params.get("added") === "1") return { tone: "success", text: "Connected. Give it to agents with Available to." };
  return null;
}
