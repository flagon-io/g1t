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
};

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
    case "none":
      return null;
  }
}
