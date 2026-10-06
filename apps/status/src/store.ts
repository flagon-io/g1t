/**
 * The status page's D1 database: each part's last check and daily tally
 * (migrations/0001), and incidents, maintenance, postmortems, subscribers,
 * detection and the audit log (migrations/0002).
 */
import type {
  AdminIncident,
  AdminIncidentDetail,
  AdminMaintenance,
  ComponentImpact,
  FollowUp,
  ImpactInput,
  IncidentSeverity,
  IncidentStatus,
  IncidentVisibility,
  MaintenanceState,
  Postmortem,
  PostmortemFields,
  StatusAuditEntry,
  StatusIncident,
  StatusMaintenance,
  TimelineEntry,
  TimelineKind,
} from "@g1t/contracts";

import type { Streak } from "./detect.ts";
import { type Entry, type IncidentFacts, durations, shortId } from "./incidents.ts";
import { type Current, type DayRow, HISTORY_DAYS, dayOf, overallImpact } from "./model.ts";
import { postmortemDraft } from "./postmortem.ts";
import { parseParts, wants } from "./subscribers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One part's check, ready to keep. */
export type Observation = Current & { component: string };

/**
 * Keeps one round of checks: each part's state, today's tally, and the
 * time. Parts under maintenance keep their last check but are left out of
 * the tally: failures in a planned window do not count against uptime.
 */
export async function record(db: D1Database, observations: Observation[], at: Date, maintenance: Set<string> = new Set()): Promise<void> {
  const when = at.toISOString();
  const day = dayOf(at);
  const oldest = dayOf(at.getTime() - HISTORY_DAYS * DAY_MS);
  const statements: D1PreparedStatement[] = [];
  for (const o of observations) {
    statements.push(
      db
        .prepare(
          `INSERT INTO current (component, state, detail, latency_ms, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (component) DO UPDATE SET state = ?2, detail = ?3, latency_ms = ?4, checked_at = ?5`,
        )
        .bind(o.component, o.state, o.detail, o.latency_ms, when),
    );
    if (o.state === "unmonitored" || maintenance.has(o.component)) continue;
    const up = o.state === "up" ? 1 : 0;
    const degraded = o.state === "degraded" ? 1 : 0;
    const down = o.state === "down" ? 1 : 0;
    // A latency only counts when it answered: a timeout is not a speed.
    const latency = o.state !== "down" && o.latency_ms != null ? o.latency_ms : 0;
    const counted = o.state !== "down" && o.latency_ms != null ? 1 : 0;
    statements.push(
      db
        .prepare(
          `INSERT INTO daily (component, day, checks, up, degraded, down, latency_total, latency_count)
           VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (component, day) DO UPDATE SET
             checks = checks + 1, up = up + ?3, degraded = degraded + ?4, down = down + ?5,
             latency_total = latency_total + ?6, latency_count = latency_count + ?7`,
        )
        .bind(o.component, day, up, degraded, down, latency, counted),
    );
  }
  statements.push(
    db.prepare(`INSERT INTO meta (key, value) VALUES ('checked_at', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1`).bind(when),
  );
  statements.push(db.prepare(`DELETE FROM daily WHERE day < ?1`).bind(oldest));
  await db.batch(statements);
}

// --- Rows ------------------------------------------------------------------------

type IncidentRow = {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  visibility: IncidentVisibility;
  source: "declared" | "detected";
  started_at: string;
  declared_at: string;
  acknowledged_at: string | null;
  mitigated_at: string | null;
  resolved_at: string | null;
  published_at: string | null;
  commander: string | null;
  communications: string | null;
  created_by: string;
};
type ComponentRow = { incident_id: string; component: string; impact: ComponentImpact };
type TimelineRow = {
  id: string;
  incident_id: string;
  at: string;
  by: string;
  kind: TimelineKind;
  public: number;
  status: IncidentStatus | null;
  text: string;
  notified: number | null;
};
type FollowUpRow = FollowUp & { incident_id: string };
type PostmortemRow = PostmortemFields & { incident_id: string; updated_at: string; updated_by: string; published_at: string | null };
type MaintenanceRow = {
  id: string;
  title: string;
  message: string;
  components: string;
  starts_at: string;
  ends_at: string;
  state: MaintenanceState;
  notify: number;
  created_at: string;
  created_by: string;
};
type MaintenanceUpdateRow = { id: string; maintenance_id: string; at: string; by: string; text: string; notified: number | null };

function keys(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

const rows = <T>(result: D1Result | undefined) => (result?.results ?? []) as T[];

/** `in (?, ?, ?)` for a list, as bind arguments. */
function inList(ids: string[]): string {
  return ids.map(() => "?").join(", ") || "NULL";
}

export function incidentUrl(origin: string, id: string): string {
  return `${origin}/incidents/${id}`;
}

export function maintenanceUrl(origin: string, id: string): string {
  return `${origin}/maintenance/${id}`;
}

function components(id: string, all: ComponentRow[]): ImpactInput[] {
  return all.filter((c) => c.incident_id === id).map((c) => ({ key: c.component, impact: c.impact }));
}

function toAdmin(row: IncidentRow, comps: ComponentRow[], timeline: TimelineRow[], followups: FollowUpRow[], pm: PostmortemRow | null): AdminIncident {
  const mine = followups.filter((f) => f.incident_id === row.id);
  const lastUpdate = timeline.filter((t) => t.incident_id === row.id && t.public === 1).reduce<string | null>((a, t) => (a && a > t.at ? a : t.at), null);
  return {
    id: row.id,
    title: row.title,
    severity: row.severity,
    status: row.status,
    visibility: row.visibility,
    source: row.source,
    components: components(row.id, comps),
    started_at: row.started_at,
    declared_at: row.declared_at,
    acknowledged_at: row.acknowledged_at,
    mitigated_at: row.mitigated_at,
    resolved_at: row.resolved_at,
    published_at: row.published_at,
    commander: row.commander,
    communications: row.communications,
    created_by: row.created_by,
    postmortem_published_at: pm?.published_at ?? null,
    durations: durations(row),
    followups_open: mine.filter((f) => !f.done_at).length,
    followups_done: mine.filter((f) => f.done_at).length,
    last_update_at: lastUpdate,
  };
}

function toPublic(row: IncidentRow, comps: ComponentRow[], timeline: TimelineRow[], origin: string, pmPublished: string | null): StatusIncident {
  const impacts = components(row.id, comps).filter((c) => c.impact !== "operational");
  return {
    id: row.id,
    title: row.title,
    impact: overallImpact(impacts),
    status: row.status,
    components: impacts.map((c) => c.key),
    component_impacts: impacts,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    url: incidentUrl(origin, row.id),
    postmortem_published_at: pmPublished,
    updates: timeline
      .filter((t) => t.incident_id === row.id && t.public === 1)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((t) => ({ id: t.id, at: t.at, status: t.status ?? row.status, text: t.text })),
  };
}

function toTimeline(t: TimelineRow): TimelineEntry {
  return { id: t.id, at: t.at, by: t.by, kind: t.kind, public: t.public === 1, status: t.status, text: t.text, notified: t.notified };
}

function toMaintenance(row: MaintenanceRow, updates: MaintenanceUpdateRow[], origin: string): AdminMaintenance {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    components: keys(row.components),
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    state: row.state,
    url: maintenanceUrl(origin, row.id),
    updates: updates
      .filter((u) => u.maintenance_id === row.id)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((u) => ({ id: u.id, at: u.at, text: u.text })),
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

/** The public view of maintenance: no staff emails. */
export function publicMaintenance(m: AdminMaintenance): StatusMaintenance {
  const { created_at: _a, created_by: _b, ...rest } = m;
  return rest;
}

// --- Public reads ------------------------------------------------------------------

/** Public incidents matching `where`, with their parts and public updates. */
async function publicIncidents(db: D1Database, where: string, args: unknown[], origin: string): Promise<StatusIncident[]> {
  const list = rows<IncidentRow>(
    (await db.prepare(`SELECT * FROM incident WHERE visibility = 'public' AND (${where}) ORDER BY started_at DESC LIMIT 500`).bind(...args).all()) as D1Result,
  );
  if (!list.length) return [];
  const ids = list.map((i) => i.id);
  const [comps, timeline, pms] = await db.batch([
    db.prepare(`SELECT * FROM incident_component WHERE incident_id IN (${inList(ids)})`).bind(...ids),
    db.prepare(`SELECT * FROM incident_timeline WHERE public = 1 AND incident_id IN (${inList(ids)})`).bind(...ids),
    db.prepare(`SELECT incident_id, published_at FROM postmortem WHERE published_at IS NOT NULL AND incident_id IN (${inList(ids)})`).bind(...ids),
  ]);
  const published = new Map(rows<{ incident_id: string; published_at: string }>(pms).map((p) => [p.incident_id, p.published_at]));
  return list.map((row) => toPublic(row, rows(comps), rows(timeline), origin, published.get(row.id) ?? null));
}

async function maintenanceWhere(db: D1Database, where: string, args: unknown[], origin: string): Promise<AdminMaintenance[]> {
  const list = rows<MaintenanceRow>((await db.prepare(`SELECT * FROM maintenance WHERE ${where} ORDER BY starts_at DESC LIMIT 500`).bind(...args).all()) as D1Result);
  if (!list.length) return [];
  const ids = list.map((m) => m.id);
  const updates = rows<MaintenanceUpdateRow>(
    (await db.prepare(`SELECT * FROM maintenance_update WHERE maintenance_id IN (${inList(ids)})`).bind(...ids).all()) as D1Result,
  );
  return list.map((m) => toMaintenance(m, updates, origin));
}

/** Everything the front page reads. */
export async function load(db: D1Database, now: Date, origin: string) {
  const since = dayOf(now.getTime() - HISTORY_DAYS * DAY_MS);
  const [current, meta, days] = await db.batch([
    db.prepare(`SELECT component, state, detail, latency_ms FROM current`),
    db.prepare(`SELECT value FROM meta WHERE key = 'checked_at'`),
    db.prepare(`SELECT * FROM daily WHERE day >= ?1`).bind(since),
  ]);
  const [incidents, maintenance] = await Promise.all([
    publicIncidents(db, `resolved_at IS NULL OR resolved_at >= ?1`, [iso(now.getTime() - HISTORY_DAYS * DAY_MS)], origin),
    maintenanceWhere(db, `state IN ('scheduled', 'in_progress')`, [], origin),
  ]);
  const currentRows = rows<Current & { component: string }>(current);
  return {
    current: new Map(currentRows.map((row) => [row.component, { state: row.state, detail: row.detail, latency_ms: row.latency_ms }])),
    checkedAt: (rows<{ value?: string }>(meta)[0]?.value ?? null) as string | null,
    days: rows<DayRow>(days),
    incidents,
    maintenance: maintenance.map(publicMaintenance),
  };
}

/** One public incident, with its postmortem once published. */
export async function loadPublicIncident(db: D1Database, id: string, origin: string) {
  const [incident] = await publicIncidents(db, `id = ?1`, [id], origin);
  if (!incident) return null;
  const pm = (await db.prepare(`SELECT * FROM postmortem WHERE incident_id = ?1 AND published_at IS NOT NULL`).bind(id).first()) as PostmortemRow | null;
  return { incident, postmortem: pm };
}

export async function loadPublicMaintenance(db: D1Database, id: string, origin: string): Promise<StatusMaintenance | null> {
  const [m] = await maintenanceWhere(db, `id = ?1`, [id], origin);
  return m ? publicMaintenance(m) : null;
}

/** Incidents and finished maintenance since `since`, for the history page and the feeds. */
export async function loadHistory(db: D1Database, since: Date, origin: string) {
  const at = since.toISOString();
  const [incidents, maintenance] = await Promise.all([
    publicIncidents(db, `started_at >= ?1 OR resolved_at IS NULL`, [at], origin),
    maintenanceWhere(db, `starts_at >= ?1 OR state IN ('scheduled', 'in_progress')`, [at], origin),
  ]);
  return { incidents, maintenance: maintenance.map(publicMaintenance) };
}

// --- Staff reads -------------------------------------------------------------------

async function adminIncidents(db: D1Database, where: string, args: unknown[]): Promise<{ list: IncidentRow[]; comps: ComponentRow[]; timeline: TimelineRow[]; followups: FollowUpRow[]; pms: PostmortemRow[] }> {
  const list = rows<IncidentRow>((await db.prepare(`SELECT * FROM incident WHERE ${where} ORDER BY started_at DESC LIMIT 500`).bind(...args).all()) as D1Result);
  if (!list.length) return { list, comps: [], timeline: [], followups: [], pms: [] };
  const ids = list.map((i) => i.id);
  const [comps, timeline, followups, pms] = await db.batch([
    db.prepare(`SELECT * FROM incident_component WHERE incident_id IN (${inList(ids)})`).bind(...ids),
    db.prepare(`SELECT * FROM incident_timeline WHERE incident_id IN (${inList(ids)}) ORDER BY at, rowid`).bind(...ids),
    db.prepare(`SELECT * FROM incident_followup WHERE incident_id IN (${inList(ids)}) ORDER BY created_at, rowid`).bind(...ids),
    db.prepare(`SELECT * FROM postmortem WHERE incident_id IN (${inList(ids)})`).bind(...ids),
  ]);
  return { list, comps: rows(comps), timeline: rows(timeline), followups: rows(followups), pms: rows(pms) };
}

/** Sudo's board: open and draft incidents, the last 180 days, maintenance, and subscribers. */
export async function board(db: D1Database, now: Date, origin: string) {
  const since = iso(now.getTime() - 180 * DAY_MS);
  const [data, maintenance, count] = await Promise.all([
    adminIncidents(db, `resolved_at IS NULL OR resolved_at >= ?1`, [since]),
    maintenanceWhere(db, `state IN ('scheduled', 'in_progress') OR ends_at >= ?1`, [iso(now.getTime() - HISTORY_DAYS * DAY_MS)], origin),
    db.prepare(`SELECT COUNT(*) AS n FROM subscriber WHERE confirmed_at IS NOT NULL`).first<{ n: number }>(),
  ]);
  return {
    incidents: data.list.map((row) => toAdmin(row, data.comps, data.timeline, data.followups, data.pms.find((p) => p.incident_id === row.id) ?? null)),
    maintenance,
    subscribers: count?.n ?? 0,
  };
}

export async function openCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM incident WHERE resolved_at IS NULL AND visibility IN ('draft', 'public')`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function incidentDetail(db: D1Database, id: string, origin: string, names: Map<string, string>): Promise<AdminIncidentDetail | null> {
  const data = await adminIncidents(db, `id = ?1`, [id]);
  const row = data.list[0];
  if (!row) return null;
  const pmRow = data.pms[0] ?? null;
  const incident = toAdmin(row, data.comps, data.timeline, data.followups, pmRow);
  const timeline = data.timeline.map(toTimeline);
  const followups: FollowUp[] = data.followups.map(({ incident_id: _, ...f }) => ({
    id: f.id,
    title: f.title,
    owner: f.owner,
    done_at: f.done_at,
    created_at: f.created_at,
    created_by: f.created_by,
  }));
  const postmortem: Postmortem | null = pmRow
    ? {
        summary: pmRow.summary,
        impact: pmRow.impact,
        timeline: pmRow.timeline,
        root_cause: pmRow.root_cause,
        went_well: pmRow.went_well,
        went_badly: pmRow.went_badly,
        action_items: pmRow.action_items,
        updated_at: pmRow.updated_at,
        updated_by: pmRow.updated_by,
        published_at: pmRow.published_at,
      }
    : null;
  return {
    ...incident,
    timeline,
    followups,
    postmortem,
    postmortem_draft: postmortemDraft(incident, timeline, followups, names),
    url: incidentUrl(origin, id),
  };
}

export function facts(i: AdminIncident): IncidentFacts {
  return {
    status: i.status,
    severity: i.severity,
    visibility: i.visibility,
    components: i.components,
    started_at: i.started_at,
    acknowledged_at: i.acknowledged_at,
    mitigated_at: i.mitigated_at,
    resolved_at: i.resolved_at,
    commander: i.commander,
    communications: i.communications,
  };
}

export async function maintenanceById(db: D1Database, id: string, origin: string): Promise<AdminMaintenance | null> {
  return (await maintenanceWhere(db, `id = ?1`, [id], origin))[0] ?? null;
}

// --- Writes ------------------------------------------------------------------------

export function auditStatement(db: D1Database, at: string, by: string, action: string, target: string, detail: string): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit (id, at, by, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(crypto.randomUUID(), at, by, action, target, detail.slice(0, 500));
}

/** Timeline lines, written a millisecond apart so their order survives. */
function timelineStatements(db: D1Database, incident: string, entries: (Entry & { notified?: number | null })[], at: Date, by: string): D1PreparedStatement[] {
  return entries.map((e, i) =>
    db
      .prepare(`INSERT INTO incident_timeline (id, incident_id, at, by, kind, public, status, text, notified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(shortId(), incident, iso(at.getTime() + i), by, e.kind, e.public ? 1 : 0, e.status, e.text, e.notified ?? null),
  );
}

function componentStatements(db: D1Database, incident: string, list: ImpactInput[]): D1PreparedStatement[] {
  return list.map((c) =>
    db
      .prepare(`INSERT INTO incident_component (incident_id, component, impact) VALUES (?1, ?2, ?3) ON CONFLICT (incident_id, component) DO UPDATE SET impact = ?3`)
      .bind(incident, c.key, c.impact),
  );
}

export type NewIncidentRow = {
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  visibility: IncidentVisibility;
  source: "declared" | "detected";
  components: ImpactInput[];
  started_at: string;
  acknowledged_at: string | null;
  commander: string | null;
  communications: string | null;
  by: string;
};

/** A new incident with its first lines. Returns its id. */
export async function createIncident(
  db: D1Database,
  input: NewIncidentRow,
  entries: (Entry & { notified?: number | null })[],
  now: Date,
  audit: { action: string; detail: string } | null,
  id = shortId(),
): Promise<string> {
  const at = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO incident (id, title, severity, status, visibility, source, started_at, declared_at, acknowledged_at, published_at, commander, communications, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        id,
        input.title,
        input.severity,
        input.status,
        input.visibility,
        input.source,
        input.started_at,
        at,
        input.acknowledged_at,
        input.visibility === "public" ? at : null,
        input.commander,
        input.communications,
        input.by,
      ),
    ...componentStatements(db, id, input.components),
    ...timelineStatements(db, id, entries, now, input.by),
    ...(audit ? [auditStatement(db, at, input.by, audit.action, id, audit.detail)] : []),
  ]);
  return id;
}

/** Saves an incident's changed facts and the lines that say so. */
export async function saveIncident(
  db: D1Database,
  id: string,
  next: IncidentFacts & { title?: string; published_at?: string | null },
  entries: (Entry & { notified?: number | null })[],
  now: Date,
  by: string,
  audit: { action: string; detail: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE incident SET status = ?2, severity = ?3, visibility = ?4, acknowledged_at = ?5, mitigated_at = ?6, resolved_at = ?7,
           commander = ?8, communications = ?9, title = COALESCE(?10, title), published_at = COALESCE(published_at, ?11) WHERE id = ?1`,
      )
      .bind(
        id,
        next.status,
        next.severity,
        next.visibility,
        next.acknowledged_at,
        next.mitigated_at,
        next.resolved_at,
        next.commander,
        next.communications,
        next.title ?? null,
        next.published_at ?? null,
      ),
    ...componentStatements(db, id, next.components),
    ...timelineStatements(db, id, entries, now, by),
    auditStatement(db, now.toISOString(), by, audit.action, id, audit.detail),
  ]);
}

/** Lines the checks write on open incidents: failing again, or answering again. */
export async function addSystemLines(db: D1Database, lines: { incident: string; kind: TimelineKind; text: string }[], now: Date): Promise<void> {
  if (!lines.length) return;
  await db.batch(lines.flatMap((l) => timelineStatements(db, l.incident, [{ kind: l.kind, public: false, status: null, text: l.text }], now, "status")));
}

export async function addFollowUp(db: D1Database, incident: string, input: { title: string; owner: string | null; by: string }, now: Date): Promise<FollowUp> {
  const f: FollowUp = { id: shortId(), title: input.title, owner: input.owner, done_at: null, created_at: now.toISOString(), created_by: input.by };
  await db.batch([
    db
      .prepare(`INSERT INTO incident_followup (id, incident_id, title, owner, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(f.id, incident, f.title, f.owner, f.created_at, f.created_by),
    ...timelineStatements(db, incident, [{ kind: "followup", public: false, status: null, text: `Follow-up: ${f.title}${f.owner ? ` (${f.owner})` : ""}.` }], now, input.by),
    auditStatement(db, f.created_at, input.by, "incident_followup", incident, `Added follow-up: ${f.title}`),
  ]);
  return f;
}

export async function setFollowUp(db: D1Database, incident: string, id: string, done: boolean, by: string, now: Date): Promise<FollowUp | null> {
  const row = (await db.prepare(`SELECT * FROM incident_followup WHERE id = ?1 AND incident_id = ?2`).bind(id, incident).first()) as FollowUpRow | null;
  if (!row) return null;
  const at = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE incident_followup SET done_at = ?2, done_by = ?3 WHERE id = ?1`).bind(id, done ? at : null, done ? by : null),
    ...timelineStatements(db, incident, [{ kind: "followup", public: false, status: null, text: `${done ? "Done" : "Reopened"}: ${row.title}.` }], now, by),
    auditStatement(db, at, by, "incident_followup", incident, `${done ? "Done" : "Reopened"}: ${row.title}`),
  ]);
  return { id, title: row.title, owner: row.owner, done_at: done ? at : null, created_at: row.created_at, created_by: row.created_by };
}

export async function savePostmortem(db: D1Database, incident: string, fields: PostmortemFields, by: string, now: Date): Promise<void> {
  const at = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO postmortem (incident_id, summary, impact, timeline, root_cause, went_well, went_badly, action_items, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (incident_id) DO UPDATE SET summary = ?2, impact = ?3, timeline = ?4, root_cause = ?5, went_well = ?6, went_badly = ?7,
           action_items = ?8, updated_at = ?9, updated_by = ?10`,
      )
      .bind(incident, fields.summary, fields.impact, fields.timeline, fields.root_cause, fields.went_well, fields.went_badly, fields.action_items, at, by),
    auditStatement(db, at, by, "postmortem_saved", incident, "Saved the postmortem draft"),
  ]);
}

export async function publishPostmortem(db: D1Database, incident: string, publish: boolean, by: string, now: Date): Promise<void> {
  const at = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE postmortem SET published_at = ?2, published_by = ?3 WHERE incident_id = ?1`).bind(incident, publish ? at : null, publish ? by : null),
    ...timelineStatements(db, incident, [{ kind: "postmortem", public: false, status: null, text: publish ? "Postmortem published." : "Postmortem taken down." }], now, by),
    auditStatement(db, at, by, publish ? "postmortem_published" : "postmortem_unpublished", incident, publish ? "Published the postmortem" : "Took the postmortem down"),
  ]);
}

// --- Maintenance ---------------------------------------------------------------------

export async function scheduleMaintenance(
  db: D1Database,
  input: { title: string; message: string; components: string[]; starts_at: string; ends_at: string; notify: boolean; by: string },
  notified: number | null,
  now: Date,
  id = shortId(),
): Promise<string> {
  const at = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO maintenance (id, title, message, components, starts_at, ends_at, state, notify, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scheduled', ?7, ?8, ?9)`,
      )
      .bind(id, input.title, input.message, JSON.stringify(input.components), input.starts_at, input.ends_at, input.notify ? 1 : 0, at, input.by),
    db
      .prepare(`INSERT INTO maintenance_update (id, maintenance_id, at, by, text, notified) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(shortId(), id, at, input.by, input.message, notified),
    auditStatement(db, at, input.by, "maintenance_scheduled", id, `${input.title} (${input.starts_at} to ${input.ends_at})`),
  ]);
  return id;
}

/** Moves maintenance along and posts its update. Null `state` keeps it where it is. */
export async function maintenanceUpdate(
  db: D1Database,
  id: string,
  state: MaintenanceState | null,
  text: string,
  by: string,
  notified: number | null,
  now: Date,
  audit: { action: string; detail: string } | null,
): Promise<void> {
  const at = now.toISOString();
  await db.batch([
    ...(state ? [db.prepare(`UPDATE maintenance SET state = ?2 WHERE id = ?1`).bind(id, state)] : []),
    db
      .prepare(`INSERT INTO maintenance_update (id, maintenance_id, at, by, text, notified) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(shortId(), id, at, by, text, notified),
    ...(audit ? [auditStatement(db, at, by, audit.action, id, audit.detail)] : []),
  ]);
}

/** Maintenance whose window has started or ended but whose state has not caught up. */
export async function dueMaintenance(db: D1Database, now: Date, origin: string): Promise<(AdminMaintenance & { notify: boolean })[]> {
  const at = now.toISOString();
  const list = rows<MaintenanceRow>(
    (await db
      .prepare(`SELECT * FROM maintenance WHERE (state = 'scheduled' AND starts_at <= ?1) OR (state = 'in_progress' AND ends_at <= ?1)`)
      .bind(at)
      .all()) as D1Result,
  );
  return list.map((row) => ({ ...toMaintenance(row, [], origin), notify: row.notify === 1 }));
}

// --- Subscribers -----------------------------------------------------------------------

type SubscriberRow = {
  id: string;
  email: string;
  components: string | null;
  pending_components: string | null;
  confirm_hash: string | null;
  confirm_expires_at: string | null;
  confirm_sent_at: string | null;
  confirmed_at: string | null;
};

/**
 * Asks for a subscription (or a change of parts): a new confirmation,
 * unless one went out to this address in the last `resendAfterMs`. The
 * caller answers the same either way, so the form never tells whether an
 * address is subscribed.
 */
export async function requestSubscription(
  db: D1Database,
  email: string,
  parts: string[] | null,
  hash: string,
  now: Date,
  ttlMs: number,
  resendAfterMs: number,
): Promise<{ send: boolean }> {
  const at = now.toISOString();
  const existing = (await db.prepare(`SELECT * FROM subscriber WHERE email = ?1`).bind(email).first()) as SubscriberRow | null;
  if (existing?.confirm_sent_at && now.getTime() - Date.parse(existing.confirm_sent_at) < resendAfterMs) return { send: false };
  const pending = parts ? JSON.stringify(parts) : null;
  if (existing) {
    await db
      .prepare(`UPDATE subscriber SET pending_components = ?2, confirm_hash = ?3, confirm_expires_at = ?4, confirm_sent_at = ?5 WHERE id = ?1`)
      .bind(existing.id, pending, hash, iso(now.getTime() + ttlMs), at)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO subscriber (id, email, components, pending_components, confirm_hash, confirm_expires_at, confirm_sent_at, created_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(crypto.randomUUID(), email, pending, hash, iso(now.getTime() + ttlMs), at)
      .run();
  }
  return { send: true };
}

/** Confirms the subscription a token's hash belongs to; null when none or expired. */
export async function confirmSubscription(db: D1Database, hash: string, now: Date): Promise<{ email: string; parts: string[] | null } | null> {
  const row = (await db.prepare(`SELECT * FROM subscriber WHERE confirm_hash = ?1`).bind(hash).first()) as SubscriberRow | null;
  if (!row || !row.confirm_expires_at || Date.parse(row.confirm_expires_at) < now.getTime()) return null;
  await db
    .prepare(
      `UPDATE subscriber SET components = pending_components, pending_components = NULL, confirm_hash = NULL, confirm_expires_at = NULL,
         confirmed_at = COALESCE(confirmed_at, ?2) WHERE id = ?1`,
    )
    .bind(row.id, now.toISOString())
    .run();
  return { email: row.email, parts: parseParts(row.pending_components) };
}

export async function unsubscribe(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM subscriber WHERE id = ?1`).bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Confirmed subscribers who want news about these parts. */
export async function recipients(db: D1Database, about: string[]): Promise<{ id: string; email: string }[]> {
  const all = rows<SubscriberRow>((await db.prepare(`SELECT id, email, components FROM subscriber WHERE confirmed_at IS NOT NULL`).all()) as D1Result);
  return all.filter((s) => wants(parseParts(s.components), about)).map((s) => ({ id: s.id, email: s.email }));
}

// --- Detection ---------------------------------------------------------------------------

export async function loadStreaks(db: D1Database): Promise<Map<string, Streak>> {
  const list = rows<{ component: string; state: "degraded" | "down"; count: number; since: string; alerted: number }>(
    (await db.prepare(`SELECT * FROM streak`).all()) as D1Result,
  );
  return new Map(list.map((s) => [s.component, { ...s, alerted: s.alerted === 1 }]));
}

export async function saveStreaks(db: D1Database, streaks: Streak[]): Promise<void> {
  const keep = streaks.map((s) => s.component);
  await db.batch([
    db.prepare(`DELETE FROM streak WHERE component NOT IN (${inList(keep)})`).bind(...keep),
    ...streaks.map((s) =>
      db
        .prepare(
          `INSERT INTO streak (component, state, count, since, alerted) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (component) DO UPDATE SET state = ?2, count = ?3, since = ?4, alerted = ?5`,
        )
        .bind(s.component, s.state, s.count, s.since, s.alerted ? 1 : 0),
    ),
  ]);
}

/** Open incidents, drafts included, with the parts they affect: what detection checks against. */
export async function openRefs(db: D1Database): Promise<{ id: string; components: string[] }[]> {
  const list = rows<{ id: string; component: string | null }>(
    (await db
      .prepare(
        `SELECT i.id, c.component FROM incident i LEFT JOIN incident_component c ON c.incident_id = i.id AND c.impact != 'operational'
         WHERE i.resolved_at IS NULL AND i.visibility IN ('draft', 'public')`,
      )
      .all()) as D1Result,
  );
  const map = new Map<string, string[]>();
  for (const r of list) {
    const parts = map.get(r.id) ?? [];
    if (r.component) parts.push(r.component);
    map.set(r.id, parts);
  }
  return [...map].map(([id, components]) => ({ id, components }));
}

// --- Audit ---------------------------------------------------------------------------------

export async function auditLog(db: D1Database, before: string | null, limit = 100): Promise<StatusAuditEntry[]> {
  const statement = before
    ? db.prepare(`SELECT * FROM audit WHERE at < ?1 ORDER BY at DESC LIMIT ?2`).bind(before, limit)
    : db.prepare(`SELECT * FROM audit ORDER BY at DESC LIMIT ?1`).bind(limit);
  return rows<StatusAuditEntry>((await statement.all()) as D1Result);
}
