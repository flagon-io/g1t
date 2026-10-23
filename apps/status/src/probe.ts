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
  /**
   * A check judged by the site's own time (`serverTime` on its check): how
   * long the site took, without the way here. Slowness is judged on this.
   */
  server_ms?: number;
  /**
   * Each page's `Server-Timing` header as it came, by address: each
   * loader's and service's time, for telling where a slow page spent it.
   * Logged when a check is slow and asked again, never kept.
   */
  timings?: Timings;
  /** Slow at first and asked again (`confirmSlow`): both tries' headers, the first's first. */
  tries?: [Timings, Timings];
};

/** `Server-Timing` headers by the address that sent them. */
export type Timings = Record<string, string>;

/** The time a result is judged on: the site's own when there is one, else the whole time. */
export function judgedMs(result: Pick<ProbeResult, "ms" | "server_ms">): number {
  return result.server_ms ?? result.ms;
}

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

/** What the queues gave up on lately: events `delivery_health`. */
export type DeliveryReport = { minutes: number; dead: number; types: { type: string; count: number }[] };

/** This many events given up on in the span, and event delivery is down. */
const DELIVERY_DOWN = 10;

/**
 * What the events the queues gave up on mean: none is up, any is degraded,
 * naming the types, and many is down. A dropped event is a push whose
 * checks never start, or a comment nobody hears of, while everything else
 * answers as usual.
 */
export function judgeDelivery(report: DeliveryReport, ms = 0): ProbeResult {
  const dead = Number(report.dead) || 0;
  if (dead === 0) return { ok: true, ms };
  const types = report.types
    .slice(0, 3)
    .map((row) => row.type)
    .join(", ");
  const said = `${dead} ${dead === 1 ? "event" : "events"} not delivered in ${report.minutes} minutes${types ? ` (${types})` : ""}`;
  return dead >= DELIVERY_DOWN ? { ok: false, ms, error: said } : { ok: true, ms, degraded: said };
}

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
  const sum = (key: keyof Omit<StoreHealthRow, "store">) => report.stores.reduce((total, row) => total + (Number(row[key]) || 0), 0);
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

/** Runs a request when there is room for it (see [`limit`]). */
export type Gate = <T>(run: () => Promise<T>) => Promise<T>;

const ungated: Gate = (run) => run();

/**
 * At most `n` requests at once, the rest waiting their turn in the order
 * they were asked. A Worker may wait on six answers at once, its service
 * bindings among them; Cloudflare queues a seventh with its time already
 * running, so a round of a dozen checks timed out the ones at the back.
 * Each check's clock starts when its turn comes.
 */
export function limit(n: number): Gate {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (run) => {
    if (running < n) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

class Timeout extends Error {}

/** Runs `work`, timing it, and failing it after `timeoutMs`. */
export async function timed(work: (signal: AbortSignal) => Promise<true | string>, timeoutMs = TIMEOUT_MS, now: () => number = Date.now): Promise<ProbeResult> {
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
export async function step(
  fetcher: Fetch,
  { url, headers = {}, expect, browser = false }: Step,
  timeoutMs = TIMEOUT_MS,
  gate: Gate = ungated,
): Promise<ProbeResult> {
  let colo: string | null = null;
  let total: number | null = null;
  let timing: string | null = null;
  const result = await gate(() =>
    timed(async (signal) => {
      const response = await fetcher(url, {
        signal,
        redirect: "manual",
        headers: { "user-agent": browser ? BROWSER_USER_AGENT : USER_AGENT, "cache-control": "no-cache", ...headers },
      });
      // Timed to the answer's headers: the body is never read.
      colo = coloOf(response.headers.get("cf-ray"));
      timing = response.headers.get("server-timing");
      total = serverTotal(timing);
      await response.body?.cancel().catch(() => undefined);
      const good = expect == null ? response.ok : response.status === expect;
      return good || `HTTP ${response.status}`;
    }, timeoutMs),
  );
  const out: ProbeResult = { ...result, ...(colo ? { colo } : {}), ...(timing ? { timings: { [url]: timing } } : {}) };
  return total != null && result.ok ? { ...out, server_ms: total } : out;
}

/**
 * The site's own time to first byte, from its `Server-Timing` header: the
 * `total` entry apps/web's lib/perf.ts `serverTiming` writes first
 * (`total;dur=406;desc="web to first byte"`). Null without one: a page
 * from the site's cache says only `cache;desc="hit, 17s old"`.
 */
export function serverTotal(header: string | null | undefined): number | null {
  for (const entry of (header ?? "").split(",")) {
    const [name, ...params] = entry.split(";").map((p) => p.trim());
    if (name?.toLowerCase() !== "total") continue;
    const dur = params.find((p) => /^dur=/i.test(p));
    const ms = dur ? Number(dur.slice(4).replace(/^"|"$/g, "")) : Number.NaN;
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return null;
}

/**
 * The site's own time for a `serverTime` check: the slowest of its pages,
 * each at the time it says it took, or, for a page that does not say (one
 * from the site's cache), its time here less `baseline`'s, a file the site
 * hands out without any work, asked for at the same moment: the way here,
 * as near as it can be told. With no baseline, the whole time.
 */
export function serverOf(pages: ProbeResult[], baseline: ProbeResult | null): number {
  const way = baseline?.ok ? baseline.ms : 0;
  return Math.max(0, ...pages.map((p) => p.server_ms ?? Math.max(0, p.ms - way)));
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
  const timings = Object.assign({}, ...results.map((r) => r.timings ?? {})) as Timings;
  const out: ProbeResult = failed ? { ok: false, ms, error: failed.error ?? "no answer" } : { ok: true, ms };
  return { ...out, ...(colo ? { colo } : {}), ...(Object.keys(timings).length ? { timings } : {}) };
}

/** Whether a result is only slow: it worked, with nothing else wrong, but over `slowMs`. */
export function onlySlow(result: ProbeResult | null, slowMs: number): boolean {
  return result != null && result.ok && !result.degraded && Math.round(judgedMs(result)) > slowMs;
}

/**
 * A slow check, and the same check run again at once: the better of the
 * two. One slow answer (a cold isolate, a cache refill, a busy moment on
 * the path) does not count when the next answers in time; slow twice is
 * slow, at the faster of the two times. A second try that failed does not
 * make a slow check worse. `first_ms` keeps the first try's time.
 */
export function confirmSlow(first: ProbeResult, again: ProbeResult | null): ProbeResult {
  const tries: Pick<ProbeResult, "tries"> = first.timings || again?.timings ? { tries: [first.timings ?? {}, again?.timings ?? {}] } : {};
  if (!again || !again.ok || again.degraded) return { ...first, first_ms: first.ms, ...tries };
  const better = judgedMs(again) < judgedMs(first) ? again : first;
  const colo = better.colo ?? first.colo ?? again.colo;
  return { ...better, ...(colo ? { colo } : {}), first_ms: first.ms, ...tries };
}

/**
 * What runs a check. `billing` is null when there is no binding to it.
 * A call through a binding takes the signal that gives up on it, so one
 * that timed out does not keep its place among the six (`limit`).
 */
export type Probers = {
  fetch: Fetch;
  billing: ((signal: AbortSignal) => Promise<unknown>) | null;
  /** Git storage's recent health, through the repos service; null when not bound. */
  storage?: ((signal: AbortSignal) => Promise<StorageReport>) | null;
  /** What the queues gave up on lately, through the events service; null when not bound. */
  delivery?: ((signal: AbortSignal) => Promise<DeliveryReport>) | null;
  timeoutMs?: number;
  /** Room for each request; none waits when left out. */
  gate?: Gate;
};

/** Runs one part's check. Null for a part with no check. */
export async function runCheck(check: Check, probers: Probers): Promise<ProbeResult | null> {
  const timeoutMs = probers.timeoutMs ?? TIMEOUT_MS;
  const gate = probers.gate ?? ungated;
  switch (check.kind) {
    case "http": {
      const asked = Promise.all(check.steps.map((s) => step(probers.fetch, s, timeoutMs, gate)));
      if (!check.serverTime) return combine(await asked);
      // The baseline goes with the pages, so it takes the same way here at the same moment.
      const [pages, baseline] = await Promise.all([asked, step(probers.fetch, { url: check.serverTime.baseline }, timeoutMs, gate)]);
      const result = combine(pages);
      return result.ok ? { ...result, server_ms: serverOf(pages, baseline) } : result;
    }
    case "billing": {
      const billing = probers.billing;
      if (!billing) return null;
      return gate(() => timed(async (signal) => ((await billing(signal)) ? true : "no price book"), timeoutMs));
    }
    case "storage": {
      const storage = probers.storage;
      if (!storage) return null;
      let report: StorageReport | null = null;
      const asked = await gate(() =>
        timed(async (signal) => {
          report = await storage(signal);
          return true;
        }, timeoutMs),
      );
      return report ? judgeStorage(report) : asked;
    }
    case "delivery": {
      const delivery = probers.delivery;
      if (!delivery) return null;
      let report: DeliveryReport | null = null;
      const asked = await gate(() =>
        timed(async (signal) => {
          report = await delivery(signal);
          return true;
        }, timeoutMs),
      );
      return report ? judgeDelivery(report, asked.ms) : asked;
    }
    case "none":
      return null;
  }
}

/** A call that got no answer at all: it timed out, or never connected. */
export function unanswered(result: ProbeResult): boolean {
  return !result.ok && (result.error === "timed out" || result.error === "could not connect");
}

/**
 * Runs one part's check as the cron does: an address that answered, but
 * slowly, is asked once more straight away (`confirmSlow`) before the slow
 * answer counts.
 *
 * A call through a binding that got no answer is asked once more too, and
 * the second answer counts: the cron runs in a different data centre each
 * minute, where billing and repos are seldom running yet, and starting
 * one there can take longer than the check waits. Billing answering slowly
 * is confirmed as an address is. What git storage and event delivery
 * report is not asked twice: it covers the minutes gone by, and asking
 * again says the same.
 */
export async function probe(check: Check, probers: Probers, slowMs: number): Promise<ProbeResult | null> {
  const first = await runCheck(check, probers);
  if (!first) return first;
  if (check.kind === "http" || check.kind === "billing") {
    if (onlySlow(first, slowMs)) return confirmSlow(first, await runCheck(check, probers));
  }
  if (check.kind !== "http" && unanswered(first)) {
    const again = await runCheck(check, probers);
    return again ? { ...again, first_ms: first.ms } : first;
  }
  return first;
}
