/**
 * The Incidents pages' wording and arithmetic: tabs and filters read from
 * the address, chips and their tones, durations, and reading the forms.
 * No Workers or React imports, so it is tested under Node. The status
 * worker checks everything again.
 */
import {
  type AdminIncident,
  type AdminMaintenance,
  COMPONENT_IMPACTS,
  type ComponentImpact,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  type ImpactInput,
  type IncidentSeverity,
  type IncidentStatus,
  type MaintenanceState,
} from "@g1t/contracts/status";

import { fromLocalInput, toLocalInput } from "./time.ts";

export { COMPONENT_IMPACTS, INCIDENT_SEVERITIES, INCIDENT_STATUSES };

export type Tone = "plain" | "lavender" | "mint" | "warn" | "danger" | "info";

export const SEVERITY_TONE: Record<IncidentSeverity, Tone> = { sev1: "danger", sev2: "warn", sev3: "info", sev4: "plain" };
export const STATUS_TONE: Record<IncidentStatus, Tone> = { investigating: "danger", identified: "warn", monitoring: "info", resolved: "mint" };
export const IMPACT_TONE: Record<ComponentImpact, Tone> = { operational: "mint", degraded: "warn", partial_outage: "warn", major_outage: "danger" };
export const MAINTENANCE_TONE: Record<MaintenanceState, Tone> = { scheduled: "info", in_progress: "lavender", completed: "mint", cancelled: "plain" };
export const MAINTENANCE_WORD: Record<MaintenanceState, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function severityLabel(severity: IncidentSeverity): string {
  return INCIDENT_SEVERITIES.find((s) => s.value === severity)?.label ?? severity.toUpperCase();
}

export function statusLabel(status: IncidentStatus): string {
  return INCIDENT_STATUSES.find((s) => s.value === status)?.label ?? status;
}

export function impactLabel(impact: ComponentImpact): string {
  return COMPONENT_IMPACTS.find((i) => i.value === impact)?.label ?? impact;
}

export function notifyByDefault(severity: IncidentSeverity): boolean {
  return INCIDENT_SEVERITIES.find((s) => s.value === severity)?.notify ?? false;
}

/** A notify choice: `yes`, `no`, or `auto` (the severity's default). */
export function wantsNotify(choice: string, severity: IncidentSeverity): boolean {
  return choice === "yes" || choice === "on" || (choice === "auto" && notifyByDefault(severity));
}

/** The status a next update most likely moves to. */
export function nextStatus(status: IncidentStatus): IncidentStatus {
  return status === "investigating" ? "identified" : status === "identified" ? "monitoring" : "resolved";
}

// --- Tabs and filters ------------------------------------------------------------------

export const TABS = [
  { value: "open", label: "Open" },
  { value: "maintenance", label: "Scheduled maintenance" },
  { value: "resolved", label: "Resolved" },
  { value: "drafts", label: "Drafts" },
] as const;
export type Tab = (typeof TABS)[number]["value"];

export type Filters = { tab: Tab; severity: IncidentSeverity | null; component: string | null; q: string };

export function parseFilters(params: URLSearchParams): Filters {
  const tab = TABS.find((t) => t.value === params.get("tab"))?.value ?? "open";
  const severity = INCIDENT_SEVERITIES.find((s) => s.value === params.get("severity"))?.value ?? null;
  const component = /^[a-z][a-z0-9-]{0,40}$/.test(params.get("component") ?? "") ? params.get("component") : null;
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  return { tab, severity, component, q };
}

export function incidentsHref(filters: Partial<Filters>): string {
  const params = new URLSearchParams();
  if (filters.tab && filters.tab !== "open") params.set("tab", filters.tab);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.component) params.set("component", filters.component);
  if (filters.q) params.set("q", filters.q);
  const query = params.toString();
  return query ? `/incidents?${query}` : "/incidents";
}

/** Which tab an incident is under. Maintenance has its own. */
export function tabOf(incident: Pick<AdminIncident, "visibility" | "resolved_at">): Exclude<Tab, "maintenance"> {
  if (incident.visibility === "draft") return "drafts";
  if (incident.visibility === "dismissed" || incident.resolved_at) return "resolved";
  return "open";
}

export function filterIncidents<T extends Pick<AdminIncident, "visibility" | "resolved_at" | "severity" | "components" | "title">>(
  list: T[],
  filters: Filters,
): T[] {
  const q = filters.q.toLowerCase();
  return list.filter(
    (i) =>
      tabOf(i) === filters.tab &&
      (!filters.severity || i.severity === filters.severity) &&
      (!filters.component || i.components.some((c) => c.key === filters.component && c.impact !== "operational")) &&
      (!q || i.title.toLowerCase().includes(q)),
  );
}

/** Maintenance under the tab: upcoming and under way first, soonest first; then finished, newest first. */
export function maintenanceList(list: AdminMaintenance[], component: string | null): AdminMaintenance[] {
  const live = (m: AdminMaintenance) => m.state === "scheduled" || m.state === "in_progress";
  return list
    .filter((m) => !component || m.components.includes(component))
    .sort((a, b) => (live(a) !== live(b) ? (live(a) ? -1 : 1) : live(a) ? a.starts_at.localeCompare(b.starts_at) : b.starts_at.localeCompare(a.starts_at)));
}

export function tabCounts(incidents: Pick<AdminIncident, "visibility" | "resolved_at">[], maintenance: Pick<AdminMaintenance, "state">[]): Record<Tab, number> {
  const counts: Record<Tab, number> = { open: 0, maintenance: 0, resolved: 0, drafts: 0 };
  for (const i of incidents) counts[tabOf(i)] += 1;
  counts.maintenance = maintenance.filter((m) => m.state === "scheduled" || m.state === "in_progress").length;
  return counts;
}

// --- Time ----------------------------------------------------------------------------

/** "45s", "12m", "2h 05m", "3d 4h"; a dash for none. */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function secondsBetween(from: string, to: Date | string): number {
  return (new Date(to).getTime() - Date.parse(from)) / 1000;
}

/** The median of the known values; null with none. */
export function median(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (!known.length) return null;
  const mid = Math.floor(known.length / 2);
  return known.length % 2 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2;
}

/** A `datetime-local` value, read in the staff member's zone (lib/time.ts); UTC ISO. */
export function utc(raw: string, tz = "UTC"): string | null {
  return fromLocalInput(raw, tz);
}

/** A time as a `datetime-local` value in the staff member's zone: `2026-10-05T07:00`. */
export function localValue(at: Date | string, tz = "UTC"): string {
  return toLocalInput(at, tz);
}

// --- Forms ------------------------------------------------------------------------------

/** Each part's impact from `impact.<key>` selects; an empty choice leaves the part as it is. */
export function readImpacts(form: FormData, keys: string[]): ImpactInput[] {
  const out: ImpactInput[] = [];
  for (const key of keys) {
    const value = form.get(`impact.${key}`);
    const impact = COMPONENT_IMPACTS.find((i) => i.value === value)?.value;
    if (impact) out.push({ key, impact });
  }
  return out;
}

/** Staff addresses for the roles' suggestions: exact addresses in STAFF_EMAILS, and any seen. */
export function staffSuggestions(staffEmails: string, seen: (string | null | undefined)[]): string[] {
  const listed = staffEmails
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+$/.test(e));
  return [...new Set([...listed, ...seen.filter((e): e is string => !!e && e.includes("@")).map((e) => e.toLowerCase())])].sort();
}

/** The chip an incident's phase shows: draft, dismissed, postmortem published, or its status. */
export function phase(i: Pick<AdminIncident, "visibility" | "status" | "postmortem_published_at">): { label: string; tone: Tone } {
  if (i.visibility === "draft") return { label: "Draft", tone: "lavender" };
  if (i.visibility === "dismissed") return { label: "Dismissed", tone: "plain" };
  if (i.postmortem_published_at) return { label: "Postmortem published", tone: "mint" };
  return { label: statusLabel(i.status), tone: STATUS_TONE[i.status] };
}
