/**
 * Small readings shared by both doors: routes with their ids taken out,
 * severities, ids, and text kept to a size.
 */
import type { LogSeverity } from "@g1t/contracts/telemetry";

/** A log body or a message is kept to this many characters. */
export const MAX_TEXT = 16_384;
/** An attribute's string value, to this many. */
export const MAX_VALUE = 4_096;

export function clip(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\d+$/;
const HEXISH = /^[0-9a-f]{12,}$/i;
/** Long tokens that mix letters and digits: slugs with ids, base64, ulids. */
const TOKENISH = /^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{16,}$/i;

/**
 * The path with its ids taken out, so `/users/42` and `/users/43` count
 * as one route: `/users/:id`. Files keep their names; the query goes.
 */
export function route(path: string): string {
  const bare = path.split(/[?#]/)[0] || "/";
  const parts = bare.split("/").map((part) => {
    if (part === "") return part;
    let decoded = part;
    try {
      decoded = decodeURIComponent(part);
    } catch {}
    if (NUMBER.test(decoded) || UUID.test(decoded) || HEXISH.test(decoded) || TOKENISH.test(decoded)) return ":id";
    return part;
  });
  const joined = parts.join("/");
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}

/** Host and path, without the query or the scheme. */
export function hostPath(url: string): { url: string; path: string } | null {
  try {
    const u = new URL(url);
    return { url: `${u.host}${u.pathname}`, path: u.pathname };
  } catch {
    return null;
  }
}

/** OpenTelemetry's severity number (1–24) for a console level or a severity text. */
export function severityNumber(level: string | undefined | null): number {
  switch ((level ?? "").toLowerCase()) {
    case "trace":
      return 1;
    case "debug":
      return 5;
    case "log":
    case "info":
    case "information":
    case "notice":
      return 9;
    case "warn":
    case "warning":
      return 13;
    case "error":
    case "err":
      return 17;
    case "fatal":
    case "critical":
    case "crit":
    case "emergency":
    case "alert":
      return 21;
    default:
      return 9;
  }
}

/** The level a severity number falls in. 0 (unset) reads as info. */
export function severityOf(n: number): LogSeverity {
  if (n >= 21) return "fatal";
  if (n >= 17) return "error";
  if (n >= 13) return "warn";
  if (n >= 9 || n <= 0) return "info";
  if (n >= 5) return "debug";
  return "trace";
}

/** Lowest severity number of each level, to filter by. */
export const SEVERITY_FLOOR: Record<LogSeverity, [number, number]> = {
  trace: [1, 4],
  debug: [5, 8],
  info: [9, 12],
  warn: [13, 16],
  error: [17, 20],
  fatal: [21, 24],
};

/** A random id of `bytes` bytes, as hex: trace ids are 16, span and request ids 8. */
export function randomId(bytes = 8): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A lowercase hex id, or null for one that is empty, all zeros, or not hex. */
export function hexId(id: string | undefined | null, length: number): string | null {
  if (!id) return null;
  let hex = id.toLowerCase();
  // OTLP/JSON writes ids as hex, but some exporters send base64.
  if (!/^[0-9a-f]+$/.test(hex)) {
    try {
      hex = [...atob(id)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }
  if (hex.length !== length || /^0+$/.test(hex)) return null;
  return hex;
}

/** Nanoseconds (as OTLP writes them, a decimal string or a number) to microseconds. */
export function nanosToMicros(nanos: string | number | undefined | null): number | null {
  if (nanos === undefined || nanos === null || nanos === "" || nanos === "0" || nanos === 0) return null;
  try {
    const n = typeof nanos === "number" ? BigInt(Math.trunc(nanos)) : BigInt(nanos);
    return Number(n / 1000n);
  } catch {
    return null;
  }
}

/** Anything a console call was given, as one line of text. */
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : safeJson(v))).join(" ");
  return safeJson(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
