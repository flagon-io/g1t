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
import type { ExtensionInstall, ExtensionManifest, InstallRequest, InstallRequestStatus, ListingTier } from "@g1t/contracts";
import { type ConnectorView, connectorPath } from "@g1t/contracts/connectors";
import { listingRef, parseListing } from "@g1t/contracts/marketplace";

import type { ConnectedState } from "./connectors";

/** The Marketplace's pages, under `/<workspace>/-/marketplace`. */
export function marketplacePath(slug: string, page: "" | "extensions" | "integrations" | "requests" = ""): string {
  return `/${slug}/-/marketplace${page ? `/${page}` : ""}`;
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
