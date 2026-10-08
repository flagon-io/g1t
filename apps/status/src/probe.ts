/**
 * Running a part's check: each request it makes, all at once, with a short
 * timeout. The answer's body is never read.
 */
import type { Check, Step } from "./components.ts";

/** A check's raw outcome. */
export type ProbeResult = {
  ok: boolean;
  /** How long it took, in milliseconds: the slowest of its requests. */
  ms: number;
  /** Why it failed, in a few words: "timed out", "HTTP 502". */
  error?: string;
  /** Why it worked but not well, when that is not just slowness. */
  degraded?: string;
  /**
   * The Cloudflare data centre that answered, from the `cf-ray` header's
   * suffix (`8c1f…-IAD`): where the check ran from, as far as g1t saw it.
   */
  colo?: string;
  /** Slow at first and checked again at once (`confirmSlow`): the first try's time. */
  first_ms?: number;
};

/** How one git store namespace answered lately: repos `store_health`. */
export type StoreHealthRow = {
  store: string;
  calls: number;
  errors: number;
  rate_limited: number;
  rejected: number;
  ms_total: number;
};

export type StorageReport = { minutes: number; stores: StoreHealthRow[] };

/** At least this many failed calls, and this share of them, before git storage is down. */
const STORAGE_MIN_ERRORS = 5;
const STORAGE_DOWN_SHARE = 0.25;

/**
 * What the git store's recent answers mean: down when a quarter or more of
 * its calls failed (at least five), or calls were refused after repeated
 * failures; degraded when it rate limited g1t; otherwise as fast as its
 * mean call. Quiet is up.
 */
export function judgeStorage(report: StorageReport): ProbeResult {
  const sum = (key: keyof Omit<StoreHealthRow, "store">) =>
    report.stores.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const calls = sum("calls");
  const errors = sum("errors");
  const limited = sum("rate_limited");
  const rejected = sum("rejected");
  const ms = calls > 0 ? sum("ms_total") / calls : 0;
  if (rejected > 0) return { ok: false, ms, error: `calls refused after repeated failures (${rejected})` };
  if (errors >= STORAGE_MIN_ERRORS && errors / Math.max(calls, 1) >= STORAGE_DOWN_SHARE) {
    return { ok: false, ms, error: `${Math.round((100 * errors) / calls)}% of calls failed` };
  }
  if (limited > 0) return { ok: true, ms, degraded: `Rate limited ${limited} times in ${report.minutes} minutes` };
  // A namespace served from the fallback store (`<namespace>@fallback`,
  // repos src/fallback.rs): reads work from the last backup, writes wait.
  const fallback = report.stores.filter((row) => row.store.endsWith("@fallback") && Number(row.calls) > 0);
  if (fallback.length > 0) {
    return { ok: true, ms, degraded: "Served from the backup store: reads work, pushes and merges wait" };
  }
  return { ok: true, ms };
}

/** No request waits longer than this. */
export const TIMEOUT_MS = 5000;

/** What every check but a page load says it is. */
export const USER_AGENT = "g1t-status (+https://status.g1t.sh)";

/**
 * What a page load (`Step.browser`) says it is: a browser's user agent with
 * `g1t-status/1.0 (+status.g1t.sh)` on the end, so it still says who it is.
 *
 * The site renders a page for a crawler in full before sending a byte (an
 * `isbot` match makes apps/web's entry.server.tsx wait for `allReady`),
 * and streams the shell first for a browser. USER_AGENT matches isbot (on
 * "http", and "status/"), so with it Page speed timed a crawler's full
 * render, while its budget is to the first byte. probe.test.ts checks this
 * one against the isbot the site uses. Keep the name after "Safari/537.36",
 * and keep "http" and "compatible;" out of it: isbot matches a URL, and
 * "status/" inside a "compatible" comment.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 g1t-status/1.0 (+status.g1t.sh)";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

class Timeout extends Error {}

/** Runs `work`, timing it, and failing it after `timeoutMs`. */
export async function timed(
  work: (signal: AbortSignal) => Promise<true | string>,
  timeoutMs = TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<ProbeResult> {
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Timeout());
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([work(controller.signal), deadline]);
    const ms = now() - started;
    return outcome === true ? { ok: true, ms } : { ok: false, ms, error: outcome };
  } catch (error) {
    const ms = now() - started;
    return { ok: false, ms, error: error instanceof Timeout ? "timed out" : "could not connect" };
  } finally {
    clearTimeout(timer);
  }
}

/** One request, answered with the status that means it works. */
export async function step(fetcher: Fetch, { url, headers = {}, expect, browser = false }: Step, timeoutMs = TIMEOUT_MS): Promise<ProbeResult> {
  let colo: string | null = null;
  const result = await timed(async (signal) => {
    const response = await fetcher(url, {
      signal,
      redirect: "manual",
      headers: { "user-agent": browser ? BROWSER_USER_AGENT : USER_AGENT, "cache-control": "no-cache", ...headers },
    });
    // Timed to the answer's headers: the body is never read.
    colo = coloOf(response.headers.get("cf-ray"));
    await response.body?.cancel().catch(() => undefined);
    const good = expect == null ? response.ok : response.status === expect;
    return good || `HTTP ${response.status}`;
  }, timeoutMs);
  return colo ? { ...result, colo } : result;
}

/** The data centre in a `cf-ray` header: `8c1f2e3d4a5b6c7d-IAD` is `IAD`. */
export function coloOf(ray: string | null | undefined): string | null {
  const m = /-([A-Za-z]{3,4})$/.exec((ray ?? "").trim());
  return m ? m[1]!.toUpperCase() : null;
}

/** A check's requests together: it works when every one does, and takes as long as the slowest. */
export function combine(results: ProbeResult[]): ProbeResult {
  const ms = Math.max(0, ...results.map((r) => r.ms));
  const failed = results.find((r) => !r.ok);
  const colo = results.find((r) => r.colo)?.colo;
  const out: ProbeResult = failed ? { ok: false, ms, error: failed.error ?? "no answer" } : { ok: true, ms };
  return colo ? { ...out, colo } : out;
}

/** Whether a result is only slow: it worked, with nothing else wrong, but over `slowMs`. */
export function onlySlow(result: ProbeResult | null, slowMs: number): boolean {
  return result != null && result.ok && !result.degraded && Math.round(result.ms) > slowMs;
}

/**
 * A slow check, and the same check run again at once: the better of the
 * two. One slow answer (a cold isolate, a cache refill, a busy moment on
 * the path) does not count when the next answers in time; slow twice is
 * slow, at the faster of the two times. A second try that failed does not
 * make a slow check worse. `first_ms` keeps the first try's time.
 */
export function confirmSlow(first: ProbeResult, again: ProbeResult | null): ProbeResult {
  if (!again || !again.ok || again.degraded) return { ...first, first_ms: first.ms };
  const better = again.ms < first.ms ? again : first;
  const colo = better.colo ?? first.colo ?? again.colo;
  return { ...better, ...(colo ? { colo } : {}), first_ms: first.ms };
}

/** What runs a check. `billing` is null when there is no binding to it. */
export type Probers = {
  fetch: Fetch;
  billing: (() => Promise<unknown>) | null;
  /** Git storage's recent health, through the repos service; null when not bound. */
  storage?: (() => Promise<StorageReport>) | null;
  timeoutMs?: number;
};

/** Runs one part's check. Null for a part with no check. */
export async function runCheck(check: Check, probers: Probers): Promise<ProbeResult | null> {
  const timeoutMs = probers.timeoutMs ?? TIMEOUT_MS;
  switch (check.kind) {
    case "http":
      return combine(await Promise.all(check.steps.map((s) => step(probers.fetch, s, timeoutMs))));
    case "billing": {
      const billing = probers.billing;
      if (!billing) return null;
      return timed(async () => ((await billing()) ? true : "no price book"), timeoutMs);
    }
    case "storage": {
      const storage = probers.storage;
      if (!storage) return null;
      let report: StorageReport | null = null;
      const asked = await timed(async () => {
        report = await storage();
        return true;
      }, timeoutMs);
      return report ? judgeStorage(report) : asked;
    }
    case "none":
      return null;
  }
}

/**
 * Runs one part's check as the cron does: an address that answered, but
 * slowly, is asked once more straight away (`confirmSlow`) before the slow
 * answer counts. Checks through a binding are not repeated: git storage
 * reports the minutes gone by, and asking twice says the same.
 */
export async function probe(check: Check, probers: Probers, slowMs: number): Promise<ProbeResult | null> {
  const first = await runCheck(check, probers);
  if (check.kind !== "http" || !first || !onlySlow(first, slowMs)) return first;
  return confirmSlow(first, await runCheck(check, probers));
}
