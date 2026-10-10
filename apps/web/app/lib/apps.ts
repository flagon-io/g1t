/**
 * The apps a workspace has, and the ones each person pins to their dock.
 *
 * Built-in apps (Today, Chat, Notifications, Agents, Code, Artifacts,
 * People and Workspace) are always in the dock. Every other app is a page
 * of the workspace that people use on its own: Projects, Packages,
 * Security, Context, Memory, Teams, Usage, the AI Gateway, Integrations
 * and the audit log. Each person pins the ones they want, and nobody sees
 * an app they cannot use: Code's apps are for members with Code access.
 *
 * Pins are each person's own, per workspace, in the order they set, and
 * kept with their account by the identity service (`dock_pins`), so the
 * dock is the same on every device (lib/dock.server.ts). A cookie
 * (`g1t_dock`) keeps a copy on each device: the dock still draws from it
 * when identity cannot be reached, and pins from before they were kept
 * with the account carry over from it until the first change.
 * No Workers or React imports, so it can be tested under Node.
 */

/** The apps that are always in the dock. */
export type BuiltinApp = "today" | "chat" | "notifications" | "agents" | "code" | "artifacts" | "people" | "workspace";

/** The apps people pin. */
export type PinnableApp =
  | "projects"
  | "packages"
  | "security"
  | "context"
  | "memory"
  | "teams"
  | "usage"
  | "gateway"
  | "integrations"
  | "audit";

export type AppKey = BuiltinApp | PinnableApp;

export type AppInfo = {
  key: AppKey;
  name: string;
  /** What it is, in a few words, for the Apps page. */
  about: string;
  /** Its page in the workspace `slug`. */
  path: (slug: string) => string;
  /** Always in the dock: it cannot be pinned or unpinned. */
  builtin: boolean;
  /** Part of Code: only for members with Code access. */
  code?: boolean;
};

const under = (page: string) => (slug: string) => `/${slug}/-/${page}`;

/** Every app, built-in first, in the order the launcher shows them. */
export const APPS: AppInfo[] = [
  { key: "today", name: "Today", about: "What needs you, across the workspace", path: under("today"), builtin: true },
  { key: "chat", name: "Chat", about: "Channels and messages with people and agents", path: under("chat"), builtin: true },
  { key: "notifications", name: "Notifications", about: "Reviews, mentions and what agents wait on", path: () => "/notifications", builtin: true },
  { key: "agents", name: "Agents", about: "Your workspace's agents and their sessions", path: under("agents"), builtin: true },
  { key: "code", name: "Code", about: "Projects, pull requests and checks", path: under("overview"), builtin: true, code: true },
  { key: "artifacts", name: "Artifacts", about: "Documents, decks and pages", path: under("artifacts"), builtin: true },
  { key: "people", name: "People", about: "Who belongs to the workspace", path: under("people"), builtin: true },
  { key: "workspace", name: "Workspace", about: "Billing, policies and settings", path: under("workspace"), builtin: true },
  { key: "projects", name: "Projects", about: "Every project in the workspace", path: under("projects"), builtin: false, code: true },
  { key: "packages", name: "Packages", about: "Packages published from its projects", path: under("packages"), builtin: false, code: true },
  { key: "security", name: "Security", about: "Alerts across its projects", path: under("security"), builtin: false, code: true },
  { key: "context", name: "Context", about: "What agents can look up", path: under("context"), builtin: false, code: true },
  { key: "memory", name: "Memory", about: "What agents remember about the workspace", path: under("memory"), builtin: false, code: true },
  { key: "teams", name: "Teams", about: "Groups of people to mention and grant access", path: under("teams"), builtin: false },
  { key: "usage", name: "Usage", about: "What the workspace has used this month", path: under("usage"), builtin: false },
  { key: "gateway", name: "AI Gateway", about: "Every model request, with its cost", path: under("gateway"), builtin: false },
  { key: "integrations", name: "Integrations", about: "Model providers, alerts and trackers", path: under("integrations"), builtin: false },
  { key: "audit", name: "Audit log", about: "Who did what, and when", path: under("audit"), builtin: false },
];

const PINNABLE = new Set<string>(APPS.filter((app) => !app.builtin).map((app) => app.key));

/** Whether `key` is an app people pin. */
export function isPinnable(key: string): key is PinnableApp {
  return PINNABLE.has(key);
}

/** The apps someone can use in a workspace: Code's only with Code access. */
export function appsFor(code: boolean): AppInfo[] {
  return APPS.filter((app) => code || !app.code);
}

/** The app `key`. */
export function appOf(key: AppKey): AppInfo {
  return APPS.find((app) => app.key === key)!;
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

/** The Set-Cookie header that keeps the dock, for a year. */
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
