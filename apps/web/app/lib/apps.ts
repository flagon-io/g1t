/**
 * The rail's built-in apps, the apps a workspace installed from the
 * Marketplace, and the ones each person pins to their rail.
 *
 * Built-in apps (Home, Chat, Notifications, Agents, Code, Artifacts,
 * People and Workspace) are always in the rail; their own pages (Projects,
 * Usage, Teams and the rest) are in their sidebars. Apps are what the
 * workspace added from the Marketplace: today, the integrations it
 * connected, each opening its page. Each person pins the ones they want.
 *
 * An installed app's key says what it is: `int-<connector>` for an
 * integration (@g1t/contracts/connectors), and later `ext-<extension>`.
 * A key that names nothing installable (a built-in page pinned before
 * Apps were the Marketplace's) is dropped wherever pins are read.
 *
 * Pins are each person's own, per workspace, in the order they set, and
 * kept with their account by the identity service (`dock_pins`), so the
 * dock is the same on every device (lib/dock.server.ts). A cookie
 * (`g1t_dock`) keeps a copy on each device: the rail still draws from it
 * when identity cannot be reached, and pins from before they were kept
 * with the account carry over from it until the first change.
 * No Workers or React imports, so it can be tested under Node.
 */
import type { ExtensionInstall, ListingTier } from "@g1t/contracts";
import { CONNECTORS, type Connector, connectorPath } from "@g1t/contracts/connectors";
import { CONNECTOR_PUBLISHER, extensionById } from "@g1t/contracts/marketplace";

/** The apps that are always in the rail. */
export type BuiltinApp = "home" | "chat" | "notifications" | "agents" | "code" | "artifacts" | "people" | "workspace";

export type BuiltinInfo = {
  key: BuiltinApp;
  name: string;
  /** Its page in the workspace `slug`. */
  path: (slug: string) => string;
  /** Part of Code: only for members with Code access. */
  code?: boolean;
};

const under = (page: string) => (slug: string) => `/${slug}/-/${page}`;

/** The rail's built-in apps, in its order. */
export const BUILTINS: BuiltinInfo[] = [
  { key: "home", name: "Home", path: under("home") },
  { key: "chat", name: "Chat", path: under("chat") },
  { key: "notifications", name: "Notifications", path: () => "/notifications" },
  { key: "agents", name: "Agents", path: under("agents") },
  { key: "code", name: "Code", path: under("overview"), code: true },
  { key: "artifacts", name: "Artifacts", path: under("artifacts") },
  { key: "people", name: "People", path: under("people") },
  { key: "workspace", name: "Workspace", path: under("workspace") },
];

/** The built-in app `key`. */
export function appOf(key: BuiltinApp): BuiltinInfo {
  return BUILTINS.find((app) => app.key === key)!;
}

/** An installed app's key, as pins and forms carry it: `int-sentry`. */
export type PinnableApp = string;

/** An app installed from the Marketplace. */
export type InstalledApp = {
  key: PinnableApp;
  name: string;
  /** What it is, in a few words. */
  about: string;
  /** The Marketplace listing it was installed from: `integration:sentry`. */
  listing: string;
  /** Who stands behind it, as its Marketplace listing says: its publisher and tier. */
  publisher: string;
  tier: ListingTier;
  /** The connector behind it, for its mark. */
  connector: Pick<Connector, "id" | "name" | "provider">;
  /** Its page in the workspace `slug`. */
  path: (slug: string) => string;
  /**
   * Whether the person can open it. Every member can open an integration's
   * page; an app limited to some people shows Request access to the rest.
   */
  usable: boolean;
};

/** Where an integration is looked after: its setup page, by kind, or its own page. */
const SECTION_BY_CATEGORY: Partial<Record<Connector["category"], string>> = { ai: "models", monitoring: "alerts", issues: "trackers" };

function integrationPath(connector: Connector): (slug: string) => string {
  const section = connector.provider ? SECTION_BY_CATEGORY[connector.category] : undefined;
  if (section) return under(`integrations/${section}`);
  const href = connector.href?.workspace;
  return href ? (slug) => connectorPath(href, slug) : under("integrations");
}

/** Identity keeps keys of at most this many characters (MAX_DOCK_APP_KEY). */
const MAX_KEY = 32;

/** The installed-app key for an integration: `int-sentry`. */
export function integrationAppKey(connectorId: string): PinnableApp {
  return `int-${connectorId}`;
}

/**
 * The app a key names, from the catalog alone (no service is asked), or
 * null when it names nothing that can be installed: a retired key, a
 * built-in page, or a connector that is not available for a workspace.
 */
export function installedAppOf(key: string): InstalledApp | null {
  if (key.length > MAX_KEY) return null;
  if (/^ext-[a-z][a-z0-9-]*$/.test(key)) {
    const extension = extensionById(key.slice(4));
    if (!extension || extension.status !== "available") return null;
    return {
      key,
      name: extension.name,
      about: extension.tagline,
      listing: `extension:${extension.id}`,
      publisher: extension.publisher.name,
      tier: extension.publisher.tier,
      connector: { id: extension.id, name: extension.name, provider: undefined },
      // Its own page, in a sandboxed frame, is the extension host's to serve; until then, its listing.
      path: (slug) => `/${slug}/-/marketplace/extensions/${extension.id}`,
      usable: true,
    };
  }
  if (!/^int-[a-z0-9][a-z0-9-]*$/.test(key)) return null;
  const connector = CONNECTORS.find((c) => c.id === key.slice(4));
  if (!connector || connector.status !== "available" || !connector.scopes.includes("workspace")) return null;
  return {
    key,
    name: connector.name,
    about: connector.description,
    listing: `integration:${connector.id}`,
    publisher: CONNECTOR_PUBLISHER.name,
    tier: CONNECTOR_PUBLISHER.tier,
    connector: { id: connector.id, name: connector.name, provider: connector.provider },
    path: integrationPath(connector),
    usable: true,
  };
}

/** Whether `key` names an app that can be pinned. */
export function isPinnable(key: string): key is PinnableApp {
  return installedAppOf(key) != null;
}

/**
 * The apps the workspace installed, from what it has connected (by
 * connector id, lib/connected.server.ts), in catalog order. `manage`, when
 * a connection has one, is where its app opens.
 */
export function installedApps(
  connected: Record<string, { manage: string | null }>,
  installs: readonly Pick<ExtensionInstall, "listing" | "enabled">[] = [],
): InstalledApp[] {
  const integrations = CONNECTORS.filter((connector) => connected[connector.id]).map((connector) => {
    const app = installedAppOf(integrationAppKey(connector.id));
    const manage = connected[connector.id]?.manage;
    return app && manage ? { ...app, path: () => manage } : app;
  });
  // Extensions switched off (the kill switch) aren't apps until they're on again.
  const extensions = installs.filter((install) => install.enabled).map((install) => installedAppOf(`ext-${install.listing.replace(/^extension:/, "")}`));
  return [...extensions, ...integrations].filter((app): app is InstalledApp => app != null);
}

/** An app as a loader sends it: everything but its path, which is worked out for the workspace. */
export type InstalledAppData = Omit<InstalledApp, "path"> & { href: string };

export function appData(app: InstalledApp, slug: string): InstalledAppData {
  const { path, ...rest } = app;
  return { ...rest, href: path(slug) };
}

/** The cookie that keeps this device's copy of each person's pins, per workspace. */
export const DOCK_COOKIE = "g1t_dock";

/**
 * Most workspaces the cookie remembers pins for, and most pins in each.
 * Identity keeps up to 24 (`MAX_DOCK_PINS`); this stays under it.
 */
const MAX_WORKSPACES = 20;
export const MAX_APP_PINS = 12;

/**
 * Pins as identity keeps them, read against the apps there are: keys that
 * are not an app people pin (one since retired, say) are dropped, repeats
 * too, in the order they were set.
 */
export function pinsFrom(keys: readonly string[]): PinnableApp[] {
  return [...new Set(keys.filter(isPinnable))].slice(0, MAX_APP_PINS);
}

/**
 * The pins to draw in the workspace `slug`: the account's when identity
 * has them (`stored`), else this device's cookie, for pins never saved to
 * the account or when identity could not be asked.
 */
export function pinsToShow(stored: readonly string[] | null | undefined, cookie: string | null | undefined, slug: string): PinnableApp[] {
  return stored ? pinsFrom(stored) : pinsIn(cookie, slug);
}

/** Every workspace's pins, from the cookie's value: `acme:projects.usage,beta:teams`. */
export function readDock(value: string | null | undefined): Record<string, PinnableApp[]> {
  const dock: Record<string, PinnableApp[]> = {};
  for (const entry of (value ?? "").split(",")) {
    const [slug, keys] = entry.split(":");
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || keys === undefined) continue;
    const pins = [...new Set(keys.split(".").filter(isPinnable))].slice(0, MAX_APP_PINS);
    dock[slug] = pins;
  }
  return dock;
}

/** The pins in the workspace `slug`, in the order they were pinned. */
export function pinsIn(value: string | null | undefined, slug: string): PinnableApp[] {
  return readDock(value)[slug.toLowerCase()] ?? [];
}

/** The cookie's value with the workspace `slug`'s pins set to `pins`: the latest workspace first. */
export function writeDock(value: string | null | undefined, slug: string, pins: PinnableApp[]): string {
  const dock = readDock(value);
  const key = slug.toLowerCase();
  delete dock[key];
  const entries = [[key, [...new Set(pins.filter(isPinnable))].slice(0, MAX_APP_PINS)] as const, ...Object.entries(dock)].slice(0, MAX_WORKSPACES);
  return entries.map(([name, keys]) => `${name}:${keys.join(".")}`).join(",");
}

/** One change to someone's pins, as the pin buttons post it; null when it asks for nothing that makes sense. */
export function appPinFromForm(form: FormData): { app: PinnableApp; pinned: boolean } | null {
  const app = String(form.get("app") ?? "");
  const intent = form.get("intent");
  if (!isPinnable(app) || (intent !== "pin" && intent !== "unpin")) return null;
  return { app, pinned: intent === "pin" };
}

/** The pins after pinning or unpinning `app`: a new pin goes at the end. */
export function withPin(pins: PinnableApp[], app: PinnableApp, pinned: boolean): PinnableApp[] {
  const rest = pins.filter((key) => key !== app);
  return pinned ? [...rest, app] : rest;
}

/** The Set-Cookie header that keeps the rail, for a year. */
export function dockCookie(value: string, secure: boolean): string {
  return `${DOCK_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The cookie that remembers whether the in-context sidebar is folded away on a computer. */
export const SIDEBAR_COOKIE = "g1t_sidebar";

/** Whether the sidebar is folded away, from the cookie's value. */
export function sidebarClosed(value: string | null | undefined): boolean {
  return value === "closed";
}

/** The cookie, as the page sets it when the sidebar is folded away or brought back. */
export function sidebarCookie(closed: boolean, secure: boolean): string {
  return `${SIDEBAR_COOKIE}=${closed ? "closed" : "open"}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
