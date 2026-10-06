/**
 * Incidents and maintenance as staff run them: checking what sudo sends,
 * and the lifecycle rules (which changes are allowed, which timestamps
 * they set, and what each writes on the timeline). No Workers imports,
 * so it is tested under Node.
 */
import {
  INCIDENT_SEVERITIES,
  type ComponentImpact,
  type DeclareIncident,
  type IncidentChange,
  type IncidentDurations,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentVisibility,
  type ImpactInput,
  type MaintenanceChange,
  type NewMaintenance,
  type PostmortemFields,
  type PublishIncident,
  type RolesChange,
  type TimelineKind,
} from "@g1t/contracts/status";

import { IMPACT_WORD, INCIDENT_STATUS } from "./model.ts";

export const STATUSES: IncidentStatus[] = ["investigating", "identified", "monitoring", "resolved"];
export const IMPACTS: ComponentImpact[] = ["operational", "degraded", "partial_outage", "major_outage"];

export const SEVERITIES = INCIDENT_SEVERITIES;

export const SEVERITY_LABEL = Object.fromEntries(SEVERITIES.map((s) => [s.value, s.label])) as Record<IncidentSeverity, string>;

/** Whether subscribers are emailed by default at a severity. */
export function notifyByDefault(severity: IncidentSeverity): boolean {
  return SEVERITIES.find((s) => s.value === severity)?.notify ?? false;
}

export const MAX_TITLE = 120;
export const MAX_MESSAGE = 4000;
export const MAX_SECTION = 20000;
/** How long maintenance may be scheduled ahead, and how long a window may be. */
export const MAX_AHEAD_DAYS = 180;
export const MAX_WINDOW_HOURS = 72;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function clean(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/** A message keeps its paragraphs; runs of spaces within a line are folded. */
export function cleanMessage(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i;

/** A role's holder: a staff email, lowercased, or null for nobody. */
function role(raw: unknown, name: string): Checked<string | null> {
  const value = clean(raw).toLowerCase();
  if (!value) return { ok: true, value: null };
  if (!EMAIL.test(value)) return fail(`The ${name} is an email address.`);
  return { ok: true, value };
}

function startTime(raw: unknown, now: Date): Checked<string | null> {
  if (raw == null || raw === "") return { ok: true, value: null };
  const at = Date.parse(String(raw));
  if (Number.isNaN(at)) return fail("The start time is not a date.");
  if (at > now.getTime() + 60_000) return fail("The start time is in the future.");
  if (at < now.getTime() - 90 * 24 * 60 * 60 * 1000) return fail("The start time is over 90 days ago.");
  return { ok: true, value: new Date(at).toISOString() };
}

function title(raw: unknown): Checked<string> {
  const value = clean(raw);
  if (!value) return fail("Give it a title.");
  if (value.length > MAX_TITLE) return fail(`Keep the title under ${MAX_TITLE} characters.`);
  return { ok: true, value };
}

function by(raw: unknown): Checked<string> {
  const value = clean(raw);
  return value ? { ok: true, value } : fail("Who is making the change is missing.");
}

/** Parts and their impact: known parts, each once, the last one given winning. */
export function checkImpacts(raw: unknown, known: string[]): Checked<ImpactInput[]> {
  if (!Array.isArray(raw)) return { ok: true, value: [] };
  const byKey = new Map<string, ComponentImpact>();
  for (const item of raw) {
    const key = String((item as ImpactInput)?.key ?? "");
    const impact = (item as ImpactInput)?.impact;
    if (!known.includes(key)) return fail(`Unknown part: ${key || "(none)"}.`);
    if (!IMPACTS.includes(impact)) return fail(`Choose an impact for ${key}.`);
    byKey.set(key, impact);
  }
  return { ok: true, value: [...byKey].map(([key, impact]) => ({ key, impact })) };
}

export function checkDeclare(input: unknown, known: string[], now = new Date()): Checked<DeclareIncident & { started_at: string | null }> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const t = title(raw.title);
  if (!t.ok) return t;
  const severity = raw.severity as IncidentSeverity;
  if (!SEVERITY_LABEL[severity]) return fail("Choose a severity.");
  const status = (raw.status ?? "investigating") as IncidentStatus;
  if (!STATUSES.includes(status) || status === "resolved") return fail("A new incident is investigating, identified or monitoring.");
  const impacts = checkImpacts(raw.components, known);
  if (!impacts.ok) return impacts;
  const affected = impacts.value.filter((c) => c.impact !== "operational");
  if (affected.length === 0) return fail("Choose at least one part it affects, and how.");
  const message = cleanMessage(raw.message);
  if (!message) return fail("Write the first update: what people notice, in a sentence or two.");
  if (message.length > MAX_MESSAGE) return fail(`Keep the update under ${MAX_MESSAGE} characters.`);
  const commander = role(raw.commander, "incident commander");
  if (!commander.ok) return commander;
  const communications = role(raw.communications, "communications lead");
  if (!communications.ok) return communications;
  const who = by(raw.by);
  if (!who.ok) return who;
  const started = startTime(raw.started_at, now);
  if (!started.ok) return started;
  return {
    ok: true,
    value: {
      title: t.value,
      severity,
      status,
      components: affected,
      message,
      started_at: started.value,
      commander: commander.value,
      communications: communications.value,
      notify: raw.notify === true,
      by: who.value,
    },
  };
}

export function checkChange(input: unknown, known: string[]): Checked<IncidentChange> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const message = cleanMessage(raw.message);
  if (message.length > MAX_MESSAGE) return fail(`Keep the update under ${MAX_MESSAGE} characters.`);
  const status = raw.status == null || raw.status === "" ? null : (raw.status as IncidentStatus);
  if (status && !STATUSES.includes(status)) return fail("Choose a status.");
  const severity = raw.severity == null || raw.severity === "" ? null : (raw.severity as IncidentSeverity);
  if (severity && !SEVERITY_LABEL[severity]) return fail("Choose a severity.");
  const impacts = raw.impacts == null ? { ok: true as const, value: null } : checkImpacts(raw.impacts, known);
  if (!impacts.ok) return impacts;
  const who = by(raw.by);
  if (!who.ok) return who;
  const isPublic = raw.public === true;
  if (isPublic && !message) return fail("Write the update the status page will show.");
  return {
    ok: true,
    value: { public: isPublic, message, status, severity, impacts: impacts.value, notify: isPublic && raw.notify === true, by: who.value },
  };
}

export function checkRoles(input: unknown): Checked<RolesChange> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const commander = role(raw.commander, "incident commander");
  if (!commander.ok) return commander;
  const communications = role(raw.communications, "communications lead");
  if (!communications.ok) return communications;
  const who = by(raw.by);
  if (!who.ok) return who;
  return { ok: true, value: { commander: commander.value, communications: communications.value, by: who.value } };
}

export function checkPublish(input: unknown): Checked<PublishIncident> {
  const raw = (input ?? {}) as Record<string, unknown>;
  let name: string | null = null;
  if (raw.title != null && raw.title !== "") {
    const t = title(raw.title);
    if (!t.ok) return t;
    name = t.value;
  }
  const message = cleanMessage(raw.message);
  if (!message) return fail("Write the first update the status page will show.");
  if (message.length > MAX_MESSAGE) return fail(`Keep the update under ${MAX_MESSAGE} characters.`);
  const who = by(raw.by);
  if (!who.ok) return who;
  return { ok: true, value: { title: name, message, notify: raw.notify === true, by: who.value } };
}

export function checkFollowUp(input: unknown): Checked<{ title: string; owner: string | null; by: string }> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = clean(raw.title);
  if (!name) return fail("Say what needs doing.");
  if (name.length > 200) return fail("Keep a follow-up under 200 characters.");
  const owner = role(raw.owner, "owner");
  if (!owner.ok) return owner;
  const who = by(raw.by);
  if (!who.ok) return who;
  return { ok: true, value: { title: name, owner: owner.value, by: who.value } };
}

export const POSTMORTEM_FIELDS: (keyof PostmortemFields)[] = ["summary", "impact", "timeline", "root_cause", "went_well", "went_badly", "action_items"];

export function checkPostmortem(input: unknown): Checked<PostmortemFields & { by: string }> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const fields = {} as PostmortemFields;
  for (const key of POSTMORTEM_FIELDS) {
    const value = cleanMessage(raw[key]);
    if (value.length > MAX_SECTION) return fail(`Keep each section under ${MAX_SECTION} characters.`);
    fields[key] = value;
  }
  const who = by(raw.by);
  if (!who.ok) return who;
  return { ok: true, value: { ...fields, by: who.value } };
}

/** A postmortem can be published once it says what happened and why. */
export function postmortemReady(p: PostmortemFields): string | null {
  if (!p.summary) return "Write a summary before publishing.";
  if (!p.root_cause) return "Say what caused it before publishing.";
  return null;
}

export function checkMaintenance(input: unknown, known: string[], now = new Date()): Checked<NewMaintenance> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const t = title(raw.title);
  if (!t.ok) return t;
  const message = cleanMessage(raw.message);
  if (!message) return fail("Say what will happen and what people will notice.");
  if (message.length > MAX_MESSAGE) return fail(`Keep the message under ${MAX_MESSAGE} characters.`);
  const components = Array.isArray(raw.components) ? [...new Set(raw.components.map(String))] : [];
  const unknown = components.filter((c) => !known.includes(c));
  if (unknown.length) return fail(`Unknown parts: ${unknown.join(", ")}.`);
  if (components.length === 0) return fail("Choose at least one part the work affects.");
  const starts = Date.parse(String(raw.starts_at ?? ""));
  const ends = Date.parse(String(raw.ends_at ?? ""));
  if (Number.isNaN(starts) || Number.isNaN(ends)) return fail("Give the window's start and end.");
  if (ends <= starts) return fail("The window ends after it starts.");
  if (ends <= now.getTime()) return fail("The window is already over.");
  if (starts > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) return fail(`Schedule maintenance at most ${MAX_AHEAD_DAYS} days ahead.`);
  if (ends - starts > MAX_WINDOW_HOURS * 3_600_000) return fail(`Keep a window under ${MAX_WINDOW_HOURS} hours.`);
  const who = by(raw.by);
  if (!who.ok) return who;
  return {
    ok: true,
    value: {
      title: t.value,
      message,
      components,
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(ends).toISOString(),
      notify: raw.notify === true,
      by: who.value,
    },
  };
}

export function checkMaintenanceChange(input: unknown): Checked<MaintenanceChange> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const action = raw.action as MaintenanceChange["action"];
  if (!["update", "start", "complete", "cancel"].includes(action)) return fail("Choose what to do.");
  const message = cleanMessage(raw.message);
  if (action === "update" && !message) return fail("Write the update.");
  if (message.length > MAX_MESSAGE) return fail(`Keep the message under ${MAX_MESSAGE} characters.`);
  const who = by(raw.by);
  if (!who.ok) return who;
  return { ok: true, value: { action, message, notify: raw.notify === true, by: who.value } };
}

// --- Lifecycle -------------------------------------------------------------------

/** What the lifecycle reads and changes on an incident. */
export type IncidentFacts = {
  status: IncidentStatus;
  severity: IncidentSeverity;
  visibility: IncidentVisibility;
  components: ImpactInput[];
  started_at: string;
  acknowledged_at: string | null;
  mitigated_at: string | null;
  resolved_at: string | null;
  commander: string | null;
  communications: string | null;
};

/** A line the change writes on the timeline. */
export type Entry = { kind: TimelineKind; public: boolean; status: IncidentStatus | null; text: string };

const ORDER: Record<IncidentStatus, number> = { investigating: 0, identified: 1, monitoring: 2, resolved: 3 };

/**
 * Applies an update, a note, or changes. The rules:
 *
 * - A dismissed incident is closed for good.
 * - A draft takes notes and changes, but nothing public until it is published.
 * - On a published incident, a status change is said publicly: the status page
 *   shows each status with words.
 * - Reaching monitoring (or resolved) marks it mitigated; resolved marks it
 *   resolved; leaving resolved reopens it and clears that.
 * - The first change by a person acknowledges a detected incident.
 */
export function applyChange(
  facts: IncidentFacts,
  change: IncidentChange,
  now: Date,
  names: Map<string, string> = new Map(),
): Checked<{ next: IncidentFacts; entries: Entry[] }> {
  if (facts.visibility === "dismissed") return fail("This draft was dismissed; declare a new incident instead.");
  if (change.public && facts.visibility === "draft") return fail("Publish the draft before posting public updates.");
  const at = now.toISOString();
  const next: IncidentFacts = { ...facts, components: facts.components.map((c) => ({ ...c })) };
  const entries: Entry[] = [];

  const status = change.status && change.status !== facts.status ? change.status : null;
  if (status && facts.visibility === "public" && !change.public) {
    return fail("Changing the status of a published incident is a public update: say what changed for the status page.");
  }
  if (!status && !change.severity && !change.impacts?.length && !change.message) return fail("Nothing to post: write an update or change something.");

  if (!next.acknowledged_at) {
    next.acknowledged_at = at;
    entries.push({ kind: "acknowledged", public: false, status: null, text: "Acknowledged." });
  }
  if (change.severity && change.severity !== facts.severity) {
    entries.push({
      kind: "severity",
      public: false,
      status: null,
      text: `Severity ${SEVERITY_LABEL[facts.severity]} → ${SEVERITY_LABEL[change.severity]}.`,
    });
    next.severity = change.severity;
  }
  for (const { key, impact } of change.impacts ?? []) {
    const index = next.components.findIndex((c) => c.key === key);
    const before = index >= 0 ? next.components[index]!.impact : "operational";
    if (before === impact) continue;
    if (index >= 0) next.components[index]!.impact = impact;
    else next.components.push({ key, impact });
    entries.push({ kind: "impact", public: false, status: null, text: `${names.get(key) ?? key}: ${IMPACT_WORD[before]} → ${IMPACT_WORD[impact]}.` });
  }
  if (status) {
    const reopening = facts.status === "resolved";
    entries.push({
      kind: "status",
      public: false,
      status,
      text: reopening ? `Reopened: ${INCIDENT_STATUS[status]}.` : `${INCIDENT_STATUS[facts.status]} → ${INCIDENT_STATUS[status]}.`,
    });
    next.status = status;
    if (ORDER[status] >= ORDER.monitoring && !next.mitigated_at) next.mitigated_at = at;
    if (status === "resolved") next.resolved_at = at;
    if (reopening) next.resolved_at = null;
  }
  if (change.message) {
    entries.push({ kind: change.public ? "update" : "note", public: change.public, status: change.public ? next.status : null, text: change.message });
  }
  return { ok: true, value: { next, entries } };
}

/** A change of roles, and the lines it writes. */
export function applyRoles(facts: IncidentFacts, change: RolesChange, now: Date): { next: IncidentFacts; entries: Entry[] } {
  const next = { ...facts };
  const entries: Entry[] = [];
  if (!next.acknowledged_at) {
    next.acknowledged_at = now.toISOString();
    entries.push({ kind: "acknowledged", public: false, status: null, text: "Acknowledged." });
  }
  const say = (who: string | null) => who ?? "nobody";
  if (change.commander !== facts.commander) {
    entries.push({ kind: "role", public: false, status: null, text: `Incident commander: ${say(change.commander)}.` });
    next.commander = change.commander;
  }
  if (change.communications !== facts.communications) {
    entries.push({ kind: "role", public: false, status: null, text: `Communications: ${say(change.communications)}.` });
    next.communications = change.communications;
  }
  return { next, entries };
}

/** Seconds from the impact starting to each milestone. */
export function durations(i: Pick<IncidentFacts, "started_at" | "acknowledged_at" | "mitigated_at" | "resolved_at">): IncidentDurations {
  const start = Date.parse(i.started_at);
  const since = (at: string | null) => (at ? Math.max(0, Math.round((Date.parse(at) - start) / 1000)) : null);
  return { to_acknowledge: since(i.acknowledged_at), to_mitigate: since(i.mitigated_at), to_resolve: since(i.resolved_at) };
}

/** "45s", "12m", "2h 05m", "3d 4h". */
export function duration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A short random id for a permalink: ten lowercase letters and digits. */
export function shortId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...random(10)].map((b) => alphabet[b % alphabet.length]).join("");
}
