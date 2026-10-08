/**
 * The status page at status.g1t.sh (apps/status): what its JSON and feeds
 * say, and the staff-only entrypoint sudo runs incidents, maintenance and
 * postmortems through. Fields are snake_case, like the API.
 */
import type { Result } from "./result";

/**
 * One part's state. Its last check, made worse by an open incident's
 * impact on it, or `maintenance` during a maintenance window.
 * `unmonitored`: no check exists for it and nothing is reported.
 */
export type StatusComponentState = "up" | "degraded" | "partial" | "down" | "maintenance" | "unmonitored";

/** The whole of g1t, in one word. `unknown` until anything has been checked. */
export type StatusOverallState = "up" | "degraded" | "down" | "maintenance" | "unknown";

/** Where an incident stands, in the words status pages use. */
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

/** How bad an incident is, for the team: SEV1 is the worst. Never shown on the status page. */
export type IncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4";

/** What an incident does to one part, while it is open. */
export type ComponentImpact = "operational" | "degraded" | "partial_outage" | "major_outage";

/** An incident's impact as a whole: some parts having trouble, or a major outage. */
export type IncidentImpact = "degraded" | "down";

export type StatusComponent = {
  key: string;
  name: string;
  /** Where people meet it: `api.g1t.sh`. */
  address: string;
  /** What the check looks at, said plainly. */
  checks: string;
  /** What the page shows: the check, an incident's impact (the worse wins), or maintenance. */
  state: StatusComponentState;
  /** What the last check alone said. */
  check_state: StatusComponentState;
  /** What was seen: "Answered in 84 ms", "Failed: HTTP 502". */
  detail: string;
  latency_ms: number | null;
  /** Share of checks that answered over the last 90 days, 0 to 100. Null with no checks yet. */
  uptime_90d: number | null;
};

export type StatusIncidentUpdate = {
  id: string;
  at: string;
  status: IncidentStatus;
  text: string;
};

export type StatusIncident = {
  id: string;
  title: string;
  /** `down` when any part has a major outage. */
  impact: IncidentImpact;
  status: IncidentStatus;
  /** Keys of the parts it affects. */
  components: string[];
  /** What it does to each part. */
  component_impacts: { key: string; impact: ComponentImpact }[];
  started_at: string;
  /** Null while it is still going on. */
  resolved_at: string | null;
  /** Its page: `https://status.g1t.sh/incidents/<id>`. */
  url: string;
  /** When its postmortem was published on that page; null until then. */
  postmortem_published_at: string | null;
  /** Newest first. */
  updates: StatusIncidentUpdate[];
};

export type MaintenanceState = "scheduled" | "in_progress" | "completed" | "cancelled";

export type StatusMaintenanceUpdate = { id: string; at: string; text: string };

/** Planned work, announced ahead. Its parts show "Under maintenance" during the window. */
export type StatusMaintenance = {
  id: string;
  title: string;
  message: string;
  components: string[];
  /** The window, RFC 3339, UTC. */
  starts_at: string;
  ends_at: string;
  state: MaintenanceState;
  url: string;
  /** Newest first. */
  updates: StatusMaintenanceUpdate[];
};

export type StatusOverall = {
  state: StatusOverallState;
  /** Two or three words: "All systems normal", "Partial outage", "Major outage". */
  title: string;
  /** One sentence, naming what is affected. */
  line: string;
};

/** `GET status.g1t.sh/status.json`. */
export type StatusReport = {
  /** When the parts were last checked; null before the first check. */
  checked_at: string | null;
  overall: StatusOverall;
  components: StatusComponent[];
  /** Open incidents, and those resolved in the last 90 days, newest first. */
  incidents: StatusIncident[];
  /** Maintenance under way or still to come, soonest first. */
  maintenance: StatusMaintenance[];
};

// --- Staff ---------------------------------------------------------------------

/** `draft`: detected or saved, not on the page yet. `dismissed`: a draft closed as a false alarm. */
export type IncidentVisibility = "draft" | "public" | "dismissed";

/** What a line on an incident's timeline records. */
export type TimelineKind =
  | "declared"
  | "detected"
  | "published"
  | "dismissed"
  /** A public update: what the status page shows. */
  | "update"
  /** A note only staff see. */
  | "note"
  | "status"
  | "severity"
  | "impact"
  | "role"
  | "acknowledged"
  /** A check flipped back to working while the incident was open. */
  | "recovered"
  /** A check kept failing while the incident was open. */
  | "failing"
  | "followup"
  | "postmortem";

export type TimelineEntry = {
  id: string;
  at: string;
  /** A staff email, or `status` for what the checks wrote. */
  by: string;
  kind: TimelineKind;
  /** Shown on the status page. */
  public: boolean;
  /** For public updates: the status it was posted with. */
  status: IncidentStatus | null;
  text: string;
  /** How many subscribers it was emailed to; null when it was not. */
  notified: number | null;
};

export type FollowUp = {
  id: string;
  title: string;
  owner: string | null;
  done_at: string | null;
  created_at: string;
  created_by: string;
};

export type PostmortemFields = {
  summary: string;
  impact: string;
  timeline: string;
  root_cause: string;
  went_well: string;
  went_badly: string;
  /** What will change, one per line; filled in from the follow-ups. */
  action_items: string;
};

export type Postmortem = PostmortemFields & {
  updated_at: string;
  updated_by: string;
  published_at: string | null;
};

/** Seconds from the impact starting to each milestone, once reached. */
export type IncidentDurations = {
  to_acknowledge: number | null;
  to_mitigate: number | null;
  to_resolve: number | null;
};

export type AdminIncident = {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  visibility: IncidentVisibility;
  /** Declared by staff, or drafted when a check kept failing. */
  source: "declared" | "detected";
  components: { key: string; impact: ComponentImpact }[];
  /** When the impact began (can be earlier than declared). */
  started_at: string;
  declared_at: string;
  acknowledged_at: string | null;
  mitigated_at: string | null;
  resolved_at: string | null;
  published_at: string | null;
  commander: string | null;
  communications: string | null;
  created_by: string;
  postmortem_published_at: string | null;
  durations: IncidentDurations;
  /** Follow-ups open and done. */
  followups_open: number;
  followups_done: number;
  /** The last public update's time, for "updated 12 minutes ago". */
  last_update_at: string | null;
};

export type AdminIncidentDetail = AdminIncident & {
  /** Oldest first: public updates, notes and what changed. */
  timeline: TimelineEntry[];
  followups: FollowUp[];
  postmortem: Postmortem | null;
  /** What the postmortem editor starts from before anything is saved: the timeline filled in, follow-ups listed. */
  postmortem_draft: PostmortemFields;
  /** Its page on the status site. */
  url: string;
  /**
   * Every check of each of its parts around it, for the latency chart:
   * from 30 minutes before it began to 30 minutes after it ended (or now),
   * at most a day of it. Checks are kept for 7 days, so an older incident
   * has none.
   */
  checks: CheckHistory[];
};

/** One check of one part, as the status worker keeps it (7 days). */
export type CheckSample = {
  component: string;
  at: string;
  /** How long it took; null when it took no time to speak of (a part with no check). */
  ms: number | null;
  outcome: "up" | "degraded" | "down";
  /** The Cloudflare data centre the check ran from, from the answer's cf-ray; null when unknown. */
  colo: string | null;
  /** When the first try was slow and it was asked again at once: the first try's time. */
  first_ms: number | null;
};

/** One part's checks over a span, and the time over which an answer counts as slow. */
export type CheckHistory = {
  key: string;
  /** Slower than this counts as degraded; null when not known. */
  slow_ms: number | null;
  from: string;
  to: string;
  /** Oldest first. */
  samples: CheckSample[];
};

export type AdminMaintenance = StatusMaintenance & { created_at: string; created_by: string };

/** One line of the status worker's audit log: every staff change, with who made it. */
export type StatusAuditEntry = { id: string; at: string; by: string; action: string; target: string; detail: string };

export type ImpactInput = { key: string; impact: ComponentImpact };

export type DeclareIncident = {
  title: string;
  severity: IncidentSeverity;
  status?: IncidentStatus;
  components: ImpactInput[];
  /** The first public update. */
  message: string;
  /** When the impact began, if earlier than now. RFC 3339. */
  started_at?: string | null;
  commander?: string | null;
  communications?: string | null;
  /** Email subscribers about it. */
  notify: boolean;
  /** The staff member's email, kept with every line. */
  by: string;
};

/** An update, a note, or a change, posted together. */
export type IncidentChange = {
  /** Shown on the status page (and emailed when `notify`), or a note only staff see. */
  public: boolean;
  message: string;
  status?: IncidentStatus | null;
  severity?: IncidentSeverity | null;
  /** The parts' impact from now on; parts left out keep theirs. */
  impacts?: ImpactInput[] | null;
  notify?: boolean;
  by: string;
};

export type RolesChange = { commander: string | null; communications: string | null; by: string };

/** Putting a draft on the status page, with its first public update. */
export type PublishIncident = { title?: string | null; message: string; notify: boolean; by: string };

export type NewMaintenance = {
  title: string;
  message: string;
  components: string[];
  starts_at: string;
  ends_at: string;
  notify: boolean;
  by: string;
};

export type MaintenanceChange = {
  /** `update` posts a message; the others also move it along. */
  action: "update" | "start" | "complete" | "cancel";
  message: string;
  notify: boolean;
  by: string;
};

export type StatusBoard = {
  /** Open and draft incidents, and those resolved in the last 180 days, newest first. */
  incidents: AdminIncident[];
  /** Upcoming, under way, and finished in the last 90 days. */
  maintenance: AdminMaintenance[];
  /** Confirmed email subscribers. */
  subscribers: number;
  /** Whether the status worker can send email (a sender and a token secret). */
  email: boolean;
};

/**
 * The status worker's `StatusAdmin` entrypoint. Only a service binding
 * reaches it (sudo's `STATUS`); status.g1t.sh itself has no way to write.
 * Every change is kept in its audit log with `by`.
 */
export interface StatusAdminApi {
  /** The parts the page lists, for choosing which an incident affects. */
  components(): Promise<{ key: string; name: string }[]>;
  board(): Promise<StatusBoard>;
  incident(id: string): Promise<AdminIncidentDetail | null>;
  /** Open incidents, drafts included: the sidebar's count. */
  openCount(): Promise<number>;
  declare(input: DeclareIncident): Promise<Result<AdminIncident>>;
  update(id: string, change: IncidentChange): Promise<Result<AdminIncident>>;
  roles(id: string, change: RolesChange): Promise<Result<AdminIncident>>;
  publish(id: string, input: PublishIncident): Promise<Result<AdminIncident>>;
  dismiss(id: string, input: { reason: string; by: string }): Promise<Result<AdminIncident>>;
  addFollowUp(id: string, input: { title: string; owner: string | null; by: string }): Promise<Result<FollowUp>>;
  setFollowUp(id: string, followUp: string, input: { done: boolean; by: string }): Promise<Result<FollowUp>>;
  savePostmortem(id: string, input: PostmortemFields & { by: string }): Promise<Result<Postmortem>>;
  publishPostmortem(id: string, input: { publish: boolean; by: string }): Promise<Result<Postmortem>>;
  scheduleMaintenance(input: NewMaintenance): Promise<Result<AdminMaintenance>>;
  changeMaintenance(id: string, change: MaintenanceChange): Promise<Result<AdminMaintenance>>;
  /** Newest first, 100 at a time, before `before`. */
  audit(filter?: { before?: string | null }): Promise<StatusAuditEntry[]>;
}

// --- Words both sides use ------------------------------------------------------------

/** What each severity means, for the team. Never shown on the status page. */
export const INCIDENT_SEVERITIES: { value: IncidentSeverity; label: string; about: string; notify: boolean }[] = [
  {
    value: "sev1",
    label: "SEV1",
    about: "Critical: g1t is down or unusable for most people, or data is at risk. Everyone on it; a public update at least every 30 minutes.",
    notify: true,
  },
  {
    value: "sev2",
    label: "SEV2",
    about: "Major: a core part (sign-in, git, the API, agents) is broken or badly degraded for many people. A public update at least hourly.",
    notify: true,
  },
  { value: "sev3", label: "SEV3", about: "Minor: one part is degraded or broken for some people, and there is a way around it.", notify: false },
  { value: "sev4", label: "SEV4", about: "Low: little or no customer impact, such as a cosmetic fault or a risk caught before anyone noticed.", notify: false },
];

export const INCIDENT_STATUSES: { value: IncidentStatus; label: string; about: string }[] = [
  { value: "investigating", label: "Investigating", about: "Something is wrong; the cause is not known yet." },
  { value: "identified", label: "Identified", about: "The cause is known and a fix is under way." },
  { value: "monitoring", label: "Monitoring", about: "A fix is out; watching that it holds." },
  { value: "resolved", label: "Resolved", about: "Over. Closes the incident." },
];

export const COMPONENT_IMPACTS: { value: ComponentImpact; label: string }[] = [
  { value: "operational", label: "Operational" },
  { value: "degraded", label: "Degraded performance" },
  { value: "partial_outage", label: "Partial outage" },
  { value: "major_outage", label: "Major outage" },
];
