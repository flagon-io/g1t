/**
 * The Marketplace (routes/workspace/marketplace/): what adds functionality
 * to a workspace, read against what it has and what its people asked for.
 *
 * Two kinds of listing: extensions, which add pages, data, cards and agent
 * roles (g1t's own are listed before their first release), and
 * integrations, which connect what a team already uses so agents can work
 * with it. Owners add them; anyone else asks, and the agents service keeps
 * the request (`install_requests`). Agents aren't listed: they start from
 * templates in Agents mode (lib/agent-templates.ts).
 *
 * No Workers or React imports, so it can be tested under Node.
 */
import type { ExtensionInstall, ExtensionManifest, InstallRequest, InstallRequestStatus, ListingKind, ListingTier } from "@g1t/contracts";
import { CONNECTOR_CATEGORIES, type Connector, type ConnectorCapability, type ConnectorScope, type ConnectorView, connectorPath, connectorView } from "@g1t/contracts/connectors";
import { CONNECTOR_PUBLISHER, LISTING_TIERS, listingRef, parseListing } from "@g1t/contracts/marketplace";

import type { ConnectedState } from "./connectors";

/** The Marketplace's pages, under `/<workspace>/-/marketplace`. */
export function marketplacePath(slug: string, page: "" | "extensions" | "integrations" | "requests" = ""): string {
  return `/${slug}/-/marketplace${page ? `/${page}` : ""}`;
}

/**
 * Who stands behind a listing: in a word, a sentence, and what a tier's
 * section says while nothing in it is listed (`none`, by kind).
 */
export const TIERS: Record<ListingTier, { label: string; about: string; none: Record<ListingKind, string> }> = {
  official: {
    label: "Official",
    about: "Built and supported by g1t.",
    none: { extension: "No official extensions match.", integration: "No official integrations match." },
  },
  verified: {
    label: "Verified",
    about: "From a reviewed publisher. Its code and the scopes it asks for are checked before it is listed.",
    none: { extension: "No verified publishers yet.", integration: "No verified publishers yet." },
  },
  community: {
    label: "Community",
    about: "From anyone. Its pages run sandboxed on the user-content domain, and its server code stays off until that sandbox is hardened.",
    none: { extension: "No community extensions yet.", integration: "No community integrations yet." },
  },
  internal: {
    label: "Internal",
    about: "Built by your own people and agents, and promoted for this workspace only.",
    none: { extension: "Nothing built in this workspace yet.", integration: "Nothing built in this workspace yet." },
  },
};

/**
 * Whether a listing can be added here, now: it can (`available`), the
 * workspace has it (`added`: connected, or installed), it is planned and
 * can't be added by anyone yet (`soon`), or this workspace or this g1t
 * lacks something it needs (`unavailable`, with why).
 */
export type Availability = "available" | "added" | "soon" | "unavailable";

export const AVAILABILITIES: readonly Availability[] = ["available", "added", "soon", "unavailable"];

/** Each availability in words, and the sentence its hint shows. */
export const AVAILABILITY: Record<Availability, { label: string; about: string }> = {
  available: { label: "Available", about: "Can be added now. Owners add it for everyone; anyone else can ask an owner." },
  added: { label: "Added", about: "This workspace has it." },
  soon: { label: "Soon", about: "Planned, not built yet. Nobody can add it until it is released." },
  unavailable: { label: "Not available here", about: "This workspace or this g1t lacks something it needs." },
};

/** What a workspace that has a listing calls it: an integration is connected, an extension installed. */
export function addedWord(kind: ListingKind): string {
  return kind === "integration" ? "Connected" : "Installed";
}

/** A filter's value: one tier or availability, or every one. */
export type ListingFilters = { tier: ListingTier | "all"; availability: Availability | "all" };

/** The filters a Marketplace page's address asks for (`?tier=verified&availability=soon`); anything unknown is All. */
export function readFilters(params: URLSearchParams): ListingFilters {
  const tier = params.get("tier");
  const availability = params.get("availability");
  return {
    tier: LISTING_TIERS.includes(tier as ListingTier) ? (tier as ListingTier) : "all",
    availability: AVAILABILITIES.includes(availability as Availability) ? (availability as Availability) : "all",
  };
}

/** Whether a listing passes the filters. */
export function passes(listing: { tier: ListingTier; availability: Availability }, filters: ListingFilters): boolean {
  return (filters.tier === "all" || listing.tier === filters.tier) && (filters.availability === "all" || listing.availability === filters.availability);
}

/** The tiers a page shows sections for under `filters`: every one, or the one asked for. */
export function tiersShown(filters: ListingFilters): readonly ListingTier[] {
  return filters.tier === "all" ? LISTING_TIERS : [filters.tier];
}

/** Whether `request` is `username`'s and still waiting. */
function openFor(request: InstallRequest, ref: string, username: string): boolean {
  return request.status === "open" && request.listing === ref && request.requested_by.toLowerCase() === username.toLowerCase();
}

/** Open requests for `ref`. */
function openCount(requests: InstallRequest[], ref: string): number {
  return requests.filter((request) => request.status === "open" && request.listing === ref).length;
}

/** An integration in the Marketplace, with who stands behind it and whether the workspace has it. */
export type IntegrationListing = {
  ref: string;
  view: ConnectorView;
  /** Who connects it: an owner, once for the workspace, or each person for themselves. */
  scope: ConnectorScope;
  /** Every connector is g1t's own (CONNECTOR_PUBLISHER). */
  tier: ListingTier;
  publisher: string;
  availability: Availability;
  /** Why it can't be connected here, when it can't. */
  why: string | null;
  /** How it is doing, when it is connected. */
  connected: ConnectedState | null;
  /** Where an owner connects it, or manages it once connected. */
  href: string | null;
  /** Its page in the Marketplace. */
  path: string;
  requested: boolean;
  waiting: number;
};

/** One connector as a listing in the workspace `slug`. */
function integrationListing(
  view: ConnectorView,
  scope: ConnectorScope,
  slug: string,
  connected: Record<string, ConnectedState> = {},
  unavailable: Record<string, string> = {},
  requests: InstallRequest[] = [],
  username = "",
): IntegrationListing {
  const ref = listingRef("integration", view.id);
  const state = scope === "workspace" ? (connected[view.id] ?? null) : null;
  const why = view.status === "available" && !state ? (unavailable[view.id] ?? null) : null;
  const availability: Availability = state ? "added" : view.status !== "available" ? "soon" : why ? "unavailable" : "available";
  const setup = view.href && !why ? connectorPath(view.href, slug) : null;
  return {
    ref,
    view,
    scope,
    tier: CONNECTOR_PUBLISHER.tier,
    publisher: CONNECTOR_PUBLISHER.name,
    availability,
    why,
    connected: state,
    href: state?.manage ?? setup,
    path: integrationPath(slug, view.id),
    requested: requests.some((request) => openFor(request, ref, username)),
    waiting: openCount(requests, ref),
  };
}

/**
 * The integrations a workspace can connect today, connected ones first,
 * each in catalog order. `connected` comes from the integrations service
 * and the GitHub App (lib/connected.server.ts), as does `unavailable`:
 * connectors this g1t can't connect, with why.
 */
export function integrationListings(
  views: ConnectorView[],
  connected: Record<string, ConnectedState>,
  requests: InstallRequest[],
  username: string,
  slug: string,
  unavailable: Record<string, string> = {},
): IntegrationListing[] {
  const listings = views.filter((view) => view.status === "available").map((view) => integrationListing(view, "workspace", slug, connected, unavailable, requests, username));
  return [...listings.filter((l) => l.connected), ...listings.filter((l) => !l.connected)];
}

/** What each person connects for themselves, available today, as listings. */
export function personalListings(views: ConnectorView[], slug: string, unavailable: Record<string, string> = {}): IntegrationListing[] {
  return views.filter((view) => view.status === "available" && view.href != null).map((view) => integrationListing(view, "personal", slug, {}, unavailable));
}

/** The coming integrations (comingIntegrations), as listings: Soon, with nothing to press. */
export function comingListings(views: ConnectorView[], personal: ConnectorView[], slug: string): IntegrationListing[] {
  const workspace = new Set(views.map((view) => view.id));
  return comingIntegrations(views, personal).map((view) => integrationListing(view, workspace.has(view.id) ? "workspace" : "personal", slug));
}

/** One integration's page in the Marketplace. */
export function integrationPath(slug: string, id: string): string {
  return `/${slug}/-/marketplace/integrations/${id}`;
}

/** One way an integration is connected, and what it does there. */
export type IntegrationUse = {
  scope: ConnectorScope;
  /** Who connects it this way, in words. */
  who: string;
  description: string;
  capabilities: ConnectorCapability[];
};

/**
 * What an integration does, today and soon: each way it is connected (for
 * the workspace, for each person) under whether that way is available yet,
 * from the catalog. Linear, say, works for a workspace today, and for each
 * person's own inbox soon.
 */
export function integrationUses(connector: Connector): { today: IntegrationUse[]; soon: IntegrationUse[] } {
  const today: IntegrationUse[] = [];
  const soon: IntegrationUse[] = [];
  for (const scope of connector.scopes) {
    const view = connectorView(connector, scope);
    if (!view) continue;
    const use = {
      scope,
      who: scope === "workspace" ? "For the whole workspace, connected once by an owner" : "For each person, with their own account",
      description: view.description,
      capabilities: view.capabilities,
    };
    (view.status === "available" ? today : soon).push(use);
  }
  return { today, soon };
}

/** A connector category's title: `issues` is `Issues & projects`. */
export function categoryTitle(category: Connector["category"]): string {
  return CONNECTOR_CATEGORIES.find((c) => c.id === category)?.title ?? category;
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

/** An extension in the Marketplace, with who stands behind it and whether the workspace has it. */
export type ExtensionListing = {
  ref: string;
  manifest: ExtensionManifest;
  /** Its publisher's tier. */
  tier: ListingTier;
  availability: Availability;
  install: ExtensionInstall | null;
  requested: boolean;
  waiting: number;
};

/** Where extensions are grouped: connected systems apart from the rest. */
export const CONNECTED_SYSTEMS = "Connected systems";

/** Whether an extension bridges a system the team already runs. */
export function isConnectedSystem(manifest: Pick<ExtensionManifest, "category">): boolean {
  return manifest.category === CONNECTED_SYSTEMS;
}

/**
 * A starting set of extensions for one kind of team, installed together
 * once each is published. Ids are first-party extensions'.
 */
export type StarterKit = { id: string; name: string; about: string; extensions: string[] };

export const STARTER_KITS: StarterKit[] = [
  { id: "customers", name: "Customer team", about: "Mail on your domain, support conversations and a pipeline.", extensions: ["mail", "support", "crm"] },
  { id: "engineering", name: "Engineering extras", about: "On-call rotations, and the helpdesk your customers already write to.", extensions: ["on-call", "helpdesk-bridge"] },
  { id: "operations", name: "People and operations", about: "Hiring, and the orders and invoices in your ERP.", extensions: ["recruiting", "erp-bridge"] },
];

/** Every extension listed, published ones first, each with its install. */
export function extensionListings(manifests: ExtensionManifest[], installs: ExtensionInstall[], requests: InstallRequest[], username: string): ExtensionListing[] {
  const listings = manifests.map((manifest) => {
    const ref = listingRef("extension", manifest.id);
    const install = installs.find((install) => install.listing === ref) ?? null;
    return {
      ref,
      manifest,
      tier: manifest.publisher.tier,
      availability: (install ? "added" : manifest.status === "available" ? "available" : "soon") as Availability,
      install,
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

/** Where an owner goes to add what a request asks for: the extension's page, or the integration's setup page. */
export function addPath(request: Pick<InstallRequest, "listing">, slug: string, views: ConnectorView[]): string | null {
  const parsed = parseListing(request.listing);
  if (!parsed) return null;
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
