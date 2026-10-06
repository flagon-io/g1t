/**
 * Noticing trouble before anyone reports it: when a part fails (or is
 * slow) for DETECT_AFTER checks in a row, a draft incident is made for
 * staff in sudo, not shown on the status page until someone publishes it.
 * When a part that had crossed that line answers again, open incidents on
 * it get a note. No Workers imports, so it is tested under Node.
 */
import type { ComponentImpact, StatusComponentState } from "@g1t/contracts";

/** Checks in a row, a minute apart, before a draft is made. */
export const DETECT_AFTER = 3;

export type Streak = {
  component: string;
  /** The worst seen in this run of failures. */
  state: "degraded" | "down";
  count: number;
  /** When the run began. */
  since: string;
  /** Whether it has crossed the line, and been raised. */
  alerted: boolean;
};

/** An open incident (draft or public), with the parts it affects. */
export type OpenRef = { id: string; components: string[] };

export type Detection = {
  /** Every failing part's run after this round; parts not here have none. */
  streaks: Streak[];
  /** Parts that crossed the line with no open incident on them: one draft for all. */
  draft: { key: string; state: "degraded" | "down"; since: string }[];
  /** Parts that crossed the line while an incident on them was open. */
  failing: { incident: string; key: string; state: "degraded" | "down"; since: string }[];
  /** Parts answering again after crossing the line. */
  recovered: { incident: string; key: string; since: string; checks: number }[];
};

export function detect(
  previous: Map<string, Streak>,
  observations: { component: string; state: StatusComponentState }[],
  open: OpenRef[],
  maintenance: Set<string>,
  at: Date,
  threshold = DETECT_AFTER,
): Detection {
  const out: Detection = { streaks: [], draft: [], failing: [], recovered: [] };
  const covering = (key: string) => open.filter((i) => i.components.includes(key));
  for (const { component: key, state } of observations) {
    const prev = previous.get(key);
    if (state === "unmonitored" || maintenance.has(key)) continue;
    if (state !== "degraded" && state !== "down") {
      if (prev?.alerted) for (const i of covering(key)) out.recovered.push({ incident: i.id, key, since: prev.since, checks: prev.count });
      continue;
    }
    const streak: Streak = prev
      ? { ...prev, count: prev.count + 1, state: prev.state === "down" || state === "down" ? "down" : "degraded" }
      : { component: key, state, count: 1, since: at.toISOString(), alerted: false };
    if (!streak.alerted && streak.count >= threshold) {
      streak.alerted = true;
      const incidents = covering(key);
      if (incidents.length) for (const i of incidents) out.failing.push({ incident: i.id, key, state: streak.state, since: streak.since });
      else out.draft.push({ key, state: streak.state, since: streak.since });
    }
    out.streaks.push(streak);
  }
  return out;
}

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
