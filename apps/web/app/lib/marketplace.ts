/**
 * The Marketplace (routes/workspace/marketplace/): what a workspace can
 * add today, read against what it has and what its people asked for.
 *
 * Two kinds of listing can be added now: an agent from the catalog (the
 * agents service's role templates) and an integration the connector
 * catalog marks available for a workspace. Owners add them; anyone else
 * asks, and the agents service keeps the request (`install_requests`).
 * Extensions have no listings yet: their tiers are described, not filled.
 *
 * No Workers or React imports, so it can be tested under Node.
 */
import type { AgentTemplate, ExtensionInstall, ExtensionManifest, InstallRequest, InstallRequestStatus, ListingTier, WorkspaceAgent } from "@g1t/contracts";
import { type ConnectorView, connectorPath } from "@g1t/contracts/connectors";
import { listingRef, parseListing } from "@g1t/contracts/marketplace";

import type { ConnectedState } from "./connectors";

/** The Marketplace's pages, under `/<workspace>/-/marketplace`. */
export function marketplacePath(slug: string, page: "" | "agents" | "integrations" | "extensions" | "requests" = ""): string {
  return `/${slug}/-/marketplace${page ? `/${page}` : ""}`;
}

/** One role's page in the agent catalog. */
export function catalogAgentPath(slug: string, template: string): string {
  return `/${slug}/-/marketplace/agents/${template}`;
}

/** Where an owner hires an agent into a role: the new-agent form, with the role chosen. */
export function hirePath(slug: string, template: string): string {
  return `/${slug}/-/agents/new?template=${encodeURIComponent(template)}`;
}

/** Who stands behind a listing, in a word and a sentence. */
export const TIERS: Record<ListingTier, { label: string; about: string }> = {
  official: { label: "Official", about: "Built and supported by g1t." },
  verified: { label: "Verified", about: "From a reviewed publisher, whose code and permissions are checked before it is listed." },
  community: { label: "Community", about: "From anyone, shared from a public repository. Pages run sandboxed; server code waits for an isolated sandbox." },
  internal: { label: "Internal", about: "Built by your own people and agents, and seen only by your workspace." },
};

/** Whether `request` is `username`'s and still waiting. */
function openFor(request: InstallRequest, ref: string, username: string): boolean {
  return request.status === "open" && request.listing === ref && request.requested_by.toLowerCase() === username.toLowerCase();
}

/** Open requests for `ref`. */
function openCount(requests: InstallRequest[], ref: string): number {
  return requests.filter((request) => request.status === "open" && request.listing === ref).length;
}

/** A role in the agent catalog, with what the workspace has of it. */
export type AgentListing = {
  ref: string;
  template: AgentTemplate;
  /** The workspace's agents hired into this role, not archived. */
  hired: Pick<WorkspaceAgent, "id" | "handle" | "display_name">[];
  /** The viewer asked for it, and an owner hasn't answered. */
  requested: boolean;
  /** Open requests for it: everyone's for an owner, the viewer's own otherwise. */
  waiting: number;
};

/**
 * Every role in the catalog, in the order the agents service gives them,
 * with who has been hired into each. `agents` null: the agents service
 * could not say, so nobody counts as hired.
 */
export function agentListings(
  templates: AgentTemplate[],
  agents: Pick<WorkspaceAgent, "id" | "handle" | "display_name" | "template" | "archived_at">[] | null,
  requests: InstallRequest[],
  username: string,
): AgentListing[] {
  return templates.map((template) => {
    const ref = listingRef("agent", template.id);
    return {
      ref,
      template,
      hired: (agents ?? [])
        .filter((agent) => agent.template === template.id && !agent.archived_at)
        .map(({ id, handle, display_name }) => ({ id, handle, display_name })),
      requested: requests.some((request) => openFor(request, ref, username)),
      waiting: openCount(requests, ref),
    };
  });
}

/** An integration a workspace can connect, with whether it has. */
export type IntegrationListing = {
  ref: string;
  view: ConnectorView;
  /** How it is doing, when it is connected. */
  connected: ConnectedState | null;
  /** Where an owner connects it, or manages it once connected. */
  href: string | null;
  requested: boolean;
  waiting: number;
};

/**
 * The integrations a workspace can connect today, connected ones first,
 * each in catalog order. `connected` comes from the integrations service
 * and the GitHub App (lib/connected.server.ts).
 */
export function integrationListings(
  views: ConnectorView[],
  connected: Record<string, ConnectedState>,
  requests: InstallRequest[],
  username: string,
  slug: string,
): IntegrationListing[] {
  const listings = views
    .filter((view) => view.status === "available")
    .map((view) => {
      const ref = listingRef("integration", view.id);
      const state = connected[view.id] ?? null;
      const setup = view.href ? connectorPath(view.href, slug) : null;
      return {
        ref,
        view,
        connected: state,
        href: state?.manage ?? setup,
        requested: requests.some((request) => openFor(request, ref, username)),
        waiting: openCount(requests, ref),
      };
    });
  return [...listings.filter((l) => l.connected), ...listings.filter((l) => !l.connected)];
}

/**
 * The integrations the catalog lists as coming: a workspace's, then those
 * each person connects for themselves (a calendar, a mailbox), once each.
 */
export function comingIntegrations(views: ConnectorView[], personal: ConnectorView[] = []): ConnectorView[] {
  const workspace = views.filter((view) => view.status === "soon");
  const seen = new Set(workspace.map((view) => view.id));
  const own = personal.filter((view) => view.status === "soon" && !seen.has(view.id) && !views.some((v) => v.id === view.id));
  return [...workspace, ...own];
}

/** An extension in the Marketplace, with whether the workspace has it. */
export type ExtensionListing = {
  ref: string;
  manifest: ExtensionManifest;
  install: ExtensionInstall | null;
  requested: boolean;
  waiting: number;
};

/** Every extension listed, published ones first, each with its install. */
export function extensionListings(manifests: ExtensionManifest[], installs: ExtensionInstall[], requests: InstallRequest[], username: string): ExtensionListing[] {
  const listings = manifests.map((manifest) => {
    const ref = listingRef("extension", manifest.id);
    return {
      ref,
      manifest,
      install: installs.find((install) => install.listing === ref) ?? null,
      requested: requests.some((request) => openFor(request, ref, username)),
      waiting: openCount(requests, ref),
    };
  });
  return [...listings.filter((l) => l.manifest.status === "available"), ...listings.filter((l) => l.manifest.status !== "available")];
}

/** One extension's page in the Marketplace. */
export function extensionPath(slug: string, id: string): string {
  return `/${slug}/-/marketplace/extensions/${id}`;
}

/** Where an extension runs, in words. */
export function runtimeWords(manifest: Pick<ExtensionManifest, "runtime" | "publisher">): string {
  return manifest.runtime === "hosted" ? `Runs on g1t` : `Runs on ${manifest.publisher.name}'s servers`;
}

/** Whether an integration listing matches what someone typed: its name, category words, capabilities or keywords. */
export function integrationMatches(listing: IntegrationListing, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  const { view } = listing;
  return [view.name, view.description, view.category, ...view.capabilities, ...view.keywords].some((word) => word.toLowerCase().includes(wanted));
}

/** The requests still waiting on an owner. */
export function openRequests(requests: InstallRequest[]): InstallRequest[] {
  return requests.filter((request) => request.status === "open");
}

/** Where an owner goes to add what a request asks for: the hire form, or the integration's setup page. */
export function addPath(request: Pick<InstallRequest, "listing">, slug: string, views: ConnectorView[]): string | null {
  const parsed = parseListing(request.listing);
  if (!parsed) return null;
  if (parsed.kind === "agent") return hirePath(slug, parsed.id);
  if (parsed.kind === "extension") return extensionPath(slug, parsed.id);
  const view = views.find((v) => v.id === parsed.id);
  return view?.href ? connectorPath(view.href, slug) : null;
}

/** What the Marketplace's forms ask for, read from one. */
export type MarketplaceForm =
  | { intent: "request"; listing: string; note: string | null }
  | { intent: "resolve"; id: string; status: Exclude<InstallRequestStatus, "open"> }
  | { intent: "install"; extension: string }
  | { intent: "switch"; listing: string; enabled: boolean }
  | { intent: "uninstall"; listing: string };

/** A Marketplace form's request; null when it asks for nothing that makes sense. */
export function marketplaceForm(form: FormData): MarketplaceForm | null {
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
  const listing = String(form.get("listing") ?? "");
  const extension = parseListing(listing)?.kind === "extension" ? listing : null;
  if (intent === "install") {
    const id = String(form.get("extension") ?? "");
    return /^[a-z][a-z0-9-]{1,31}$/.test(id) ? { intent, extension: id } : null;
  }
  if (intent === "switch" && extension) {
    const enabled = form.get("enabled");
    return enabled === "on" || enabled === "off" ? { intent, listing: extension, enabled: enabled === "on" } : null;
  }
  if (intent === "uninstall" && extension) return { intent, listing: extension };
  return null;
}

/** "Software Engineer, Engineering": a role as one line. */
export function roleLine(template: Pick<AgentTemplate, "title" | "department">): string {
  return template.department ? `${template.title} · ${template.department}` : template.title;
}

/** How a routing limit reads: "Any model", "At least large", "Up to large", "Large to frontier". */
export function routingWords(routing: Pick<AgentTemplate["routing"], "floor" | "ceiling">): string {
  const name = (tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1);
  if (routing.floor && routing.ceiling) return `${name(routing.floor)} to ${routing.ceiling} models`;
  if (routing.floor) return `${name(routing.floor)} models or better`;
  if (routing.ceiling) return `Up to ${routing.ceiling} models`;
  return "Any model the work needs";
}
