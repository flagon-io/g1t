/**
 * The checks behind /status and the footer's dot. Each is one cheap call,
 * the same a visitor's request would make, with a short timeout, all at
 * once. The report is kept in the data centre's cache for a minute, so
 * however many people look, each part is checked at most once a minute
 * per data centre.
 *
 * The public hosts (api, mcp, docs, models, g1t.page) are fetched over the
 * internet, as their users reach them; the rest through service bindings.
 */
import { billing, identity, repos } from "./services.server";
import { type ComponentKey, type ProbeResult, type StatusReport, report } from "./status";

/** No check waits longer than this. */
const TIMEOUT_MS = 3000;
/** How long one report is served before the parts are checked again. */
const CACHE_SECONDS = 60;
/** Where the report is kept: a key in the cache, never a page anyone fetches. */
const CACHE_KEY = "https://g1t.sh/__status/report/v1";
/** A public repository that has always existed, to look up. */
const PROBE_REPO = { namespace: "flagon-io", name: "g1t" };
/** A session token that cannot exist: the lookup answers "nobody". */
const NO_SESSION = "0".repeat(64);

class Timeout extends Error {}

async function timed(run: (signal: AbortSignal) => Promise<boolean | string>): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Timeout());
    }, TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([run(controller.signal), deadline]);
    const ms = Date.now() - started;
    return outcome === true ? { ok: true, ms } : { ok: false, ms, error: typeof outcome === "string" ? outcome : "unexpected answer" };
  } catch (error) {
    const ms = Date.now() - started;
    return { ok: false, ms, error: error instanceof Timeout ? "timed out" : "could not connect" };
  } finally {
    clearTimeout(timer);
  }
}

/** A public address answering 2xx. The body is not read. */
function reachable(url: string, headers: Record<string, string> = {}) {
  return timed(async (signal) => {
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { "user-agent": "g1t-status (+https://g1t.sh/status)", ...headers },
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok || `HTTP ${response.status}`;
  });
}

async function probeAll(): Promise<Partial<Record<ComponentKey, ProbeResult | null>>> {
  const checks: [ComponentKey, Promise<ProbeResult> | null][] = [
    // Every page asks identity who is signed in; a token nobody holds
    // answers "nobody" after a database read.
    ["site", timed(async () => (await identity.userForSession(NO_SESSION), true))],
    ["api", reachable("https://api.g1t.sh/")],
    // A lookup answers, found or not, once the repository service and its
    // database are up.
    ["git", timed(async () => (await repos.get(PROBE_REPO, null), true))],
    ["mcp", reachable("https://mcp.g1t.sh/", { accept: "application/json" })],
    ["docs", reachable("https://docs.g1t.sh/")],
    ["deployments", reachable("https://g1t.page/")],
    ["agents", reachable("https://models.g1t.sh/")],
    // Not checked yet: see COMPONENTS in status.ts.
    ["sandboxes", null],
    ["billing", timed(async () => Boolean(await billing.prices()) || "no price book")],
  ];
  const results = await Promise.all(checks.map(async ([key, check]) => [key, check ? await check : null] as const));
  return Object.fromEntries(results);
}

function edgeCache(): Cache | null {
  // The Workers runtime's own cache, which the DOM types do not know.
  const store = (globalThis as { caches?: { default?: Cache } }).caches;
  return store?.default ?? null;
}

/** The current report: from the cache when it is under a minute old, else checked now. */
export async function currentStatus(): Promise<StatusReport> {
  const cache = edgeCache();
  if (cache) {
    try {
      const hit = await cache.match(CACHE_KEY);
      if (hit) return (await hit.json()) as StatusReport;
    } catch {
      // A cache that fails is only slower.
    }
  }
  const fresh = report(await probeAll(), new Date());
  if (cache) {
    try {
      await cache.put(
        CACHE_KEY,
        Response.json(fresh, { headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` } }),
      );
    } catch {
      // Checked again next time.
    }
  }
  return fresh;
}

/** Headers for a response carrying the report: browsers and the edge may keep it a minute. */
export const STATUS_HEADERS = { "cache-control": `public, max-age=${CACHE_SECONDS}` };
