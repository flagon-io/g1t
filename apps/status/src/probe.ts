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

export const USER_AGENT = "g1t-status (+https://status.g1t.sh)";

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
export function step(fetcher: Fetch, { url, headers = {}, expect }: Step, timeoutMs = TIMEOUT_MS): Promise<ProbeResult> {
  return timed(async (signal) => {
    const response = await fetcher(url, {
      signal,
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, "cache-control": "no-cache", ...headers },
    });
    await response.body?.cancel().catch(() => undefined);
    const good = expect == null ? response.ok : response.status === expect;
    return good || `HTTP ${response.status}`;
  }, timeoutMs);
}

/** A check's requests together: it works when every one does, and takes as long as the slowest. */
export function combine(results: ProbeResult[]): ProbeResult {
  const ms = Math.max(0, ...results.map((r) => r.ms));
  const failed = results.find((r) => !r.ok);
  return failed ? { ok: false, ms, error: failed.error ?? "no answer" } : { ok: true, ms };
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
