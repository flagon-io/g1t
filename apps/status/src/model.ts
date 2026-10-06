/**
 * What a check's result means, how the parts add up to one line for the
 * whole, and the 90 days of history behind each uptime bar. No Workers
 * imports, so it is tested under Node.
 */
import type {
  ComponentImpact,
  IncidentImpact,
  IncidentStatus,
  MaintenanceState,
  StatusComponent,
  StatusComponentState,
  StatusIncident,
  StatusMaintenance,
  StatusOverall,
  StatusOverallState,
  StatusReport,
} from "@g1t/contracts";

import type { ComponentInfo } from "./components.ts";
import type { ProbeResult } from "./probe.ts";

/** Slower than this, a part that answered counts as degraded. */
export const SLOW_MS = 1500;
/** How many days of history the page shows and keeps. */
export const HISTORY_DAYS = 90;
/** Checks older than this mean the checker has stopped: the page says so. */
export const STALE_MS = 10 * 60 * 1000;

/** What a check's result means for its part. `null` is a part with no check. */
export function classify(result: ProbeResult | null, slowMs = SLOW_MS): { state: StatusComponentState; detail: string } {
  if (!result) return { state: "unmonitored", detail: "Not monitored yet" };
  if (!result.ok) return { state: "down", detail: `Failed: ${result.error ?? "no answer"}` };
  if (result.degraded) return { state: "degraded", detail: result.degraded };
  const ms = Math.round(result.ms);
  if (ms > slowMs) return { state: "degraded", detail: `Slow: answered in ${ms} ms` };
  return { state: "up", detail: `Answered in ${ms} ms` };
}

/** A part's state at its last check, as stored. */
export type Current = { state: StatusComponentState; detail: string; latency_ms: number | null };

/** One part's checks on one UTC day, as stored. */
export type DayRow = {
  component: string;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  checks: number;
  up: number;
  degraded: number;
  down: number;
  latency_total: number;
  latency_count: number;
};

/** One day's square on a bar. */
export type DayBar = {
  day: string;
  state: "up" | "degraded" | "down" | "none";
  /** Share of checks that answered, 0 to 100; null with none. */
  uptime: number | null;
  checks: number;
  failed: number;
  slow: number;
  avg_ms: number | null;
  /** Incidents on this part that were open some time that day. */
  incidents: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of a time, in UTC. */
export function dayOf(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The last `count` days, oldest first, ending today. */
export function lastDays(now: Date, count = HISTORY_DAYS): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, i) => dayOf(today - (count - 1 - i) * DAY_MS));
}

/**
 * Share of checks answered, rounded down to hundredths so a single failure
 * never shows as 100%.
 */
export function uptimeOf(answered: number, checks: number): number | null {
  if (checks <= 0) return null;
  return Math.floor((answered / checks) * 10000) / 100;
}

/** Words for an uptime: "100%", "99.93%". */
export function percent(uptime: number | null): string {
  if (uptime == null) return "No data";
  return uptime >= 100 ? "100%" : `${uptime.toFixed(2)}%`;
}

const LEVEL = { none: 0, up: 1, degraded: 2, down: 3 } as const;

/**
 * A day's colour: answered at least 99.9% of the time is up (one blip in a
 * day of minutely checks), unless over a quarter of answers were slow; at
 * least 95% is degraded; less is down. An incident on the part that day
 * colours it at least as badly as its impact.
 */
export function dayState(row: Pick<DayRow, "checks" | "up" | "degraded" | "down"> | null, incidentImpact: IncidentImpact | null = null): DayBar["state"] {
  let state: DayBar["state"] = "none";
  if (row && row.checks > 0) {
    const uptime = ((row.up + row.degraded) / row.checks) * 100;
    if (uptime >= 99.9) state = row.degraded / row.checks > 0.25 ? "degraded" : "up";
    else if (uptime >= 95) state = "degraded";
    else state = "down";
  }
  if (incidentImpact && LEVEL[incidentImpact] > LEVEL[state]) state = incidentImpact;
  return state;
}

/** Whether an incident was open at some time during `day`. */
export function openOn(incident: Pick<StatusIncident, "started_at" | "resolved_at">, day: string): boolean {
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = start + DAY_MS;
  const began = Date.parse(incident.started_at);
  const ended = incident.resolved_at ? Date.parse(incident.resolved_at) : Number.POSITIVE_INFINITY;
  return began < end && ended >= start;
}

/** A part's bar: one square per day, oldest first. */
export function barFor(
  key: string,
  rows: DayRow[],
  incidents: Pick<StatusIncident, "title" | "started_at" | "resolved_at" | "component_impacts">[],
  days: string[],
): DayBar[] {
  const byDay = new Map(rows.filter((r) => r.component === key).map((r) => [r.day, r]));
  const mine = incidents
    .map((i) => ({ incident: i, impact: i.component_impacts.find((c) => c.key === key)?.impact ?? null }))
    .filter((m) => m.impact != null && m.impact !== "operational");
  return days.map((day) => {
    const row = byDay.get(day) ?? null;
    const during = mine.filter((m) => openOn(m.incident, day));
    const impact = during.some((m) => m.impact === "major_outage") ? "down" : during.length ? "degraded" : null;
    return {
      day,
      state: dayState(row, impact),
      uptime: row ? uptimeOf(row.up + row.degraded, row.checks) : null,
      checks: row?.checks ?? 0,
      failed: row?.down ?? 0,
      slow: row?.degraded ?? 0,
      avg_ms: row && row.latency_count > 0 ? Math.round(row.latency_total / row.latency_count) : null,
      incidents: during.map((m) => m.incident.title),
    };
  });
}

/** A part's uptime over the days given. */
export function uptimeOver(key: string, rows: DayRow[]): number | null {
  let checks = 0;
  let answered = 0;
  for (const row of rows) {
    if (row.component !== key) continue;
    checks += row.checks;
    answered += row.up + row.degraded;
  }
  return uptimeOf(answered, checks);
}


const RANK: Record<StatusOverallState, number> = { unknown: 0, up: 1, maintenance: 1.5, degraded: 2, down: 3 };

function worse(a: StatusOverallState, b: StatusOverallState): StatusOverallState {
  return RANK[b] > RANK[a] ? b : a;
}

/** Words for an incident's status. */
export const INCIDENT_STATUS: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

/** Words for what an incident does to a part. */
export const IMPACT_WORD: Record<ComponentImpact, string> = {
  operational: "Operational",
  degraded: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
};

/** A part's state for an impact on it. */
export const IMPACT_STATE: Record<ComponentImpact, StatusComponentState> = {
  operational: "up",
  degraded: "degraded",
  partial_outage: "partial",
  major_outage: "down",
};

/** How bad each state is: the worse of a check and an incident wins. */
const STATE_RANK: Record<StatusComponentState, number> = { unmonitored: 0, up: 1, maintenance: 1, degraded: 2, partial: 3, down: 4 };

/** An incident's impact as a whole: `down` when any part has a major outage. */
export function overallImpact(impacts: { impact: ComponentImpact }[]): IncidentImpact {
  return impacts.some((i) => i.impact === "major_outage") ? "down" : "degraded";
}

/**
 * What the page shows for a part: the worse of its last check and what
 * open incidents say about it. During maintenance it is "Under
 * maintenance", unless an incident says worse, since checks failing in a
 * window are expected.
 */
export function effectiveState(check: StatusComponentState, impacts: ComponentImpact[], underMaintenance: boolean): StatusComponentState {
  let reported: StatusComponentState | null = null;
  for (const impact of impacts) {
    const state = IMPACT_STATE[impact];
    if (reported == null || STATE_RANK[state] > STATE_RANK[reported]) reported = state;
  }
  if (underMaintenance && (reported == null || reported === "up")) return "maintenance";
  if (reported == null) return check;
  if (check === "unmonitored" || check === "maintenance") return reported;
  return STATE_RANK[reported] > STATE_RANK[check] ? reported : check;
}

/**
 * Where maintenance stands at `now`. Cancelled and completed are final;
 * otherwise the window decides, so the page is right even if the
 * minutely job that moves it along is late.
 */
export function maintenanceState(m: Pick<StatusMaintenance, "state" | "starts_at" | "ends_at">, now: Date): MaintenanceState {
  if (m.state === "cancelled" || m.state === "completed") return m.state;
  const t = now.getTime();
  if (t >= Date.parse(m.ends_at)) return "completed";
  if (t >= Date.parse(m.starts_at) || m.state === "in_progress") return "in_progress";
  return "scheduled";
}

/** The parts under maintenance at `now`. */
export function underMaintenance(
  list: Pick<StatusMaintenance, "state" | "starts_at" | "ends_at" | "components">[],
  now: Date,
): Set<string> {
  const keys = new Set<string>();
  for (const m of list) if (maintenanceState(m, now) === "in_progress") for (const k of m.components) keys.add(k);
  return keys;
}

/**
 * The whole, from its parts and its open incidents: a major outage when a
 * core part is down or an incident says so; a partial outage when any part
 * is down or partly down, or an incident is open; degraded performance
 * when parts are only slow; under maintenance when work is under way and
 * nothing else is wrong. Parts with no check never make it look better or
 * worse.
 */
export function summarize(
  parts: Pick<StatusComponent, "key" | "name" | "state">[],
  core: Set<string>,
  open: Pick<StatusIncident, "title" | "impact" | "status">[] = [],
  maintenance: Pick<StatusMaintenance, "title">[] = [],
): StatusOverall {
  const monitored = parts.filter((c) => c.state !== "unmonitored");
  if (monitored.length === 0 && open.length === 0) {
    return { state: "unknown", title: "Status unavailable", line: "No checks have run yet." };
  }
  let state: StatusOverallState = monitored.length > 0 ? "up" : "unknown";
  for (const c of monitored) {
    if (c.state === "down") state = worse(state, core.has(c.key) ? "down" : "degraded");
    else if (c.state === "partial" || c.state === "degraded") state = worse(state, "degraded");
    else if (c.state === "maintenance") state = worse(state, "maintenance");
  }
  for (const incident of open) state = worse(state, incident.impact);

  const down = monitored.filter((c) => c.state === "down" || c.state === "partial").map((c) => c.name);
  const slow = monitored.filter((c) => c.state === "degraded").map((c) => c.name);
  const lead = open[0];
  const incidentLine = lead ? `${INCIDENT_STATUS[lead.status]}: ${lead.title}.` : null;
  const named = (names: string[]) => names.join(", ");

  if (state === "up") return { state, title: "All systems normal", line: "Every part of g1t answered its last check." };
  if (state === "maintenance") {
    const work = maintenance[0];
    return { state, title: "Under maintenance", line: work ? `Planned work: ${work.title}.` : "Planned work is under way." };
  }
  if (state === "down") {
    return {
      state,
      title: "Major outage",
      line: incidentLine ?? (down.length ? `Not answering: ${named(down)}.` : "g1t is not working right now."),
    };
  }
  if (state === "degraded") {
    if (down.length || open.length) {
      return {
        state,
        title: "Partial outage",
        line: incidentLine ?? `Not answering: ${named(down)}${slow.length ? `. Slow: ${named(slow)}` : ""}.`,
      };
    }
    return { state, title: "Degraded performance", line: `Slow to answer: ${named(slow)}.` };
  }
  return { state, title: "Status unavailable", line: "No checks have run yet." };
}

/** Open incidents, and those resolved within `days` of `now`, newest first. */
export function recentIncidents<T extends Pick<StatusIncident, "started_at" | "resolved_at">>(
  incidents: T[],
  now: Date,
  days = HISTORY_DAYS,
): T[] {
  const since = now.getTime() - days * DAY_MS;
  return incidents
    .filter((i) => i.resolved_at == null || Date.parse(i.resolved_at) >= since)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

/** Everything the page and the JSON show. */
export type PageModel = {
  report: StatusReport;
  bars: Record<string, DayBar[]>;
  /** The checks have not run for a while: the checker itself is in trouble. */
  stale: boolean;
};

/** The report, from what is stored. */
export function buildPage(input: {
  parts: ComponentInfo[];
  current: Map<string, Current>;
  checkedAt: string | null;
  days: DayRow[];
  incidents: StatusIncident[];
  maintenance?: StatusMaintenance[];
  now: Date;
}): PageModel {
  const { parts, current, checkedAt, days, now } = input;
  const window = lastDays(now);
  const since = window[0]!;
  const rows = days.filter((r) => r.day >= since);
  const incidents = recentIncidents(input.incidents, now);
  const open = incidents.filter((i) => i.resolved_at == null);
  // Upcoming and under way, soonest first, each with its state as of now.
  const maintenance = (input.maintenance ?? [])
    .map((m) => ({ ...m, state: maintenanceState(m, now) }))
    .filter((m) => m.state === "scheduled" || m.state === "in_progress")
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const working = underMaintenance(maintenance, now);
  const components: StatusComponent[] = parts.map((info) => {
    const seen = info.check.kind === "none" ? null : current.get(info.key);
    const check: StatusComponentState = seen?.state ?? "unmonitored";
    const impacts = open.flatMap((i) => i.component_impacts.filter((c) => c.key === info.key).map((c) => c.impact));
    return {
      key: info.key,
      name: info.name,
      address: info.address,
      checks: info.checks,
      state: effectiveState(check, impacts, working.has(info.key)),
      check_state: check,
      detail: seen?.detail ?? (info.check.kind === "none" ? "Not monitored yet" : "Not checked yet"),
      latency_ms: seen?.latency_ms ?? null,
      uptime_90d: info.check.kind === "none" ? null : uptimeOver(info.key, rows),
    };
  });
  const core = new Set(parts.filter((p) => p.core).map((p) => p.key));
  const bars = Object.fromEntries(parts.map((p) => [p.key, barFor(p.key, rows, incidents, window)]));
  const inProgress = maintenance.filter((m) => m.state === "in_progress");
  return {
    report: { checked_at: checkedAt, overall: summarize(components, core, open, inProgress), components, incidents, maintenance },
    bars,
    stale: checkedAt == null || now.getTime() - Date.parse(checkedAt) > STALE_MS,
  };
}
