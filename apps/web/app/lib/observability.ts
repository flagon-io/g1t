/**
 * A project's Observability pages: what the address says to show (the
 * period, environment, service, deployment and search), and how numbers,
 * times and statuses read. Kept free of server code, for the pages and
 * their tests.
 */
import type { BadgeTone } from "../components/ui/badge";
import type { LogSeverity, TelemetryFilter } from "@g1t/contracts";

/** The periods the pages offer, newest first, with how long each is. */
export const RANGES = [
  { key: "15m", label: "15 minutes", ms: 15 * 60_000 },
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "6h", label: "6 hours", ms: 6 * 3_600_000 },
  { key: "24h", label: "24 hours", ms: 86_400_000 },
  { key: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { key: "30d", label: "30 days", ms: 30 * 86_400_000 },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export const DEFAULT_RANGE: RangeKey = "24h";

/** What the address asks to see. */
export type View = {
  range: RangeKey;
  environment: string | null;
  service: string | null;
  deployment: string | null;
  q: string;
};

export function parseView(params: URLSearchParams): View {
  const range = RANGES.find((r) => r.key === params.get("range"))?.key ?? DEFAULT_RANGE;
  const text = (key: string) => {
    const value = params.get(key)?.trim();
    return value ? value.slice(0, 200) : null;
  };
  return { range, environment: text("env"), service: text("service"), deployment: text("deployment"), q: text("q") ?? "" };
}

/** The view as the service's filter, ending `now`. */
export function filterOf(view: View, now = Date.now()): TelemetryFilter {
  const ms = RANGES.find((r) => r.key === view.range)!.ms;
  return {
    from_us: (now - ms) * 1000,
    to_us: now * 1000,
    environments: view.environment ? [view.environment] : null,
    services: view.service ? [view.service] : null,
    deployment_id: view.deployment,
  };
}

/** The address of `path` with the view, changed by `change` (null drops a parameter). */
export function viewHref(path: string, view: View, change: Partial<Record<"range" | "env" | "service" | "deployment" | "q" | string, string | null>> = {}): string {
  const params = new URLSearchParams();
  const base: Record<string, string | null> = {
    range: view.range === DEFAULT_RANGE ? null : view.range,
    env: view.environment,
    service: view.service,
    deployment: view.deployment,
    q: view.q || null,
  };
  for (const [key, value] of Object.entries({ ...base, ...change })) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

// ---- Numbers ---------------------------------------------------------------

/** A duration in milliseconds as people read one: `840 µs`, `12 ms`, `1.4 s`, `2m 5s`. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms === 0) return "0";
  if (ms < 1) return `${Math.round(ms * 1000)} µs`;
  if (ms < 10) return `${ms.toFixed(1).replace(/\.0$/, "")} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1).replace(/\.?0+$/, "")} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** A count, short: `940`, `12.4K`, `3.1M`. */
export function count(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 1 })}B`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (n >= 1e4) return `${(n / 1e3).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  return Math.round(n).toLocaleString("en-US");
}

/** A share (0–1) as a percentage, with as many places as a small one needs. */
export function percent(share: number): string {
  if (!Number.isFinite(share) || share === 0) return "0%";
  const p = share * 100;
  if (p < 0.01) return "<0.01%";
  return `${p.toLocaleString("en-US", { maximumFractionDigits: p < 1 ? 2 : 1 })}%`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

/**
 * How a number moved from the period before: the change as a share, and
 * whether that is good. For latency and errors, down is good.
 */
export function change(now: number | null, before: number | null, lowerIsBetter: boolean): { text: string; good: boolean | null } | null {
  if (now === null || before === null || before === 0) return null;
  const share = (now - before) / before;
  if (Math.abs(share) < 0.005) return { text: "no change", good: null };
  const text = `${share > 0 ? "+" : "−"}${percent(Math.abs(share))}`;
  return { text, good: lowerIsBetter ? share < 0 : share > 0 };
}

/** Round values for an axis from 0 to at least `max`, about `count` of them. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const out: number[] = [];
  for (let v = 0; out.length === 0 || out[out.length - 1]! < max; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

// ---- Statuses --------------------------------------------------------------

export function statusTone(status: number | null, outcome?: string | null): BadgeTone {
  if (outcome && outcome !== "ok" && outcome !== "canceled" && outcome !== "responseStreamDisconnected") return "danger";
  if (status === null) return "neutral";
  if (status >= 500) return "danger";
  if (status >= 400) return "warn";
  if (status >= 300) return "info";
  return "success";
}

export const LEVEL_TONE: Record<LogSeverity, BadgeTone> = {
  trace: "neutral",
  debug: "neutral",
  info: "info",
  warn: "warn",
  error: "danger",
  fatal: "danger",
};

/**
 * Chart colors. Latency percentiles are the site's first three categorical
 * slots (lib/usage.ts, validated against both surfaces); requests by
 * outcome use the status colors, each named in the legend.
 */
export const SERIES = {
  p50: "#3987e5",
  p95: "#d95926",
  p99: "#199e70",
  ok: "var(--color-accent)",
  client: "var(--color-warn)",
  server: "var(--color-danger)",
} as const;

/** A time on an axis: the hour for a day or less, the date beyond. */
export function axisTime(us: number, spanMs: number): string {
  const at = new Date(us / 1000);
  // A day and a bit (a 24-hour chart has a step more than a day) reads by the hour.
  if (spanMs <= 2 * 86_400_000) return at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A time to the second (or the millisecond, for logs), in UTC so the server and browser agree. */
export function clock(us: number, millis = false): string {
  const iso = new Date(us / 1000).toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, millis ? 23 : 19)}`;
}

export function shortId(id: string | null | undefined, n = 8): string {
  return id ? id.slice(0, n) : "";
}

/** OpenTelemetry's environment variables for software sending here, in a shell's syntax. */
export function otelEnv(endpoint: string, service: string, token: string): string {
  return [
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
    `OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${token}"`,
    `OTEL_SERVICE_NAME=${service}`,
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production`,
  ].join("\n");
}

/**
 * Whether a log line that arrived live belongs on the page: the same
 * search the service runs (words in the line, `level:`, `key=value`),
 * read here for lines that did not come through it.
 */
export function matchesLog(
  log: { severity: LogSeverity; body: string; environment: string | null; service: string; deployment_id: string | null; attributes: Record<string, unknown> } & Record<string, unknown>,
  view: View,
  levels: LogSeverity[],
): boolean {
  if (view.environment && log.environment !== view.environment) return false;
  if (view.service && log.service !== view.service) return false;
  if (view.deployment && log.deployment_id !== view.deployment) return false;
  const wanted = new Set<string>(levels);
  const body = log.body.toLowerCase();
  for (const m of view.q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const token = m[1] ?? m[2]!;
    const pair = m[1] ? null : /^([\w.@/-]+)[=:](.+)$/.exec(token);
    if (pair && !/^https?$/.test(pair[1]!)) {
      const [, key, value] = pair;
      if (key === "level" || key === "severity") wanted.add(value!.toLowerCase());
      else if (String(log.attributes[key!] ?? log[key!] ?? "") !== value) return false;
    } else if (!body.includes(token.toLowerCase())) return false;
  }
  return wanted.size === 0 || wanted.has(log.severity);
}

/** The issue made for an error group, for a person or an agent to take: what happened, how often, since when, and where to look. */
export function errorIssue(
  group: { name: string; message: string; stack: string | null; count: number; first_us: number; last_us: number; service: string; environment: string | null; first_deployment_id: string | null; last_request_id: string | null; last_trace_id: string | null },
  pageUrl: string,
): { title: string; body: string } {
  const title = `${group.name}: ${group.message}`.replace(/\s+/g, " ").slice(0, 120);
  const day = (us: number) => new Date(us / 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    `\`${group.name}\` in **${group.service || "the app"}**${group.environment ? ` (${group.environment})` : ""}: ${group.count.toLocaleString("en-US")} time${group.count === 1 ? "" : "s"}, first ${day(group.first_us)}, last ${day(group.last_us)}.`,
    "",
    "```",
    group.message,
    "```",
  ];
  if (group.stack) lines.push("", "Stack:", "", "```", group.stack.slice(0, 6000), "```");
  const links = [
    group.first_deployment_id && `- First seen on deployment \`${group.first_deployment_id}\``,
    group.last_request_id && `- The latest request: ${pageUrl}/requests/${group.last_request_id}`,
    group.last_trace_id && `- Its trace: ${pageUrl}/traces/${group.last_trace_id}`,
    `- Every occurrence: ${pageUrl}/errors`,
  ].filter(Boolean);
  lines.push("", ...(links as string[]));
  return { title, body: lines.join("\n") };
}
