/**
 * Noticing trouble before anyone reports it: when a part fails (or is
 * slow) for DETECT_AFTER checks in a row, a draft incident is made for
 * staff in sudo, not shown on the status page until someone publishes it.
 * When a part that had crossed that line answers again, open incidents on
 * it get a note. A detected draft nobody has picked up is dismissed on its
 * own once its parts have stayed healthy for RECOVERED_FOR_MS, and while a
 * deploy is running (and for DEPLOY_GRACE_MS after) no new draft is made
 * unless the trouble outlasts it. No Workers imports, so it is tested
 * under Node.
 */
import type { ComponentImpact, StatusComponentState } from "@g1t/contracts";

/** Checks in a row, a minute apart, before a draft is made. */
export const DETECT_AFTER = 3;
/** How long a detected draft's parts stay healthy before it is dismissed on its own. */
export const RECOVERED_FOR_MS = 10 * 60_000;
/** How long after a deploy finishes its restarts are still forgiven. */
export const DEPLOY_GRACE_MS = 3 * 60_000;
/** A deploy that said it started and never said it finished stops counting after this. */
export const DEPLOY_MAX_MS = 30 * 60_000;

/**
 * One part's current run of failed or slow checks. Only parts that were
 * failing or slow on the latest check have one: any good check ends it,
 * and the next trouble starts a new run, with its own start.
 */
export type Streak = {
  component: string;
  /** The worst seen in this run of failures. */
  state: "degraded" | "down";
  count: number;
  /** The first failed or slow check of this run. */
  since: string;
  /** Whether it has crossed the line, and been raised. */
  alerted: boolean;
};

/** An open incident (draft or public), with the parts it affects. */
export type OpenRef = { id: string; components: string[] };

export type Trouble = { key: string; state: "degraded" | "down"; since: string; checks: number };

export type Detection = {
  /** Every failing part's run after this round; parts not here have none. */
  streaks: Streak[];
  /** Parts that crossed the line with no open incident on them: one draft for all. */
  draft: Trouble[];
  /** Parts that crossed the line while an incident on them was open. */
  failing: (Trouble & { incident: string })[];
  /** Parts answering again after crossing the line. */
  recovered: { incident: string; key: string; state: "degraded" | "down"; since: string; checks: number }[];
  /** Parts that crossed the line during a deploy: kept counting, not raised yet. */
  held: string[];
};

export type DetectOptions = {
  threshold?: number;
  /** A deploy is running, or just finished: no new drafts, only counting. */
  quiet?: boolean;
};

export function detect(
  previous: Map<string, Streak>,
  observations: { component: string; state: StatusComponentState }[],
  open: OpenRef[],
  maintenance: Set<string>,
  at: Date,
  { threshold = DETECT_AFTER, quiet = false }: DetectOptions = {},
): Detection {
  const out: Detection = { streaks: [], draft: [], failing: [], recovered: [], held: [] };
  const covering = (key: string) => open.filter((i) => i.components.includes(key));
  for (const { component: key, state } of observations) {
    const prev = previous.get(key);
    if (state === "unmonitored" || maintenance.has(key)) continue;
    if (state !== "degraded" && state !== "down") {
      // A good check: the run, if any, is over. Leaving it out of `streaks` ends it.
      if (prev?.alerted) for (const i of covering(key)) out.recovered.push({ incident: i.id, key, state: prev.state, since: prev.since, checks: prev.count });
      continue;
    }
    const streak: Streak = prev
      ? { ...prev, count: prev.count + 1, state: prev.state === "down" || state === "down" ? "down" : "degraded" }
      : { component: key, state, count: 1, since: at.toISOString(), alerted: false };
    if (!streak.alerted && streak.count >= threshold) {
      const trouble = { key, state: streak.state, since: streak.since, checks: streak.count };
      const incidents = covering(key);
      if (incidents.length) {
        streak.alerted = true;
        for (const i of incidents) out.failing.push({ incident: i.id, ...trouble });
      } else if (quiet) {
        out.held.push(key);
      } else {
        streak.alerted = true;
        out.draft.push(trouble);
      }
    }
    out.streaks.push(streak);
  }
  return out;
}

// --- Deploys --------------------------------------------------------------------------

/** A deploy as the deploy tool reported it. */
export type DeployWindow = { id: string | null; started_at: string; finished_at: string | null };

/** Whether detection holds off at `at`: during a deploy, and for a grace period after. */
export function deployQuiet(window: DeployWindow | null, at: Date): boolean {
  if (!window) return false;
  const start = Date.parse(window.started_at);
  const t = at.getTime();
  if (Number.isNaN(start) || t < start - 60_000) return false;
  if (window.finished_at) return t < Date.parse(window.finished_at) + DEPLOY_GRACE_MS;
  return t < start + DEPLOY_MAX_MS;
}

/** The deploy tool's start or finish, folded into what is kept. */
export function deployChange(window: DeployWindow | null, phase: "started" | "finished", id: string | null, at: Date): DeployWindow {
  const now = at.toISOString();
  if (phase === "started") {
    // A second start while one is running keeps the earlier start.
    const running = window && !window.finished_at && deployQuiet(window, at);
    return { id, started_at: running ? window.started_at : now, finished_at: null };
  }
  const running = window && !window.finished_at && deployQuiet(window, at);
  return { id: id ?? window?.id ?? null, started_at: running ? window.started_at : now, finished_at: now };
}

// --- Detected drafts that recover ---------------------------------------------------------

/** A detected draft no one has picked up yet, and since when its parts have been healthy. */
export type WatchedDraft = { id: string; title: string; components: string[]; started_at: string; healthy_since: string | null };

export type Settled = {
  /** Every watched draft's healthy-since after this round: null while a part is in trouble. */
  healthy: { id: string; since: string | null }[];
  /** Drafts healthy long enough to dismiss. */
  dismiss: { id: string; title: string; recovered_at: string; lasted_ms: number }[];
};

/**
 * Which detected drafts have recovered for good. `troubled` is every part
 * with a run of failed or slow checks after this round.
 */
export function settleDrafts(drafts: WatchedDraft[], troubled: Set<string>, at: Date, after = RECOVERED_FOR_MS): Settled {
  const out: Settled = { healthy: [], dismiss: [] };
  for (const d of drafts) {
    if (d.components.some((k) => troubled.has(k))) {
      out.healthy.push({ id: d.id, since: null });
      continue;
    }
    const since = d.healthy_since ?? at.toISOString();
    if (at.getTime() - Date.parse(since) >= after) {
      out.dismiss.push({ id: d.id, title: d.title, recovered_at: since, lasted_ms: Math.max(0, Date.parse(since) - Date.parse(d.started_at)) });
    } else {
      out.healthy.push({ id: d.id, since });
    }
  }
  return out;
}

// --- Wording --------------------------------------------------------------------------------

/** What a detected failure does to its part, for the draft. */
export function detectedImpact(state: "degraded" | "down"): ComponentImpact {
  return state === "down" ? "major_outage" : "degraded";
}

/** The draft's title: "Detected: API and Git not answering". */
export function draftTitle(parts: { name: string; state: "degraded" | "down" }[]): string {
  const list = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  const down = parts.filter((p) => p.state === "down").map((p) => p.name);
  const slow = parts.filter((p) => p.state === "degraded").map((p) => p.name);
  const said = [down.length ? `${list(down)} not answering` : "", slow.length ? `${list(slow)} slow` : ""].filter(Boolean).join("; ");
  return `Detected: ${said}`.slice(0, 120);
}

/** A part's slow line in words: "1.5 s", "800 ms". */
export function limitWords(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${ms} ms`;
}

/** "3 minutes", "1 minute", "2h 05m". */
export function minutesWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * One part's trouble in a sentence, slow and down said apart:
 * "Git has been slow — over 1.5 s — on 3 checks in a row since 6 Oct 07:25 UTC."
 * "API has not answered on 3 checks in a row since 6 Oct 07:25 UTC."
 * `since` is already written out, in whatever zone the reader needs.
 */
export function troubleSentence(name: string, t: { state: "degraded" | "down"; checks: number }, since: string, slowMs: number): string {
  const checks = `${t.checks} check${t.checks === 1 ? "" : "s"} in a row`;
  return t.state === "down"
    ? `${name} has not answered on ${checks} since ${since}.`
    : `${name} has been slow — over ${limitWords(slowMs)} — on ${checks} since ${since}.`;
}

/** A part answering again, after a run that crossed the line. */
export function recoverySentence(name: string, t: { state: "degraded" | "down"; checks: number }, since: string): string {
  const checks = `${t.checks} check${t.checks === 1 ? "" : "s"} in a row`;
  return t.state === "down"
    ? `${name} is answering again, after not answering on ${checks} since ${since}.`
    : `${name} is back to normal speed, after being slow on ${checks} since ${since}.`;
}

/** The timeline line, and the follow-up email's words, when a recovered draft is dismissed on its own. */
export function autoDismissText(lastedMs: number, recoveredAt: string, healthyFor = RECOVERED_FOR_MS): string {
  return `Recovered after ${minutesWords(lastedMs)}, at ${recoveredAt}, and stayed healthy for ${minutesWords(healthyFor)}; dismissed automatically. It never appeared on the status page.`;
}
