/**
 * What product analytics may learn from a page, decided before an event
 * leaves the browser (lib/analytics.client.ts).
 *
 * The public front door (the home page, pricing, Explore, signing up and
 * in, support, security and the policies) is sent as it is. Everywhere else, names are replaced
 * with placeholders: `/acme/web/pull/12` is sent as
 * `/:name/:name/pull/:n`, the page title as "g1t", and a clicked element
 * without its text, link or attributes. Query strings keep only `utm_*`.
 * Session recordings and error reports are never sent, and click heatmaps
 * only from the front door. No Workers or browser imports, so it is tested
 * under Node.
 */

/** Paths sent as they are. */
const PUBLIC = new Set([
  "/",
  "/pricing",
  "/explore",
  "/register",
  "/login",
  "/security",
  "/support",
  "/status",
  "/policies",
]);

/**
 * Words of g1t's own addresses, kept in a scrubbed path so it still says
 * which kind of page it was. Anything else is a name, and is replaced.
 */
const ROUTE_WORDS = new Set([
  "-", "about.json", "account", "actions", "activity", "agents", "applications", "archive", "audit", "billing",
  "blob", "branches", "browse", "bypass-requests", "chat", "checks", "code", "code-access", "commit", "commits",
  "compare", "confirm-email", "context", "deployments", "dm", "docs", "emails", "emoji", "entries", "explore", "files", "forgot", "gateway",
  "github", "guardrails", "home", "inbox", "insights", "integrations", "invitations", "invite", "invites", "issues",
  "jobs", "keys", "labels", "login", "members", "memory", "merge-queue", "milestones", "new", "notifications", "overview",
  "packages", "patterns", "people", "personal-access-tokens", "pins", "policies", "profile", "projects", "pull",
  "pulls", "queue", "releases", "repositories", "reset", "rules", "runners", "runs", "search", "secrets", "security",
  "security-log", "settings", "soon", "spend", "tags", "teams", "tokens", "tree", "two-factor", "u", "usage",
  "verify", "webhooks", "workspace", "workspaces",
]);

export function isPublicPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return PUBLIC.has(path) || path.startsWith("/policies/");
}

/** A path as analytics may see it. */
export function scrubPath(pathname: string): string {
  if (isPublicPath(pathname)) return pathname;
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "" || ROUTE_WORDS.has(segment)) return segment;
      return /^\d+$/.test(segment) ? ":n" : ":name";
    })
    .join("/");
}

/** Only campaign parameters survive; everything else in a query can name something. */
function scrubSearch(search: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const [key, value] of search) if (key.startsWith("utm_")) kept.append(key, value);
  const query = kept.toString();
  return query ? `?${query}` : "";
}

/** A URL on this site as analytics may see it; another site's is left alone. */
export function scrubUrl(value: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.origin !== origin) return value;
  return `${url.origin}${scrubPath(url.pathname)}${scrubSearch(url.searchParams)}`;
}

/** Element text, links and attributes in autocapture's chain string. */
const CHAIN_DETAIL = /(?:text|href|attr__[\w-]+)="(?:[^"\\]|\\.)*"/g;

function scrubValue(key: string, value: unknown, origin: string, publicPage: boolean): unknown {
  if (typeof value === "string") {
    if (!publicPage && (key === "$title" || key === "title")) return "g1t";
    if (!publicPage && key === "$el_text") return undefined;
    if (!publicPage && key === "$elements_chain") return value.replace(CHAIN_DETAIL, "");
    if (/pathname$/i.test(key) && value.startsWith("/")) return scrubPath(value);
    return value.startsWith(origin) ? scrubUrl(value, origin) : value;
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(key, item, origin, publicPage));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [inner, innerValue] of Object.entries(value)) {
      if (!publicPage && (inner === "$el_text" || inner === "href" || inner.startsWith("attr__"))) continue;
      const scrubbed = scrubValue(inner, innerValue, origin, publicPage);
      // Some objects are keyed by address, such as a heatmap's pages.
      if (scrubbed !== undefined) out[inner.startsWith(origin) ? scrubUrl(inner, origin) : inner] = scrubbed;
    }
    return out;
  }
  return value;
}

/** Events that are never sent: session recordings and error reports, which carry page content. */
const NEVER = new Set(["$snapshot", "$snapshot_items", "$exception"]);

export type CapturedEvent = { event: string; properties: Record<string, unknown>; [key: string]: unknown };

/**
 * The event as analytics may see it, or null to drop it. `pathname` is the
 * page the event happened on; `origin` is this site's.
 */
export function scrubEvent<T extends CapturedEvent>(event: T | null, pathname: string, origin: string): T | null {
  if (!event || NEVER.has(event.event)) return null;
  const publicPage = isPublicPath(pathname);
  // A heatmap is keyed by the page's address, and holds where on it people clicked.
  if (event.event === "$$heatmap" && !publicPage) return null;
  const properties = scrubValue("", event.properties ?? {}, origin, publicPage) as Record<string, unknown>;
  return { ...event, properties };
}
