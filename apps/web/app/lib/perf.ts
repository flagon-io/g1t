/**
 * The pure parts of request timing and D1 read consistency for the site:
 * the `g1t_d1` cookie, which session each service call asks for, which
 * calls may write, and the `Server-Timing` header. perf.server.ts holds
 * the per-request state; docs/PERFORMANCE.md explains the whole.
 */

/** The cookie that carries D1 bookmarks between a person's requests. */
export const D1_COOKIE = "g1t_d1";

/**
 * How long after a write the services a request did not get a bookmark
 * from read their primary. A write can reach a service the site did not
 * call itself (work writing to repos, say), whose bookmark the site never
 * sees; D1 replicas trail the primary by well under a second, so 30
 * seconds covers that with room to spare.
 */
export const PRIMARY_WINDOW_SECONDS = 30;

/** How long the bookmarks are kept: far longer than any replica trails. */
export const D1_COOKIE_MAX_AGE = 300;

/**
 * The services whose RPCs open a D1 session (crates/kit/src/d1.rs and
 * @g1t/contracts d1.ts), by the name the site gives their binding.
 */
export const SESSION_SERVICES = new Set(["identity", "repos", "work", "search", "billing", "projects", "deployments"]);

/** What the site remembers from a person's last writes. */
export type Bookmarks = {
  /** Unix seconds of the last request that may have written, if recent. */
  at: number | null;
  /** The latest bookmark each service returned after it. */
  services: Record<string, string>;
};

const BOOKMARK = /^[0-9A-Za-z-]{1,256}$/;
const SERVICE = /^[a-z]{1,32}$/;

/** Reads the `g1t_d1` cookie; anything malformed is dropped. */
export function readBookmarks(cookieHeader: string | null): Bookmarks {
  const empty: Bookmarks = { at: null, services: {} };
  if (!cookieHeader) return empty;
  const match = new RegExp(`(?:^|;\\s*)${D1_COOKIE}=([^;]*)`).exec(cookieHeader);
  if (!match) return empty;
  const found: Bookmarks = { at: null, services: {} };
  for (const entry of match[1].split("~")) {
    const colon = entry.indexOf(":");
    if (colon < 1) continue;
    const key = entry.slice(0, colon);
    const value = entry.slice(colon + 1);
    if (key === "at") {
      const at = Number(value);
      if (Number.isSafeInteger(at) && at > 0) found.at = at;
    } else if (SERVICE.test(key) && SESSION_SERVICES.has(key) && BOOKMARK.test(value)) {
      found.services[key] = value;
    }
  }
  return found;
}

/** The `g1t_d1` cookie's value. */
export function writeBookmarks(bookmarks: Bookmarks): string {
  const entries = bookmarks.at ? [`at:${bookmarks.at}`] : [];
  for (const [service, bookmark] of Object.entries(bookmarks.services).sort()) {
    if (SESSION_SERVICES.has(service) && BOOKMARK.test(bookmark)) entries.push(`${service}:${bookmark}`);
  }
  return entries.join("~");
}

/** The `Set-Cookie` value for `bookmarks`. */
export function bookmarkCookie(bookmarks: Bookmarks, secure: boolean): string {
  return `${D1_COOKIE}=${writeBookmarks(bookmarks)}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${D1_COOKIE_MAX_AGE}`;
}

/**
 * What a call to `service` sends as `x-d1-bookmark`, or null for none
 * (that service reads its primary, as before sessions):
 *
 * - A request that writes (any method but GET and HEAD) starts every
 *   session on the primary, so what it checks before writing is current.
 * - Within `PRIMARY_WINDOW_SECONDS` of the person's last write, the
 *   primary, for every service: that write may have reached a service
 *   through another one, whose bookmark the site never saw.
 * - Otherwise the bookmark that service returned after that write: never
 *   older than what they did, however far a replica trails.
 * - Otherwise the nearest copy.
 */
export function sessionFor(service: string, bookmarks: Bookmarks, writing: boolean, nowSeconds: number): string | null {
  if (!SESSION_SERVICES.has(service)) return null;
  if (writing) return "first-primary";
  if (bookmarks.at && nowSeconds - bookmarks.at < PRIMARY_WINDOW_SECONDS) return "first-primary";
  return bookmarks.services[service] ?? "first-unconstrained";
}

/**
 * Methods that only read. Anything not listed is taken to write, so a new
 * method errs towards a cookie and a primary read, never a stale page.
 */
const READS = new Set(
  (
    "account active_agents all_ids blame blob branches by_author by_repo catalog check_invite check_limit " +
    "check_workspace_deletion check_workspace_rename collaborator_permission compare counts deleted deliveries " +
    "dependencies domains entitlements entity explore features git_access graph has_feature invoices ledger limit " +
    "limit_requests links log logs managed_pulls memories_by_id memory_context my_repo_invitations " +
    "outside_collaborators overview path_by_id prices profile profile_workspaces public_namespaces read_session " +
    "readable ready_issues references registration repo_access resolve resolve_branch resolve_path resolve_slug " +
    "routes run run_context run_cost runner_groups runner_settings runners runs scorecards search search_memories " +
    "settings statement statement_entries status status_by_id suggest tree usage usage_meters user_by_username " +
    "user_for_session usernames waiting_workspaces workflows workspace workspace_invites github_enabled"
  ).split(" "),
);

/** Whether an RPC to `method` may write. */
export function mayWrite(method: string): boolean {
  if (READS.has(method)) return false;
  return !(method.startsWith("get_") || method.startsWith("list_"));
}

/** The method name of an RPC URL (`https://service/rpc/<method>`). */
export function rpcMethodOf(input: string): string {
  const at = input.indexOf("/rpc/");
  return at < 0 ? "" : input.slice(at + 5).split(/[?#]/)[0];
}

/** One service's calls during a request. */
export type ServiceTiming = {
  calls: number;
  /** Summed wall time of its calls, from here. */
  wallMs: number;
  /** Summed time its own `server-timing: svc;dur` reported. */
  serviceMs: number;
};

/** The `svc;dur=N` a service reports, or null. */
export function serviceDuration(header: string | null): number | null {
  if (!header) return null;
  const match = /(?:^|,)\s*svc;dur=([0-9.]+)/.exec(header);
  return match ? Number(match[1]) : null;
}

/** Total time covered by overlapping [start, end] intervals. */
export function coveredMs(intervals: [number, number][]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  let start = -Infinity;
  for (const [from, to] of sorted) {
    if (from > end) {
      if (end > start) total += end - start;
      start = from;
      end = to;
    } else if (to > end) {
      end = to;
    }
  }
  if (end > start) total += end - start;
  return total;
}

/** A Server-Timing metric name: a token, so `/` and spaces become `.`. */
export function metricName(name: string): string {
  return name.replace(/^routes\//, "").replace(/[^A-Za-z0-9_.-]+/g, ".");
}

/**
 * The `Server-Timing` header for a request: the whole, the loaders, the
 * time spent waiting on services (overlap counted once), then each
 * service. DevTools shows them in this order under Network → Timing.
 */
export function serverTiming(input: {
  totalMs: number;
  loaders: { id: string; ms: number; kind: "loader" | "action" }[];
  rpcMs: number;
  services: Record<string, ServiceTiming>;
  sessions: string;
}): string {
  const parts = [`total;dur=${input.totalMs};desc="web to first byte"`];
  for (const loader of input.loaders) {
    parts.push(`${loader.kind}.${metricName(loader.id)};dur=${loader.ms}`);
  }
  const calls = Object.values(input.services).reduce((sum, timing) => sum + timing.calls, 0);
  if (calls > 0) parts.push(`rpc;dur=${input.rpcMs};desc="${calls} service calls, overlap counted once"`);
  const ranked = Object.entries(input.services).sort((a, b) => b[1].wallMs - a[1].wallMs);
  for (const [name, timing] of ranked) {
    const inside = timing.serviceMs > 0 ? `, ${timing.serviceMs}ms inside` : "";
    parts.push(`${metricName(name)};dur=${timing.wallMs};desc="${timing.calls} call${timing.calls === 1 ? "" : "s"}${inside}"`);
  }
  if (input.sessions) parts.push(`d1;desc="${input.sessions}"`);
  return parts.join(", ");
}
