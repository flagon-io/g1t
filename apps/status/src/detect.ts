/**
 * Noticing trouble before anyone reports it: when a part fails (or is
 * slow) on DETECT_BAD of its last DETECT_WINDOW checks, a draft incident
 * is made for staff in sudo, not shown on the status page until someone
 * publishes it. A run of trouble ends after RECOVER_AFTER good checks in a
 * row, however long it lasted; when a run that had crossed the line ends,
 * open incidents on its part get a note. A detected draft nobody has
 * picked up is dismissed on its own once its parts have stayed healthy for
 * RECOVERED_FOR_MS, and one left unacknowledged is raised again after
 * STALE_AFTER_MS, then every STALE_EVERY_MS. While a deploy is running
 * (and for DEPLOY_GRACE_MS after) no new draft is made unless the trouble
 * outlasts it. No Workers imports, so it is tested under Node.
 *
 * A slow answer only counts once the check, asked again at once, is slow
 * too (probe.ts `probe`), so one cold start is not a slow check.
 */
import type { ComponentImpact, StatusComponentState } from "@g1t/contracts";

/** Failed or slow checks, of the last DETECT_WINDOW, before a draft is made. */
export const DETECT_BAD = 4;
/** How many of a part's latest checks DETECT_BAD counts over (a minute apart). */
export const DETECT_WINDOW = 5;
/** Good checks in a row that end a run of trouble, whether or not it was raised. */
export const RECOVER_AFTER = 3;
/** How long a detected draft's parts stay healthy before it is dismissed on its own. */
export const RECOVERED_FOR_MS = 10 * 60_000;
/** How long a detected draft waits, unacknowledged, before the alert goes out again. */
export const STALE_AFTER_MS = 45 * 60_000;
/** After that, how often it goes out again while the draft still waits. */
export const STALE_EVERY_MS = 6 * 60 * 60_000;
/** How long after a deploy finishes its restarts are still forgiven. */
export const DEPLOY_GRACE_MS = 3 * 60_000;
/** A deploy that said it started and never said it finished stops counting after this. */
export const DEPLOY_MAX_MS = 30 * 60_000;

/** One check in a run's `recent`: good, slow, or not answering. */
export type Mark = "." | "s" | "x";

/**
 * One part's current run of trouble: from its first failed or slow check
 * until RECOVER_AFTER good checks in a row. Good checks inside the run
 * (flapping) do not end it; they are counted in `checks` and `recent`.
 */
export type Streak = {
  component: string;
  /** The worst seen in this run. */
  state: "degraded" | "down";
  /** Failed or slow checks in this run. */
  count: number;
  /** Every check in this run, from its first failed or slow one. */
  checks: number;
  /** The run's latest checks, oldest first, at most DETECT_WINDOW: "." good, "s" slow, "x" not answering. */
  recent: string;
  /** The first failed or slow check of this run. */
  since: string;
  /** Whether it has crossed the line, and been raised. */
  alerted: boolean;
};

/** An open incident (draft or public), with the parts it affects. */
export type OpenRef = { id: string; components: string[] };

/** A run that crossed the line: `checks` failed or slow of the `of` checks since `since`. */
export type Trouble = { key: string; state: "degraded" | "down"; since: string; checks: number; of: number };

export type Detection = {
  /** Every part's run still going after this round; parts not here have none. */
  streaks: Streak[];
  /** Parts that crossed the line with no open incident on them: one draft for all. */
  draft: Trouble[];
  /** Parts that crossed the line while an incident on them was open. */
  failing: (Trouble & { incident: string })[];
  /** Parts whose raised run ended: answering again, in time. */
  recovered: (Trouble & { incident: string })[];
  /** Parts that crossed the line during a deploy: kept counting, not raised yet. */
  held: string[];
};

export type DetectOptions = {
  /** Failed or slow checks of the last `window` that cross the line. */
  bad?: number;
  window?: number;
  /** Good checks in a row that end a run. */
  recoverAfter?: number;
  /** A deploy is running, or just finished: no new drafts, only counting. */
  quiet?: boolean;
};

const isBad = (m: string) => m === "s" || m === "x";

function mark(state: StatusComponentState): Mark {
  return state === "down" ? "x" : state === "degraded" ? "s" : ".";
}

/** How many of `recent` were failed or slow. */
export function badIn(recent: string): number {
  return [...recent].filter(isBad).length;
}

/** Good checks at the end of `recent`. */
function goodTail(recent: string): number {
  let n = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i] === "."; i--) n++;
  return n;
}

/** Whether a run's latest check was failed or slow: what keeps a draft from counting as healthy. */
export function troubledNow(streak: Streak): boolean {
  return isBad(streak.recent.at(-1) ?? "x");
}

/**
 * A run as kept before `checks` and `recent` (migration 0003): every one
 * of its checks failed, in a row.
 */
export function upgradeStreak(s: Omit<Streak, "checks" | "recent"> & { checks?: number | null; recent?: string | null }, window = DETECT_WINDOW): Streak {
  const count = Math.max(1, Number(s.count) || 1);
  const recent = s.recent || (s.state === "down" ? "x" : "s").repeat(Math.min(count, window));
  return { ...s, count, checks: Math.max(Number(s.checks) || 0, count), recent };
}

export function detect(
  previous: Map<string, Streak>,
  observations: { component: string; state: StatusComponentState }[],
  open: OpenRef[],
  maintenance: Set<string>,
  at: Date,
  { bad: need = DETECT_BAD, window = DETECT_WINDOW, recoverAfter = RECOVER_AFTER, quiet = false }: DetectOptions = {},
): Detection {
  const out: Detection = { streaks: [], draft: [], failing: [], recovered: [], held: [] };
  const covering = (key: string) => open.filter((i) => i.components.includes(key));
  for (const { component: key, state } of observations) {
    const prev = previous.get(key);
    if (state === "unmonitored" || maintenance.has(key)) continue;
    const m = mark(state);
    if (!prev && !isBad(m)) continue;
    const recent = `${prev?.recent ?? ""}${m}`.slice(-window);
    const streak: Streak = prev
      ? {
          ...prev,
          recent,
          checks: prev.checks + 1,
          count: prev.count + (isBad(m) ? 1 : 0),
          state: prev.state === "down" || state === "down" ? "down" : "degraded",
        }
      : { component: key, state: state as "degraded" | "down", count: 1, checks: 1, recent, since: at.toISOString(), alerted: false };
    const trouble = (): Trouble => ({ key, state: streak.state, since: streak.since, checks: streak.count, of: streak.checks });
    if (!isBad(m)) {
      // Enough good checks in a row end the run, however long it was. Leaving it out of `streaks` ends it.
      if (goodTail(recent) >= Math.min(recoverAfter, window)) {
        if (streak.alerted) {
          // The good checks that ended it are not part of the trouble.
          const t = { ...trouble(), of: streak.checks - goodTail(recent) };
          for (const i of covering(key)) out.recovered.push({ incident: i.id, ...t });
        }
        continue;
      }
    } else if (!streak.alerted && badIn(recent) >= need) {
      const t = trouble();
      const incidents = covering(key);
      if (incidents.length) {
        streak.alerted = true;
        for (const i of incidents) out.failing.push({ incident: i.id, ...t });
      } else if (quiet) {
        out.held.push(key);
      } else {
        streak.alerted = true;
        out.draft.push(t);
      }
    }
    out.streaks.push(streak);
  }
  return out;
}

// --- Deploys --------------------------------------------------------------------------

/**
 * A deploy as the deploy tool reported it. Deploys that overlap (the jobs
 * of one stage, in parallel) are one window: `running` counts the starts
 * not yet finished, and it is finished when the last one is.
 */
export type DeployWindow = {
  id: string | null;
  started_at: string;
  finished_at: string | null;
  /** Starts not yet finished. */
  running: number;
  /** The latest start: a window not finished stops counting DEPLOY_MAX_MS after it. */
  last_started_at: string;
};

/** Whether detection holds off at `at`: during a deploy, and for a grace period after. */
export function deployQuiet(window: DeployWindow | null, at: Date): boolean {
  if (!window) return false;
  const start = Date.parse(window.started_at);
  const t = at.getTime();
  if (Number.isNaN(start) || t < start - 60_000) return false;
  if (window.finished_at) return t < Date.parse(window.finished_at) + DEPLOY_GRACE_MS;
  const last = Date.parse(window.last_started_at);
  return t < (Number.isNaN(last) ? start : Math.max(start, last)) + DEPLOY_MAX_MS;
}

/** When detection stops holding off for this window. */
export function quietUntil(window: DeployWindow): string {
  const end = window.finished_at
    ? Date.parse(window.finished_at) + DEPLOY_GRACE_MS
    : Math.max(Date.parse(window.started_at), Date.parse(window.last_started_at)) + DEPLOY_MAX_MS;
  return new Date(end).toISOString();
}

/** The deploy tool's start or finish, folded into what is kept. */
export function deployChange(window: DeployWindow | null, phase: "started" | "finished", id: string | null, at: Date): DeployWindow {
  const now = at.toISOString();
  // Still quiet: running, or in its grace period. A start then joins the window, keeping its start.
  const live = window && deployQuiet(window, at) ? window : null;
  const running = live && !live.finished_at ? Math.max(1, live.running) : 0;
  if (phase === "started") {
    return { id: id ?? live?.id ?? null, started_at: live ? live.started_at : now, finished_at: null, running: running + 1, last_started_at: now };
  }
  if (running > 1) return { ...live!, id: live!.id ?? id, running: running - 1 };
  // The last one running finished; a finish with no start is a window of its own.
  return {
    id: id ?? window?.id ?? null,
    started_at: running ? live!.started_at : now,
    finished_at: now,
    running: 0,
    last_started_at: running ? live!.last_started_at : now,
  };
}

// --- Detected drafts that recover, and drafts left waiting ---------------------------------

/** A detected draft no one has picked up yet, since when its parts have been healthy, and when it was last raised again. */
export type WatchedDraft = {
  id: string;
  title: string;
  components: string[];
  started_at: string;
  /** When the draft was made: STALE_AFTER_MS counts from here. */
  declared_at: string;
  healthy_since: string | null;
  /** When the alert last went out again for it; null before the first time. */
  reminded_at: string | null;
};

export type Settled = {
  /** Every watched draft's healthy-since after this round: null while a part is in trouble. */
  healthy: { id: string; since: string | null }[];
  /** Drafts healthy long enough to dismiss. */
  dismiss: { id: string; title: string; recovered_at: string; lasted_ms: number }[];
};

/**
 * Which detected drafts have recovered for good. `troubled` is every part
 * whose latest check was failed or slow, in a run still going (detect.ts
 * `troubledNow`).
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

/**
 * Detected drafts to raise again: unacknowledged for STALE_AFTER_MS since
 * they were made, the first time; then every STALE_EVERY_MS after the last
 * time. `drafts` are the ones still waiting after this round's dismissals.
 */
export function staleDrafts(
  drafts: Pick<WatchedDraft, "id" | "title" | "declared_at" | "reminded_at">[],
  at: Date,
  { after = STALE_AFTER_MS, every = STALE_EVERY_MS } = {},
): { id: string; title: string; waiting_ms: number }[] {
  const t = at.getTime();
  return drafts
    .filter((d) => (d.reminded_at ? t - Date.parse(d.reminded_at) >= every : t - Date.parse(d.declared_at) >= after))
    .map((d) => ({ id: d.id, title: d.title, waiting_ms: Math.max(0, t - Date.parse(d.declared_at)) }));
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

/** "4 checks in a row", or "4 of 5 checks" when good ones came between. */
function checksWords(t: { checks: number; of?: number }): string {
  const of = t.of ?? t.checks;
  return of > t.checks ? `${t.checks} of ${of} checks` : `${t.checks} check${t.checks === 1 ? "" : "s"} in a row`;
}

/**
 * One part's trouble in a sentence, slow and down said apart:
 * "Git has been slow — over 1.5 s — on 4 checks in a row since 6 Oct 07:25 UTC."
 * "API has not answered on 4 of 5 checks since 6 Oct 07:25 UTC."
 * `since` is already written out, in whatever zone the reader needs.
 */
export function troubleSentence(name: string, t: { state: "degraded" | "down"; checks: number; of?: number }, since: string, slowMs: number): string {
  const checks = checksWords(t);
  return t.state === "down"
    ? `${name} has not answered on ${checks} since ${since}.`
    : `${name} has been slow — over ${limitWords(slowMs)} — on ${checks} since ${since}.`;
}

/** A part answering again, after a run that crossed the line. */
export function recoverySentence(name: string, t: { state: "degraded" | "down"; checks: number; of?: number }, since: string): string {
  const checks = checksWords(t);
  return t.state === "down"
    ? `${name} is answering again, after not answering on ${checks} since ${since}.`
    : `${name} is back to normal speed, after being slow on ${checks} since ${since}.`;
}

/** The timeline line, and the follow-up email's words, when a recovered draft is dismissed on its own. */
export function autoDismissText(lastedMs: number, recoveredAt: string, healthyFor = RECOVERED_FOR_MS): string {
  return `Recovered after ${minutesWords(lastedMs)}, at ${recoveredAt}, and stayed healthy for ${minutesWords(healthyFor)}; dismissed automatically. It never appeared on the status page.`;
}

/** The timeline line when a draft left waiting is raised again. */
export function staleText(waitingMs: number, emailed: boolean): string {
  return `Unacknowledged for ${minutesWords(waitingMs)}.${emailed ? " The alert address was emailed again." : ""}`;
}
