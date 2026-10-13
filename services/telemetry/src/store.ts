/**
 * One project's telemetry: a Durable Object named by the project's id,
 * holding its requests, logs, spans, metrics, error groups, ingest tokens
 * and exports in its own SQLite (./schema.ts). One object per project
 * means each project's store grows, and is queried, on its own.
 *
 * Writes arrive from the service's two doors (`ingest`); reads are the
 * service's RPC methods, called once the site or the API has checked the
 * viewer may read the project. Open live tails are hibernating WebSockets
 * here, each handed what arrives as it arrives.
 *
 * An alarm runs while there is work: each minute it counts requests into
 * per-minute rollups and sends to exports what is waiting; each hour it
 * removes what is past the project's retention.
 */
import {
  DEFAULT_TELEMETRY_SETTINGS,
  RETENTION_CHOICES,
  TELEMETRY_TOKEN_PREFIX,
  type Attributes,
  type ErrorGroup,
  type IngestToken,
  type LiveItem,
  type LogQuery,
  type MetricInfo,
  type MetricSeries,
  type TelemetryOverview,
  type TelemetryTotals,
  type Page,
  type RequestQuery,
  type LogSeverity,
  type TelemetryExport,
  type TelemetryFilter,
  type TelemetryLog,
  type TelemetryRequest,
  type TelemetrySettings,
  type TelemetrySpan,
  type TelemetryUsage,
  type TraceDetail,
  type TraceQuery,
  type TraceSummary,
} from "@g1t/contracts/telemetry";

import type { Batch } from "./batch.ts";
import { fingerprint } from "./errors.ts";
import { exportEndpointProblem, otlpBodies, send } from "./export.ts";
import { addInto, bucketOf, decode, emptyHistogram, encode, percentiles } from "./histogram.ts";
import { FTS, MIGRATIONS, ROLLUP_DAYS } from "./schema.ts";
import { sizeOf } from "./quota.ts";
import { SEVERITY_FLOOR, randomId, severityOf } from "./shape.ts";
import type { RequestHalf } from "./tail.ts";

const MINUTE_US = 60_000_000;
const DAY_US = 86_400_000_000;
/** Requests are counted once they are this old, so both halves have arrived. */
const ROLL_AFTER_US = 90_000_000;
/** A store larger than this sheds its oldest day until it is not. */
const MAX_BYTES = 4 * 1024 ** 3;
/** At most this many items a second go to each live tail; the rest are counted as dropped. */
const LIVE_PER_BATCH = 200;
const STEPS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 86400];

type Row = Record<string, SqlStorageValue>;

const json = <T>(text: SqlStorageValue, fallback: T): T => {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};
const strOrNull = (v: SqlStorageValue) => (v === null || v === undefined || v === "" ? null : String(v));
const numOrNull = (v: SqlStorageValue) => (v === null || v === undefined ? null : Number(v));

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function month(us = Date.now() * 1000): string {
  return new Date(us / 1000).toISOString().slice(0, 7);
}

/** `2026-10-12`: the UTC day, for a free workspace's daily share. */
function day(us = Date.now() * 1000): string {
  return new Date(us / 1000).toISOString().slice(0, 10);
}

/** A page's cursor: the last row's time and id, so the next page starts after it. */
function cursorOf(time: number, id: string): string {
  return btoa(`${time}:${id}`);
}
function readCursor(cursor: string | null | undefined): { time: number; id: string } | null {
  if (!cursor) return null;
  try {
    const [time, id] = atob(cursor).split(":");
    return Number.isFinite(Number(time)) && id ? { time: Number(time), id } : null;
  } catch {
    return null;
  }
}

/** A limit within reason. */
const limitOf = (n: number | null | undefined, fallback = 100, max = 500) => Math.min(max, Math.max(1, Math.trunc(n ?? fallback)));

/**
 * Search text split into what it says: `key=value` and `key:value` pairs
 * filter by attribute (or by a column the row has), the rest are words to find.
 */
export function parseSearch(text: string | null | undefined): { words: string[]; pairs: [string, string][] } {
  const words: string[] = [];
  const pairs: [string, string][] = [];
  for (const m of (text ?? "").matchAll(/"([^"]+)"|(\S+)/g)) {
    const token = m[1] ?? m[2];
    const pair = m[1] ? null : /^([\w.@/-]+)[=:](.+)$/.exec(token);
    if (pair && !/^https?$/.test(pair[1])) pairs.push([pair[1], pair[2]]);
    else words.push(token);
  }
  return { words, pairs };
}

/** An FTS5 query in which every word must appear (as a prefix, for the last). */
export function ftsQuery(words: string[]): string {
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 && !/\s/.test(w) ? "*" : ""}`).join(" AND ");
}

/**
 * The store's logic, apart from the Durable Object it runs in
 * (./durable.ts), so tests run it on Node's SQLite.
 */
export class Store {
  state!: DurableObjectState;
  sql!: SqlStorage;
  fts = false;

  constructor(state: DurableObjectState) {
    this.open(state);
  }

  open(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.migrate();
  }

  migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const done = Number(this.sql.exec("SELECT value FROM meta WHERE key = 'migrations'").toArray()[0]?.value ?? 0);
    for (let i = done; i < MIGRATIONS.length; i++) {
      this.sql.exec(MIGRATIONS[i]);
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('migrations', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(i + 1));
    }
    try {
      this.sql.exec(FTS);
      this.fts = true;
    } catch {
      this.fts = false;
    }
  }

  rows(query: string, ...args: SqlStorageValue[]): Row[] {
    return this.sql.exec(query, ...args).toArray() as Row[];
  }

  // ---- Settings -----------------------------------------------------------

  settings(): TelemetrySettings {
    const out: TelemetrySettings = { ...DEFAULT_TELEMETRY_SETTINGS };
    for (const row of this.rows("SELECT key, value FROM settings")) {
      if (row.key === "retention_days") out.retention_days = Number(row.value);
      if (row.key === "deployments") out.deployments = row.value === "1";
    }
    return out;
  }

  setSettings(change: Partial<TelemetrySettings>): TelemetrySettings {
    const put = (key: string, value: string) =>
      this.sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
    if (change.retention_days !== undefined) {
      if (!(RETENTION_CHOICES as readonly number[]).includes(change.retention_days)) throw new Error(`Retention is one of ${RETENTION_CHOICES.join(", ")} days.`);
      put("retention_days", String(change.retention_days));
    }
    if (change.deployments !== undefined) put("deployments", change.deployments ? "1" : "0");
    return this.settings();
  }

  /** The workspace the project is in, by slug, as the site last said; null before it has. */
  workspaceOf(): string | null {
    const row = this.rows("SELECT value FROM settings WHERE key = 'workspace'")[0];
    return row ? String(row.value) : null;
  }

  setWorkspace(slug: string): void {
    const clean = slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(clean) || clean === this.workspaceOf()) return;
    this.sql.exec("INSERT INTO settings (key, value) VALUES ('workspace', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", clean);
  }

  /** Bytes that arrived today (UTC). */
  todayBytes(): number {
    return Number(this.rows("SELECT ingested_bytes FROM usage_days WHERE day = ?", day())[0]?.ingested_bytes ?? 0);
  }

  // ---- Tokens -------------------------------------------------------------

  tokenRow(row: Row): IngestToken {
    return {
      id: String(row.id),
      name: String(row.name),
      hint: String(row.hint),
      created_by: strOrNull(row.created_by),
      created_us: Number(row.created_us),
      last_used_us: numOrNull(row.last_used_us),
      managed: row.managed === 1,
    };
  }

  /**
   * The tokens people made. The one g1t's deployments send with is kept
   * out of sight: it is g1t's, given to the project's apps on their own.
   */
  tokens(): IngestToken[] {
    return this.rows("SELECT * FROM tokens WHERE managed = 0 ORDER BY created_us DESC").map((r) => this.tokenRow(r));
  }

  /** A new token: `g1to_<project>_<secret>`, so the ingest door knows whose store to ask. */
  async createToken(projectId: string, name: string, createdBy: string | null, managed = false): Promise<{ token: IngestToken; secret: string }> {
    const secret = `${TELEMETRY_TOKEN_PREFIX}${projectId}_${randomId(24)}`;
    const id = randomId(8);
    const created = Date.now() * 1000;
    this.sql.exec(
      "INSERT INTO tokens (id, name, hash, hint, created_by, created_us, managed, secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      name.trim().slice(0, 80) || "Ingest token",
      await sha256(secret),
      `${secret.slice(0, TELEMETRY_TOKEN_PREFIX.length + 4)}…${secret.slice(-4)}`,
      createdBy,
      created,
      managed ? 1 : 0,
      managed ? secret : null,
    );
    return { token: this.tokenRow(this.rows("SELECT * FROM tokens WHERE id = ?", id)[0]), secret };
  }

  revokeToken(id: string): boolean {
    return this.sql.exec("DELETE FROM tokens WHERE id = ? AND managed = 0", id).rowsWritten > 0;
  }

  async deploymentToken(projectId: string): Promise<{ secret: string }> {
    const row = this.rows("SELECT secret FROM tokens WHERE managed = 1 LIMIT 1")[0];
    if (row?.secret) return { secret: String(row.secret) };
    const made = await this.createToken(projectId, "Deployments on g1t.page", null, true);
    return { secret: made.secret };
  }

  /** Whether `secret` is one of this project's tokens; marks it used. */
  async checkToken(secret: string): Promise<boolean> {
    const hash = await sha256(secret);
    const row = this.rows("SELECT id, last_used_us FROM tokens WHERE hash = ?", hash)[0];
    if (!row) return false;
    const now = Date.now() * 1000;
    if (!row.last_used_us || now - Number(row.last_used_us) > MINUTE_US) {
      this.sql.exec("UPDATE tokens SET last_used_us = ? WHERE id = ?", now, row.id);
    }
    return true;
  }

  // ---- Ingest -------------------------------------------------------------

  /**
   * Adds what arrived. `token` is checked first when given (the OTLP door);
   * tail events come from Cloudflare and need none. Returns false for a
   * token that is not this project's, or when this kind of telemetry is off.
   *
   * `overQuota`: the project's workspace is past its day's share of its
   * free observability (its meter says so, ../meter.ts and ../quota.ts):
   * OTLP is refused (`quota`), and tail events keep their requests without
   * logs. Returns the bytes kept, for the workspace's meter.
   */
  async ingest(
    batch: Batch,
    halves: RequestHalf[] = [],
    token?: string,
    overQuota = false,
  ): Promise<{ accepted: boolean; reason?: string; bytes?: number }> {
    if (token !== undefined && !(await this.checkToken(token))) return { accepted: false, reason: "token" };
    if (token === undefined && !this.settings().deployments) return { accepted: false, reason: "off" };
    if (overQuota) {
      if (token !== undefined) return { accepted: false, reason: "quota" };
      batch = { ...batch, logs: [], spans: [], metrics: [], errors: [], bytes: sizeOf(halves) + sizeOf(batch.requests) };
    }

    const live: LiveItem[] = [];
    for (const h of halves) this.putHalf(h);
    for (const r of batch.requests) this.putHalf({ ...r, half: "app" });
    for (const log of batch.logs) {
      this.sql.exec(
        `INSERT OR IGNORE INTO logs (id, time_us, severity_number, body, trace_id, span_id, request_id, attributes, service, environment, deployment_id, commit_sha, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        log.id, log.time_us, log.severity_number, log.body, log.trace_id, log.span_id, log.request_id, JSON.stringify(log.attributes),
        log.service, log.environment, log.deployment_id, log.commit_sha, log.source,
      );
      live.push({ type: "log", log });
    }
    for (const s of batch.spans) {
      this.sql.exec(
        `INSERT OR REPLACE INTO spans (trace_id, span_id, parent_span_id, name, kind, start_us, duration_us, status, status_message, attributes, resource, events, links,
           service, environment, deployment_id, commit_sha, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.trace_id, s.span_id, s.parent_span_id, s.name, s.kind, s.start_us, s.duration_us, s.status, s.status_message,
        JSON.stringify(s.attributes), JSON.stringify(s.resource), JSON.stringify(s.events), JSON.stringify(s.links),
        s.service, s.environment, s.deployment_id, s.commit_sha, s.source,
      );
      live.push({ type: "span", span: s });
    }
    for (const m of batch.metrics) {
      this.sql.exec(
        `INSERT INTO metric_points (name, kind, time_us, value, count, sum, min, max, bounds, counts, quantiles, monotonic, attributes, service, environment, deployment_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.name, m.kind, m.time_us, m.value, m.count, m.sum, m.min, m.max,
        m.bounds ? JSON.stringify(m.bounds) : null, m.counts ? JSON.stringify(m.counts) : null, m.quantiles ? JSON.stringify(m.quantiles) : null,
        m.monotonic ? 1 : 0, JSON.stringify(m.attributes), m.service, m.environment, m.deployment_id, m.source,
      );
      const known = this.rows("SELECT services FROM metric_names WHERE name = ?", m.name)[0];
      const services = new Set<string>(json<string[]>(known?.services ?? null, []));
      services.add(m.service);
      this.sql.exec(
        `INSERT INTO metric_names (name, kind, unit, description, services, last_us) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, unit = excluded.unit,
           description = CASE WHEN excluded.description = '' THEN metric_names.description ELSE excluded.description END,
           services = excluded.services, last_us = MAX(metric_names.last_us, excluded.last_us)`,
        m.name, m.kind, m.unit, m.description, JSON.stringify([...services].slice(0, 50)), m.time_us,
      );
    }
    for (const e of batch.errors) await this.seeError(e);

    const requestCount = halves.filter((h) => h.half === "edge").length + batch.requests.length + halves.filter((h) => h.half === "app" && h.trigger !== "fetch").length;
    this.sql.exec(
      `INSERT INTO usage (month, ingested_bytes, requests, logs, spans, metric_points) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (month) DO UPDATE SET ingested_bytes = ingested_bytes + excluded.ingested_bytes, requests = requests + excluded.requests,
         logs = logs + excluded.logs, spans = spans + excluded.spans, metric_points = metric_points + excluded.metric_points`,
      month(), batch.bytes, requestCount, batch.logs.length, batch.spans.length, batch.metrics.length,
    );
    this.sql.exec(
      "INSERT INTO usage_days (day, ingested_bytes) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET ingested_bytes = ingested_bytes + excluded.ingested_bytes",
      day(), batch.bytes,
    );

    // Requests go live (and to exports) whole: once both halves are in, or
    // for OTLP, at once.
    const ids = [...new Set([...halves.map((h) => h.id), ...batch.requests.map((r) => r.id)])];
    const requests = ids.length ? this.requestsByIds(ids) : [];
    for (const r of requests) live.unshift({ type: "request", request: r });
    this.broadcast(live);
    // Requests are sent on when they are counted (`roll`), once both halves are in.
    this.state.waitUntil(this.forward({ ...batch, requests: [] }, []));
    await this.ensureAlarm();
    return { accepted: true, bytes: batch.bytes };
  }

  /** One half of a request (./tail.ts), merged with the other. */
  putHalf(h: RequestHalf) {
    const edge = h.half === "edge";
    this.sql.exec(
      `INSERT INTO requests (id, time_us, duration_us, trigger, method, url, route, status, outcome, cpu_ms, region, country, trace_id, log_count,
         error_name, error_message, service, environment, deployment_id, commit_sha, source, edge, app)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         time_us = MIN(requests.time_us, excluded.time_us),
         -- The dispatcher's half has the whole request: its time and status win.
         duration_us = CASE WHEN excluded.edge = 1 OR requests.edge = 0 THEN excluded.duration_us ELSE requests.duration_us END,
         status = CASE WHEN excluded.edge = 1 OR requests.status IS NULL THEN COALESCE(excluded.status, requests.status) ELSE requests.status END,
         trigger = COALESCE(excluded.trigger, requests.trigger),
         method = COALESCE(requests.method, excluded.method),
         url = COALESCE(requests.url, excluded.url),
         route = COALESCE(requests.route, excluded.route),
         region = COALESCE(requests.region, excluded.region),
         country = COALESCE(requests.country, excluded.country),
         trace_id = COALESCE(requests.trace_id, excluded.trace_id),
         outcome = CASE WHEN excluded.app = 1 THEN excluded.outcome ELSE requests.outcome END,
         cpu_ms = COALESCE(excluded.cpu_ms, requests.cpu_ms),
         log_count = requests.log_count + excluded.log_count,
         error_name = COALESCE(requests.error_name, excluded.error_name),
         error_message = COALESCE(requests.error_message, excluded.error_message),
         service = CASE WHEN excluded.service != '' THEN excluded.service ELSE requests.service END,
         environment = COALESCE(excluded.environment, requests.environment),
         deployment_id = COALESCE(excluded.deployment_id, requests.deployment_id),
         commit_sha = COALESCE(excluded.commit_sha, requests.commit_sha),
         edge = MAX(requests.edge, excluded.edge),
         app = MAX(requests.app, excluded.app)`,
      h.id, h.time_us ?? Date.now() * 1000, h.duration_us ?? 0, h.trigger ?? "fetch", h.method ?? null, h.url ?? null, h.route ?? null,
      h.status ?? null, h.outcome ?? "ok", h.cpu_ms ?? null, h.region ?? null, h.country ?? null, h.trace_id ?? null, h.log_count ?? 0,
      h.error?.name ?? null, h.error?.message ?? null, h.service ?? "", h.environment ?? null, h.deployment_id ?? null, h.commit_sha ?? null,
      h.source ?? "cloudflare", edge ? 1 : 0, edge ? 0 : 1,
    );
  }

  async seeError(e: Batch["errors"][number]) {
    const fp = await fingerprint(e.name, e.message, e.stack, e.service);
    const known = this.rows("SELECT state FROM error_groups WHERE fingerprint = ?", fp)[0];
    if (!known) {
      this.sql.exec(
        `INSERT INTO error_groups (fingerprint, name, message, stack, service, environment, first_us, last_us, count, first_deployment_id, last_request_id, last_trace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        fp, e.name.slice(0, 200), e.message.slice(0, 4096), e.stack?.slice(0, 16384) ?? null, e.service, e.environment, e.time_us, e.time_us,
        e.deployment_id, e.request_id, e.trace_id,
      );
      return;
    }
    // A resolved error that happens again is open again; an ignored one stays ignored.
    this.sql.exec(
      `UPDATE error_groups SET count = count + 1, last_us = MAX(last_us, ?), last_request_id = COALESCE(?, last_request_id),
         last_trace_id = COALESCE(?, last_trace_id), stack = COALESCE(stack, ?), state = CASE WHEN state = 'resolved' THEN 'open' ELSE state END
       WHERE fingerprint = ?`,
      e.time_us, e.request_id, e.trace_id, e.stack ?? null, fp,
    );
  }

  // ---- Live ---------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket.\n", { status: 426 });
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "hello" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {}
  }

  broadcast(items: LiveItem[]) {
    const sockets = this.state.getWebSockets();
    if (!sockets.length || !items.length) return;
    const shown = items.slice(0, LIVE_PER_BATCH);
    const dropped = items.length - shown.length;
    const message = JSON.stringify({ type: "items", items: shown, dropped });
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {}
    }
  }

  // ---- Exports ------------------------------------------------------------

  exportRows(): (TelemetryExport & { headers: Record<string, string> })[] {
    return this.rows("SELECT * FROM exports ORDER BY name").map((r) => {
      const headers = json<Record<string, string>>(r.headers, {});
      return {
        id: String(r.id),
        name: String(r.name),
        endpoint: String(r.endpoint),
        signals: json(r.signals, ["traces", "logs", "metrics"]),
        header_names: Object.keys(headers),
        headers,
        enabled: r.enabled === 1,
        last_error: strOrNull(r.last_error),
        last_sent_us: numOrNull(r.last_sent_us),
      };
    });
  }

  exports(): TelemetryExport[] {
    return this.exportRows().map(({ headers: _, ...rest }) => rest);
  }

  putExport(input: { id?: string | null; name: string; endpoint: string; signals: TelemetryExport["signals"]; headers?: Record<string, string> | null; enabled: boolean }): TelemetryExport {
    const problem = exportEndpointProblem(input.endpoint);
    if (problem) throw new Error(problem);
    const signals = input.signals.filter((s) => s === "traces" || s === "logs" || s === "metrics");
    if (!signals.length) throw new Error("Choose at least one signal to send.");
    const id = input.id || randomId(8);
    const before = this.rows("SELECT headers FROM exports WHERE id = ?", id)[0];
    // Header values are written, never read back: keep those not given again.
    const headers = { ...json<Record<string, string>>(before?.headers ?? null, {}) };
    for (const [k, v] of Object.entries(input.headers ?? {})) {
      if (v === "") delete headers[k];
      else headers[k] = v;
    }
    this.sql.exec(
      `INSERT INTO exports (id, name, endpoint, signals, headers, enabled) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, endpoint = excluded.endpoint, signals = excluded.signals,
         headers = excluded.headers, enabled = excluded.enabled, last_error = NULL`,
      id, input.name.trim().slice(0, 80) || "Export", input.endpoint.trim(), JSON.stringify(signals), JSON.stringify(headers), input.enabled ? 1 : 0,
    );
    return this.exports().find((e) => e.id === id)!;
  }

  deleteExport(id: string): boolean {
    return this.sql.exec("DELETE FROM exports WHERE id = ?", id).rowsWritten > 0;
  }

  async forward(batch: Batch, requests: TelemetryRequest[]) {
    const targets = this.exportRows().filter((e) => e.enabled);
    if (!targets.length || (!requests.length && !batch.logs.length && !batch.spans.length && !batch.metrics.length)) return;
    const bodies = otlpBodies(batch, requests);
    for (const target of targets) {
      let error: string | null = null;
      for (const signal of target.signals) {
        const body = bodies[signal];
        if (body) error = (await send(target, signal, body)) ?? error;
      }
      this.sql.exec("UPDATE exports SET last_error = ?, last_sent_us = ? WHERE id = ?", error, Date.now() * 1000, target.id);
    }
  }

  // ---- Upkeep -------------------------------------------------------------

  async ensureAlarm() {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  async alarm() {
    const rolled = this.roll();
    if (rolled.length) await this.forward({ requests: [], logs: [], spans: [], metrics: [], errors: [], bytes: 0 }, rolled);
    const last = Number(this.rows("SELECT value FROM meta WHERE key = 'pruned'")[0]?.value ?? 0);
    if (Date.now() - last > 3_600_000) {
      this.prune();
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('pruned', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(Date.now()));
    }
    // Keep going while there is anything left to count or keep.
    const pending = this.rows("SELECT 1 FROM requests LIMIT 1").length || this.rows("SELECT 1 FROM logs LIMIT 1").length || this.rows("SELECT 1 FROM spans LIMIT 1").length;
    if (pending) await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  /** Counts settled requests into per-minute rollups, and sends them to exports. */
  roll(now = Date.now() * 1000): TelemetryRequest[] {
    const rolled: TelemetryRequest[] = [];
    for (;;) {
      const rows = this.rows("SELECT * FROM requests WHERE rolled = 0 AND time_us < ? ORDER BY time_us, id LIMIT 2000", now - ROLL_AFTER_US);
      if (!rows.length) break;
      for (const a of aggregate(rows)) {
        const before = this.rows(
          "SELECT latency, cpu FROM rollups WHERE minute = ? AND service = ? AND environment = ? AND deployment_id = ? AND method = ? AND route = ?",
          a.minute, a.service, a.environment, a.deployment_id, a.method, a.route,
        )[0];
        const latency = encode(before ? addInto(decode(String(before.latency)), decode(a.latency)) : decode(a.latency));
        const cpu = encode(before ? addInto(decode(String(before.cpu)), decode(a.cpu)) : decode(a.cpu));
        this.sql.exec(
          `INSERT INTO rollups (minute, service, environment, deployment_id, commit_sha, source, method, route, requests, errors, s2, s3, s4, s5, latency, cpu)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (minute, service, environment, deployment_id, method, route) DO UPDATE SET
             requests = requests + excluded.requests, errors = errors + excluded.errors, s2 = s2 + excluded.s2, s3 = s3 + excluded.s3,
             s4 = s4 + excluded.s4, s5 = s5 + excluded.s5, latency = excluded.latency, cpu = excluded.cpu,
             commit_sha = COALESCE(excluded.commit_sha, rollups.commit_sha)`,
          a.minute, a.service, a.environment, a.deployment_id, a.commit_sha, a.source, a.method, a.route, a.requests, a.errors,
          a.s2, a.s3, a.s4, a.s5, latency, cpu,
        );
      }
      const last = rows[rows.length - 1];
      this.sql.exec("UPDATE requests SET rolled = 1 WHERE rolled = 0 AND (time_us < ? OR (time_us = ? AND id <= ?))", last.time_us, last.time_us, last.id);
      rolled.push(...rows.map((r) => this.requestOf(r)));
      if (rows.length < 2000) break;
    }
    return rolled;
  }

  prune(now = Date.now() * 1000) {
    const keep = now - this.settings().retention_days * DAY_US;
    // Requests are counted before they go.
    this.roll(now);
    this.sql.exec("DELETE FROM requests WHERE time_us < ?", keep);
    this.sql.exec("DELETE FROM logs WHERE time_us < ?", keep);
    this.sql.exec("DELETE FROM spans WHERE start_us < ?", keep);
    this.sql.exec("DELETE FROM metric_points WHERE time_us < ?", keep);
    this.sql.exec("DELETE FROM rollups WHERE minute < ?", Math.floor((now - ROLLUP_DAYS * DAY_US) / MINUTE_US));
    this.sql.exec("DELETE FROM error_groups WHERE last_us < ? AND issue_number IS NULL", now - ROLLUP_DAYS * DAY_US);
    this.sql.exec("DELETE FROM usage_days WHERE day < ?", day(now - 40 * DAY_US));
    // Over its size, the store sheds a day at a time from the oldest.
    for (let i = 0; i < 30 && this.state.storage.sql.databaseSize > MAX_BYTES; i++) {
      const oldest = Number(this.rows("SELECT MIN(time_us) AS t FROM logs")[0]?.t ?? now);
      const cut = oldest + DAY_US;
      this.sql.exec("DELETE FROM logs WHERE time_us < ?", cut);
      this.sql.exec("DELETE FROM spans WHERE start_us < ?", cut);
      this.sql.exec("DELETE FROM requests WHERE time_us < ?", cut);
      this.sql.exec("DELETE FROM metric_points WHERE time_us < ?", cut);
    }
  }

  async purge(): Promise<boolean> {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1000, "gone");
      } catch {}
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    return true;
  }

  // ---- Reading ------------------------------------------------------------

  /** WHERE clauses for what every list narrows by. */
  filter(f: TelemetryFilter, time: string, prefix = ""): { clauses: string[]; args: SqlStorageValue[] } {
    const clauses: string[] = [];
    const args: SqlStorageValue[] = [];
    const col = (c: string) => `${prefix}${c}`;
    if (f.from_us) clauses.push(`${col(time)} >= ?`), args.push(f.from_us);
    if (f.to_us) clauses.push(`${col(time)} <= ?`), args.push(f.to_us);
    if (f.services?.length) clauses.push(`${col("service")} IN (${f.services.map(() => "?").join(",")})`), args.push(...f.services);
    if (f.environments?.length) clauses.push(`${col("environment")} IN (${f.environments.map(() => "?").join(",")})`), args.push(...f.environments);
    if (f.deployment_id) clauses.push(`${col("deployment_id")} = ?`), args.push(f.deployment_id);
    if (f.source) clauses.push(`${col("source")} = ?`), args.push(f.source);
    return { clauses, args };
  }

  /** `key=value` pairs: a column the table has, or an attribute. */
  pairs(pairs: [string, string][], columns: string[], clauses: string[], args: SqlStorageValue[], attributes: string) {
    for (const [key, value] of pairs) {
      if (columns.includes(key)) {
        clauses.push(`CAST(${attributes.includes(".") ? `${attributes.split(".")[0]}.` : ""}${key} AS TEXT) = ?`);
        args.push(value);
      } else if (attributes) {
        clauses.push(`CAST(json_extract(${attributes}, ?) AS TEXT) = ?`);
        args.push(`$."${key.replace(/"/g, "")}"`, value);
      }
    }
  }

  requestOf(r: Row): TelemetryRequest {
    return {
      id: String(r.id),
      time_us: Number(r.time_us),
      duration_us: Number(r.duration_us),
      trigger: String(r.trigger),
      method: strOrNull(r.method),
      url: strOrNull(r.url),
      route: strOrNull(r.route),
      status: numOrNull(r.status),
      outcome: String(r.outcome),
      cpu_ms: numOrNull(r.cpu_ms),
      region: strOrNull(r.region),
      country: strOrNull(r.country),
      trace_id: strOrNull(r.trace_id),
      log_count: Number(r.log_count ?? 0),
      error: r.error_name ? { name: String(r.error_name), message: String(r.error_message ?? "") } : null,
      service: String(r.service ?? ""),
      environment: strOrNull(r.environment),
      deployment_id: strOrNull(r.deployment_id),
      commit_sha: strOrNull(r.commit_sha),
      source: r.source === "otlp" ? "otlp" : "cloudflare",
    };
  }

  requestsByIds(ids: string[]): TelemetryRequest[] {
    return this.rows(`SELECT * FROM requests WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).map((r) => this.requestOf(r));
  }

  logOf(r: Row): TelemetryLog {
    const n = Number(r.severity_number);
    return {
      id: String(r.id),
      time_us: Number(r.time_us),
      severity: severityOf(n),
      severity_number: n,
      body: String(r.body),
      trace_id: strOrNull(r.trace_id),
      span_id: strOrNull(r.span_id),
      request_id: strOrNull(r.request_id),
      attributes: json<Attributes>(r.attributes, {}),
      service: String(r.service ?? ""),
      environment: strOrNull(r.environment),
      deployment_id: strOrNull(r.deployment_id),
      commit_sha: strOrNull(r.commit_sha),
      source: r.source === "otlp" ? "otlp" : "cloudflare",
    };
  }

  spanOf(r: Row): TelemetrySpan {
    return {
      trace_id: String(r.trace_id),
      span_id: String(r.span_id),
      parent_span_id: strOrNull(r.parent_span_id),
      name: String(r.name),
      kind: String(r.kind) as TelemetrySpan["kind"],
      start_us: Number(r.start_us),
      duration_us: Number(r.duration_us),
      status: String(r.status) as TelemetrySpan["status"],
      status_message: strOrNull(r.status_message),
      attributes: json(r.attributes, {}),
      resource: json(r.resource, {}),
      events: json(r.events, []),
      links: json(r.links, []),
      service: String(r.service ?? ""),
      environment: strOrNull(r.environment),
      deployment_id: strOrNull(r.deployment_id),
      commit_sha: strOrNull(r.commit_sha),
      source: r.source === "otlp" ? "otlp" : "cloudflare",
    };
  }

  requests(q: RequestQuery): Page<TelemetryRequest> {
    const { clauses, args } = this.filter(q, "time_us");
    const { words, pairs } = parseSearch(q.text);
    this.pairs(pairs, ["method", "route", "status", "outcome", "region", "country", "trace_id", "service", "environment", "deployment_id", "commit_sha", "trigger"], clauses, args, "");
    // Software outside g1t.page often reports a route and no address: both are searched.
    for (const w of words) clauses.push("(url LIKE ? OR route LIKE ? OR error_message LIKE ? OR error_name LIKE ?)"), args.push(`%${w}%`, `%${w}%`, `%${w}%`, `%${w}%`);
    if (q.status?.length) {
      const parts: string[] = [];
      for (const s of q.status) {
        const cls = /^([1-5])xx$/i.exec(s);
        if (cls) parts.push("(status >= ? AND status < ?)"), args.push(Number(cls[1]) * 100, Number(cls[1]) * 100 + 100);
        else if (/^\d{3}$/.test(s)) parts.push("status = ?"), args.push(Number(s));
      }
      if (parts.length) clauses.push(`(${parts.join(" OR ")})`);
    }
    if (q.errors_only) clauses.push(ERROR_SQL);
    if (q.route) clauses.push("route = ?"), args.push(q.route);
    if (q.min_duration_ms) clauses.push("duration_us >= ?"), args.push(q.min_duration_ms * 1000);
    const after = readCursor(q.cursor);
    if (after) clauses.push("(time_us < ? OR (time_us = ? AND id < ?))"), args.push(after.time, after.time, after.id);
    const limit = limitOf(q.limit);
    const rows = this.rows(
      `SELECT * FROM requests ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY time_us DESC, id DESC LIMIT ?`,
      ...args,
      limit + 1,
    );
    const items = rows.slice(0, limit).map((r) => this.requestOf(r));
    const last = items[items.length - 1];
    return { items, next: rows.length > limit && last ? cursorOf(last.time_us, last.id) : null };
  }

  request(id: string): { request: TelemetryRequest; logs: TelemetryLog[] } | null {
    const row = this.rows("SELECT * FROM requests WHERE id = ?", id)[0];
    if (!row) return null;
    const logs = this.rows("SELECT * FROM logs WHERE request_id = ? ORDER BY time_us, rowid LIMIT 1000", id).map((r) => this.logOf(r));
    return { request: this.requestOf(row), logs };
  }

  logs(q: LogQuery): Page<TelemetryLog> {
    const { clauses, args } = this.filter(q, "time_us", "logs.");
    const { words, pairs } = parseSearch(q.text);
    const isLevel = ([k]: [string, string]) => k === "level" || k === "severity";
    this.pairs(pairs.filter((p) => !isLevel(p)), ["trace_id", "span_id", "request_id", "service", "environment", "deployment_id", "commit_sha"], clauses, args, "logs.attributes");
    const levels = [...(q.severities ?? []), ...pairs.filter(isLevel).map(([, v]) => v.toLowerCase() as LogSeverity)];
    const ranges = levels.filter((l) => SEVERITY_FLOOR[l]).map((l) => SEVERITY_FLOOR[l]);
    if (ranges.length) {
      clauses.push(`(${ranges.map(() => "logs.severity_number BETWEEN ? AND ?").join(" OR ")})`);
      for (const [lo, hi] of ranges) args.push(lo, hi);
    }
    if (q.trace_id) clauses.push("logs.trace_id = ?"), args.push(q.trace_id);
    if (q.request_id) clauses.push("logs.request_id = ?"), args.push(q.request_id);
    let from = "logs";
    if (words.length && this.fts) {
      from = "logs JOIN logs_fts ON logs_fts.rowid = logs.rowid";
      clauses.push("logs_fts MATCH ?");
      args.push(ftsQuery(words));
    } else {
      for (const w of words) clauses.push("logs.body LIKE ?"), args.push(`%${w}%`);
    }
    const after = readCursor(q.cursor);
    if (after) clauses.push("(logs.time_us < ? OR (logs.time_us = ? AND logs.id < ?))"), args.push(after.time, after.time, after.id);
    const limit = limitOf(q.limit, 200, 1000);
    const rows = this.rows(
      `SELECT logs.* FROM ${from} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY logs.time_us DESC, logs.id DESC LIMIT ?`,
      ...args,
      limit + 1,
    );
    const items = rows.slice(0, limit).map((r) => this.logOf(r));
    const last = items[items.length - 1];
    return { items, next: rows.length > limit && last ? cursorOf(last.time_us, last.id) : null };
  }

  traces(q: TraceQuery): Page<TraceSummary> {
    const { clauses, args } = this.filter(q, "start_us");
    const { words, pairs } = parseSearch(q.text);
    this.pairs(pairs, ["name", "service", "environment", "deployment_id", "kind", "status"], clauses, args, "attributes");
    for (const w of words) clauses.push("name LIKE ?"), args.push(`%${w}%`);
    const after = readCursor(q.cursor);
    const having: string[] = [];
    const havingArgs: SqlStorageValue[] = [];
    if (q.errors_only) having.push("SUM(status = 'error') > 0");
    if (q.min_duration_ms) having.push("MAX(start_us + duration_us) - MIN(start_us) >= ?"), havingArgs.push(q.min_duration_ms * 1000);
    if (after) having.push("(MIN(start_us) < ? OR (MIN(start_us) = ? AND trace_id < ?))"), havingArgs.push(after.time, after.time, after.id);
    const limit = limitOf(q.limit, 50, 200);
    const rows = this.rows(
      `SELECT trace_id, MIN(start_us) AS start_us, MAX(start_us + duration_us) - MIN(start_us) AS duration_us, COUNT(*) AS span_count,
         SUM(status = 'error') AS error_count, GROUP_CONCAT(DISTINCT service) AS services
       FROM spans ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       GROUP BY trace_id ${having.length ? `HAVING ${having.join(" AND ")}` : ""}
       ORDER BY start_us DESC, trace_id DESC LIMIT ?`,
      ...args,
      ...havingArgs,
      limit + 1,
    );
    const items: TraceSummary[] = rows.slice(0, limit).map((r) => {
      const traceId = String(r.trace_id);
      // The trace's request on g1t.page (its true root), else its earliest span.
      const request = this.rows("SELECT * FROM requests WHERE trace_id = ? ORDER BY time_us LIMIT 1", traceId)[0];
      const first = this.rows("SELECT * FROM spans WHERE trace_id = ? ORDER BY parent_span_id IS NOT NULL, start_us LIMIT 1", traceId)[0];
      const req = request ? this.requestOf(request) : null;
      const start = Math.min(Number(r.start_us), req?.time_us ?? Infinity);
      const end = Math.max(Number(r.start_us) + Number(r.duration_us), req ? req.time_us + req.duration_us : 0);
      return {
        trace_id: traceId,
        name: req ? [req.method, req.route].filter(Boolean).join(" ") : String(first?.name ?? ""),
        start_us: start,
        duration_us: end - start,
        span_count: Number(r.span_count) + (req ? 1 : 0),
        error_count: Number(r.error_count) + (req?.error ? 1 : 0),
        services: [...new Set([...(req ? [req.service] : []), ...String(r.services ?? "").split(",").filter(Boolean)])],
        status: req?.status ?? numOrNull(json<Attributes>(first?.attributes ?? null, {})["http.response.status_code"] as SqlStorageValue),
        service: req?.service ?? String(first?.service ?? ""),
        environment: req?.environment ?? strOrNull(first?.environment ?? null),
        deployment_id: req?.deployment_id ?? strOrNull(first?.deployment_id ?? null),
        commit_sha: req?.commit_sha ?? strOrNull(first?.commit_sha ?? null),
        source: req?.source ?? (first?.source === "cloudflare" ? "cloudflare" : "otlp"),
      };
    });
    const last = rows[Math.min(rows.length, limit) - 1];
    return { items, next: rows.length > limit && last ? cursorOf(Number(last.start_us), String(last.trace_id)) : null };
  }

  /**
   * A trace: its spans, with each request on g1t.page in it as the server
   * span it was (the parent the app's own spans name), and every log
   * written under it.
   */
  trace(traceId: string): TraceDetail | null {
    const spans = this.rows("SELECT * FROM spans WHERE trace_id = ? ORDER BY start_us LIMIT 5000", traceId).map((r) => this.spanOf(r));
    const requests = this.rows("SELECT * FROM requests WHERE trace_id = ? ORDER BY time_us LIMIT 100", traceId).map((r) => this.requestOf(r));
    if (!spans.length && !requests.length) return null;
    const have = new Set(spans.map((s) => s.span_id));
    for (const r of requests) {
      if (have.has(r.id)) continue;
      spans.unshift({
        trace_id: traceId,
        span_id: r.id,
        parent_span_id: null,
        name: [r.method, r.route].filter(Boolean).join(" ") || r.trigger,
        kind: "server",
        start_us: r.time_us,
        duration_us: r.duration_us,
        status: r.error || (r.status ?? 0) >= 500 ? "error" : "unset",
        status_message: r.error?.message ?? null,
        attributes: {
          ...(r.method ? { "http.request.method": r.method } : {}),
          ...(r.url ? { "url.full": `https://${r.url}` } : {}),
          ...(r.status !== null ? { "http.response.status_code": r.status } : {}),
          ...(r.cpu_ms !== null ? { "cloudflare.cpu_time_ms": r.cpu_ms } : {}),
          ...(r.region ? { "cloudflare.colo": r.region } : {}),
          "cloudflare.outcome": r.outcome,
          "g1t.request.id": r.id,
        },
        resource: { "service.name": r.service },
        events: [],
        links: [],
        service: r.service,
        environment: r.environment,
        deployment_id: r.deployment_id,
        commit_sha: r.commit_sha,
        source: r.source,
      });
    }
    const ids = requests.map((r) => r.id);
    const logs = this.rows(
      `SELECT * FROM logs WHERE trace_id = ? ${ids.length ? `OR request_id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY time_us LIMIT 2000`,
      traceId,
      ...ids,
    ).map((r) => this.logOf(r));
    return { trace_id: traceId, spans, logs };
  }

  errors(f: TelemetryFilter & { state?: ErrorGroup["state"] | null }): ErrorGroup[] {
    const { clauses, args } = this.filter({ ...f, deployment_id: null, source: null }, "last_us");
    if (f.state) clauses.push("state = ?"), args.push(f.state);
    return this.rows(`SELECT * FROM error_groups ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY last_us DESC LIMIT 200`, ...args).map(errorOf);
  }

  setError(fp: string, change: { state?: ErrorGroup["state"]; issue_number?: number | null }): ErrorGroup | null {
    if (change.state && !["open", "resolved", "ignored"].includes(change.state)) throw new Error("State is open, resolved or ignored.");
    if (change.state) this.sql.exec("UPDATE error_groups SET state = ? WHERE fingerprint = ?", change.state, fp);
    if (change.issue_number !== undefined) this.sql.exec("UPDATE error_groups SET issue_number = ? WHERE fingerprint = ?", change.issue_number, fp);
    const row = this.rows("SELECT * FROM error_groups WHERE fingerprint = ?", fp)[0];
    return row ? errorOf(row) : null;
  }

  metrics(): MetricInfo[] {
    return this.rows("SELECT * FROM metric_names ORDER BY name").map((r) => ({
      name: String(r.name),
      kind: String(r.kind) as MetricInfo["kind"],
      unit: String(r.unit),
      description: String(r.description),
      services: json(r.services, []),
      last_us: Number(r.last_us),
    }));
  }

  /**
   * A metric over time. Gauges average (or take the min or max) in each
   * step; sums add (a cumulative sum becomes the increase in the step);
   * histograms give their mean, or a percentile from their buckets.
   */
  metric(q: TelemetryFilter & { name: string; aggregate?: string | null; group_by?: string | null; step_s?: number | null }): MetricSeries {
    const now = Date.now() * 1000;
    const from = q.from_us ?? now - DAY_US;
    const to = q.to_us ?? now;
    const step = q.step_s ?? stepFor(to - from);
    const { clauses, args } = this.filter({ ...q, from_us: from, to_us: to }, "time_us");
    clauses.push("name = ?");
    args.push(q.name);
    const info = this.rows("SELECT unit, kind FROM metric_names WHERE name = ?", q.name)[0];
    const rows = this.rows(`SELECT * FROM metric_points WHERE ${clauses.join(" AND ")} ORDER BY time_us LIMIT 200000`, ...args);
    const stepUs = step * 1_000_000;
    const groups = new Map<string | null, Map<number, number[]>>();
    const lastCumulative = new Map<string, number>();
    const aggregate = q.aggregate ?? (info?.kind === "sum" ? "sum" : "avg");
    for (const r of rows) {
      const attrs = json<Attributes>(r.attributes, {});
      const group = q.group_by ? String(q.group_by === "service" ? r.service : (attrs[q.group_by] ?? "")) : null;
      const bucket = Math.floor(Number(r.time_us) / stepUs) * stepUs;
      let value: number | null = numOrNull(r.value);
      if (r.kind === "sum" && r.monotonic === 1) {
        // Each series of a cumulative sum is told apart by its attributes.
        const key = `${r.service}\u0000${String(r.attributes)}`;
        const before = lastCumulative.get(key);
        lastCumulative.set(key, value ?? 0);
        value = before === undefined || (value ?? 0) < before ? null : (value ?? 0) - before;
      }
      if (r.kind === "histogram" && /^p\d+$/.test(aggregate) && r.counts && r.bounds) {
        value = histogramQuantile(json(r.bounds, []), json(r.counts, []), Number(aggregate.slice(1)) / 100);
      }
      if (value === null) continue;
      let g = groups.get(group);
      if (!g) groups.set(group, (g = new Map()));
      g.set(bucket, [...(g.get(bucket) ?? []), value]);
    }
    const reduce = (values: number[]): number => {
      switch (aggregate) {
        case "sum":
          return values.reduce((a, b) => a + b, 0);
        case "min":
          return Math.min(...values);
        case "max":
          return Math.max(...values);
        default:
          return values.reduce((a, b) => a + b, 0) / values.length;
      }
    };
    const start = Math.floor(from / stepUs) * stepUs;
    return {
      name: q.name,
      unit: String(info?.unit ?? ""),
      step_s: step,
      series: [...groups.entries()].slice(0, 20).map(([group, points]) => {
        const out: { time_us: number; value: number | null }[] = [];
        for (let t = start; t <= to; t += stepUs) {
          const values = points.get(t);
          out.push({ time_us: t, value: values ? reduce(values) : null });
        }
        return { group, points: out };
      }),
    };
  }

  facets(): { services: string[]; environments: string[]; attribute_keys: string[] } {
    const since = Date.now() * 1000 - 7 * DAY_US;
    const services = this.rows(
      `SELECT service FROM rollups WHERE minute >= ? AND service != '' GROUP BY service
       UNION SELECT service FROM spans WHERE start_us >= ? AND service != '' GROUP BY service
       UNION SELECT service FROM logs WHERE time_us >= ? AND service != '' GROUP BY service`,
      Math.floor(since / MINUTE_US), since, since,
    ).map((r) => String(r.service));
    const environments = this.rows(
      `SELECT environment FROM rollups WHERE minute >= ? AND environment != '' GROUP BY environment
       UNION SELECT environment FROM logs WHERE time_us >= ? AND environment IS NOT NULL GROUP BY environment`,
      Math.floor(since / MINUTE_US), since,
    ).map((r) => String(r.environment));
    const keys = new Set<string>();
    for (const r of this.rows("SELECT attributes FROM logs ORDER BY time_us DESC LIMIT 500")) for (const k of Object.keys(json(r.attributes, {}))) keys.add(k);
    for (const r of this.rows("SELECT attributes FROM spans ORDER BY start_us DESC LIMIT 500")) for (const k of Object.keys(json(r.attributes, {}))) keys.add(k);
    return { services: [...new Set(services)].sort(), environments: [...new Set(environments)].sort(), attribute_keys: [...keys].sort().slice(0, 200) };
  }

  usage(): TelemetryUsage {
    const m = month();
    const row = this.rows("SELECT * FROM usage WHERE month = ?", m)[0];
    return {
      month: m,
      ingested_bytes: Number(row?.ingested_bytes ?? 0),
      requests: Number(row?.requests ?? 0),
      logs: Number(row?.logs ?? 0),
      spans: Number(row?.spans ?? 0),
      metric_points: Number(row?.metric_points ?? 0),
      stored_bytes: this.state.storage.sql.databaseSize,
      today_bytes: this.todayBytes(),
    };
  }

  overview(f: TelemetryFilter & { step_s?: number | null }): TelemetryOverview {
    const now = Date.now() * 1000;
    const to = f.to_us ?? now;
    const from = f.from_us ?? to - DAY_US;
    const step = f.step_s && STEPS.includes(f.step_s) ? f.step_s : stepFor(to - from);
    const read = (lo: number, hi: number, detail: boolean) => {
      const { clauses, args } = this.filter({ ...f, from_us: null, to_us: null }, "minute");
      clauses.push("minute >= ?", "minute <= ?", detail ? "route != '*'" : "route = '*'");
      args.push(Math.floor(lo / MINUTE_US), Math.floor(hi / MINUTE_US));
      const counted = this.rows(`SELECT * FROM rollups WHERE ${clauses.join(" AND ")}`, ...args);
      // The newest requests, not counted yet, are counted here as they stand.
      const { clauses: pc, args: pa } = this.filter({ ...f, from_us: lo, to_us: hi }, "time_us");
      pc.push("rolled = 0");
      const pending = aggregate(this.rows(`SELECT * FROM requests WHERE ${pc.join(" AND ")} LIMIT 20000`, ...pa))
        .filter((a) => (detail ? a.route !== "*" : a.route === "*")) as unknown as Row[];
      return [...counted, ...pending];
    };
    const totalsOf = (rows: Row[]): TelemetryTotals => {
      let requests = 0;
      let errors = 0;
      const latency = emptyHistogram();
      const cpu = emptyHistogram();
      for (const r of rows) {
        requests += Number(r.requests);
        errors += Number(r.errors);
        addInto(latency, decode(String(r.latency)));
        addInto(cpu, decode(String(r.cpu)));
      }
      return { requests, errors, error_rate: requests ? errors / requests : 0, latency: percentiles(latency), cpu: percentiles(cpu) };
    };

    const rows = read(from, to, false);
    const previous = read(from - (to - from), from, false);
    const stepMinutes = step / 60;
    const points = new Map<number, { rows: Row[] }>();
    for (const r of rows) {
      const bucket = Math.floor(Number(r.minute) / stepMinutes) * stepMinutes;
      const p = points.get(bucket) ?? { rows: [] };
      p.rows.push(r);
      points.set(bucket, p);
    }
    const series = [];
    for (let m = Math.floor(from / MINUTE_US / stepMinutes) * stepMinutes; m * MINUTE_US <= to; m += stepMinutes) {
      const p = points.get(m)?.rows ?? [];
      const t = totalsOf(p);
      const s = (k: string) => p.reduce((n, r) => n + Number(r[k]), 0);
      series.push({ time_us: m * MINUTE_US, requests: t.requests, errors: t.errors, status_2xx: s("s2"), status_3xx: s("s3"), status_4xx: s("s4"), status_5xx: s("s5"), latency: t.latency, cpu: t.cpu });
    }

    const routes = new Map<string, Row[]>();
    for (const r of read(from, to, true)) {
      const key = `${r.method}\u0000${r.route}`;
      routes.set(key, [...(routes.get(key) ?? []), r]);
    }
    const deployments = new Map<string, Row[]>();
    const services = new Map<string, Row[]>();
    for (const r of rows) {
      if (r.deployment_id) deployments.set(String(r.deployment_id), [...(deployments.get(String(r.deployment_id)) ?? []), r]);
      const sk = `${r.service}\u0000${r.source}`;
      services.set(sk, [...(services.get(sk) ?? []), r]);
    }
    const { clauses: rc, args: ra } = this.filter({ ...f, from_us: from, to_us: to }, "time_us");
    const regions = this.rows(
      `SELECT region, COUNT(*) AS n FROM requests WHERE region IS NOT NULL ${rc.length ? `AND ${rc.join(" AND ")}` : ""} GROUP BY region ORDER BY n DESC LIMIT 20`,
      ...ra,
    );

    return {
      from_us: from,
      to_us: to,
      step_s: step,
      totals: totalsOf(rows),
      previous: totalsOf(previous),
      points: series,
      routes: [...routes.values()]
        .map((list) => {
          const t = totalsOf(list);
          return { route: String(list[0].route), method: strOrNull(list[0].method), requests: t.requests, errors: t.errors, latency: t.latency };
        })
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 50),
      deployments: [...deployments.entries()]
        .map(([id, list]) => {
          const t = totalsOf(list);
          return {
            deployment_id: id,
            environment: strOrNull(list[0].environment),
            commit_sha: strOrNull(list.find((r) => r.commit_sha)?.commit_sha ?? null),
            first_us: Math.min(...list.map((r) => Number(r.minute))) * MINUTE_US,
            requests: t.requests,
            errors: t.errors,
            latency: t.latency,
          };
        })
        .sort((a, b) => b.first_us - a.first_us)
        .slice(0, 20),
      services: [...services.values()]
        .map((list) => ({
          service: String(list[0].service),
          source: list[0].source === "otlp" ? ("otlp" as const) : ("cloudflare" as const),
          requests: list.reduce((n, r) => n + Number(r.requests), 0),
          errors: list.reduce((n, r) => n + Number(r.errors), 0),
          last_us: Math.max(...list.map((r) => Number(r.minute))) * MINUTE_US,
        }))
        .sort((a, b) => b.requests - a.requests),
      regions: regions.map((r) => ({ region: String(r.region), requests: Number(r.n) })),
    };
  }
}

/** A request that failed: a 5xx, an outcome other than ok, or an error the app recorded. */
const ERROR_SQL = "(status >= 500 OR outcome NOT IN ('ok', 'canceled', 'responseStreamDisconnected') OR error_name IS NOT NULL)";

function isError(status: number | null, outcome: string, errorName: SqlStorageValue): boolean {
  return (status !== null && status >= 500) || !["ok", "canceled", "responseStreamDisconnected"].includes(outcome) || (errorName !== null && errorName !== undefined && errorName !== "");
}

function errorOf(r: Row): ErrorGroup {
  return {
    fingerprint: String(r.fingerprint),
    name: String(r.name),
    message: String(r.message),
    stack: strOrNull(r.stack),
    service: String(r.service),
    environment: strOrNull(r.environment),
    first_us: Number(r.first_us),
    last_us: Number(r.last_us),
    count: Number(r.count),
    first_deployment_id: strOrNull(r.first_deployment_id),
    last_request_id: strOrNull(r.last_request_id),
    last_trace_id: strOrNull(r.last_trace_id),
    state: String(r.state) as ErrorGroup["state"],
    issue_number: numOrNull(r.issue_number),
  };
}

/** The step that gives a chart about a hundred points over `rangeUs`. */
export function stepFor(rangeUs: number): number {
  const seconds = rangeUs / 1_000_000;
  return STEPS.find((s) => seconds / s <= 150) ?? STEPS[STEPS.length - 1];
}

/** A percentile from an OTLP histogram's explicit buckets. */
export function histogramQuantile(bounds: number[], counts: number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    if (seen + counts[i] >= rank) {
      const low = i === 0 ? 0 : bounds[i - 1];
      const high = i < bounds.length ? bounds[i] : bounds[bounds.length - 1] ?? low;
      return low + (high - low) * (counts[i] ? (rank - seen) / counts[i] : 0);
    }
    seen += counts[i];
  }
  return bounds[bounds.length - 1] ?? null;
}

/** Requests' counts by minute, service, environment, deployment and route, with all routes together as `*`. */
export type Rollup = {
  minute: number;
  service: string;
  environment: string;
  deployment_id: string;
  commit_sha: string | null;
  source: string;
  method: string;
  route: string;
  requests: number;
  errors: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  latency: string;
  cpu: string;
};

export function aggregate(rows: Row[]): Rollup[] {
  const acc = new Map<string, Omit<Rollup, "latency" | "cpu"> & { latency: number[]; cpu: number[] }>();
  const add = (key: Pick<Rollup, "minute" | "service" | "environment" | "deployment_id" | "commit_sha" | "source" | "method" | "route">, r: Row) => {
    const k = [key.minute, key.service, key.environment, key.deployment_id, key.method, key.route].join("\u0000");
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { ...key, requests: 0, errors: 0, s2: 0, s3: 0, s4: 0, s5: 0, latency: emptyHistogram(), cpu: emptyHistogram() }));
    a.requests++;
    const status = numOrNull(r.status);
    if (isError(status, String(r.outcome), r.error_name)) a.errors++;
    if (status !== null && status >= 200 && status < 600) a[`s${Math.floor(status / 100)}` as "s2" | "s3" | "s4" | "s5"]++;
    a.latency[bucketOf(Number(r.duration_us) / 1000)]++;
    if (r.cpu_ms !== null && r.cpu_ms !== undefined) a.cpu[bucketOf(Number(r.cpu_ms))]++;
  };
  for (const r of rows) {
    const base = {
      minute: Math.floor(Number(r.time_us) / MINUTE_US),
      service: String(r.service ?? ""),
      environment: String(r.environment ?? ""),
      deployment_id: String(r.deployment_id ?? ""),
      commit_sha: strOrNull(r.commit_sha),
      source: String(r.source),
    };
    add({ ...base, method: "*", route: "*" }, r);
    add({ ...base, method: String(r.method ?? ""), route: String(r.route ?? "") }, r);
  }
  return [...acc.values()].map((a) => ({ ...a, latency: encode(a.latency), cpu: encode(a.cpu) }));
}
