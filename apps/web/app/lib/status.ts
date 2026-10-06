/**
 * What /status shows and the footer's dot is coloured by: each public part
 * of g1t, whether it answered a quick check, and one line for the whole.
 *
 * The checks themselves run on the server (status.server.ts). This module
 * only says what a check's result means, so it can be tested on its own.
 * Fields are snake_case: /status.json is public, like the API.
 */

export type ComponentState = "up" | "degraded" | "down" | "unmonitored";
export type OverallState = "up" | "degraded" | "down" | "unknown";

export type ComponentKey =
  | "site"
  | "api"
  | "git"
  | "mcp"
  | "docs"
  | "deployments"
  | "agents"
  | "sandboxes"
  | "billing";

export type ComponentInfo = {
  key: ComponentKey;
  name: string;
  /** Where people meet it. */
  address: string;
  /** What the check actually looks at, said plainly on the page. */
  checks: string;
  /** Whether g1t as a whole is down when this is. */
  core: boolean;
};

/** The public parts of g1t, in the order the page lists them. */
export const COMPONENTS: ComponentInfo[] = [
  {
    key: "site",
    name: "Website and sign-in",
    address: "g1t.sh",
    checks: "The account service every page asks who is signed in.",
    core: true,
  },
  { key: "api", name: "API", address: "api.g1t.sh", checks: "The API's front page, over the public internet.", core: true },
  {
    key: "git",
    name: "Git and repositories",
    address: "g1t.sh/<owner>/<repo>.git",
    checks: "The repository service looking up a public repository. Clones and pushes themselves are not exercised.",
    core: true,
  },
  { key: "mcp", name: "MCP server", address: "mcp.g1t.sh", checks: "The MCP server's description, over the public internet.", core: false },
  { key: "docs", name: "Documentation", address: "docs.g1t.sh", checks: "The documentation's front page.", core: false },
  {
    key: "deployments",
    name: "Deployments",
    address: "*.g1t.page",
    checks: "g1t.page answering. Each deployed app is not checked one by one.",
    core: false,
  },
  {
    key: "agents",
    name: "Agents' model proxy",
    address: "models.g1t.sh",
    checks: "The proxy g1t's agents reach their model through. The model providers behind it are not checked.",
    core: false,
  },
  {
    key: "sandboxes",
    name: "Sandboxes",
    address: "Agents, checks, workflows and builds",
    checks: "Starting a sandbox costs money and takes seconds, so it is not checked from here yet.",
    core: false,
  },
  {
    key: "billing",
    name: "Billing",
    address: "g1t.sh/<workspace>/-/billing",
    checks: "The billing service reading its price book. Stripe itself is not checked.",
    core: false,
  },
];

/** A check's raw outcome. */
export type ProbeResult = {
  ok: boolean;
  /** How long it took, in milliseconds. */
  ms: number;
  /** Why it failed, in a few words: "timed out", "HTTP 502". */
  error?: string;
};

/** Slower than this, a part that answered counts as degraded. */
export const SLOW_MS = 1500;

export type ComponentStatus = {
  key: ComponentKey;
  name: string;
  address: string;
  checks: string;
  state: ComponentState;
  /** What was seen, for the page: "Answered in 84 ms", "Timed out". */
  detail: string;
  latency_ms: number | null;
};

/** What a check's result means for its part. `null` is a part with no check. */
export function classify(result: ProbeResult | null, slowMs = SLOW_MS): { state: ComponentState; detail: string } {
  if (!result) return { state: "unmonitored", detail: "Not monitored yet" };
  if (!result.ok) {
    const why = result.error ?? "no answer";
    return { state: "down", detail: `Failed: ${why}` };
  }
  const ms = Math.round(result.ms);
  if (ms > slowMs) return { state: "degraded", detail: `Slow: answered in ${ms} ms` };
  return { state: "up", detail: `Answered in ${ms} ms` };
}

/** One component's row, from its check. */
export function componentStatus(info: ComponentInfo, result: ProbeResult | null, slowMs = SLOW_MS): ComponentStatus {
  const { state, detail } = classify(result, slowMs);
  return {
    key: info.key,
    name: info.name,
    address: info.address,
    checks: info.checks,
    state,
    detail,
    latency_ms: result ? Math.round(result.ms) : null,
  };
}

export type IncidentUpdate = { at: string; text: string };

export type Incident = {
  id: string;
  title: string;
  /** How bad it is while open. */
  impact: "degraded" | "down";
  components: ComponentKey[];
  started_at: string;
  /** Null while it is still going on. */
  resolved_at: string | null;
  /** Newest first. */
  updates: IncidentUpdate[];
};

/**
 * Incidents, newest first. Written by hand, in code, for now: add one when
 * something breaks, with updates as it is fixed, and set `resolved_at` once
 * it is. The page shows the last 90 days.
 */
export const INCIDENTS: Incident[] = [];

/** How far back the page lists incidents. */
export const INCIDENT_DAYS = 90;

export type Overall = { state: OverallState; line: string };

const RANK: Record<OverallState, number> = { unknown: 0, up: 1, degraded: 2, down: 3 };

function worse(a: OverallState, b: OverallState): OverallState {
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * One line for the whole: down when a core part is down, degraded when any
 * part is down or slow or an incident is open, up when every checked part
 * answered. Parts that are not checked never make it look better or worse.
 */
export function summarize(components: ComponentStatus[], incidents: Incident[] = []): Overall {
  const core = new Set(COMPONENTS.filter((c) => c.core).map((c) => c.key));
  const monitored = components.filter((c) => c.state !== "unmonitored");
  const open = incidents.filter((incident) => incident.resolved_at == null);
  if (monitored.length === 0 && open.length === 0) {
    return { state: "unknown", line: "Status is not available right now" };
  }
  let state: OverallState = monitored.length > 0 ? "up" : "unknown";
  for (const c of monitored) {
    if (c.state === "down") state = worse(state, core.has(c.key) ? "down" : "degraded");
    else if (c.state === "degraded") state = worse(state, "degraded");
  }
  for (const incident of open) state = worse(state, incident.impact);

  const failing = monitored.filter((c) => c.state === "down" || c.state === "degraded").map((c) => c.name);
  if (state === "up") return { state, line: "All monitored systems are working" };
  if (state === "down") {
    return { state, line: failing.length ? `Major outage: ${failing.join(", ")}` : "Major outage" };
  }
  if (state === "degraded") {
    if (failing.length) return { state, line: `Some systems are having trouble: ${failing.join(", ")}` };
    return { state, line: open[0] ? `Investigating: ${open[0].title}` : "Some systems are having trouble" };
  }
  return { state, line: "Status is not available right now" };
}

export type StatusReport = {
  checked_at: string;
  overall: Overall;
  components: ComponentStatus[];
  incidents: Incident[];
};

/** Incidents still open, or resolved within `days` of `now`. */
export function recentIncidents(incidents: Incident[], now: Date, days = INCIDENT_DAYS): Incident[] {
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;
  return incidents.filter((incident) => incident.resolved_at == null || Date.parse(incident.resolved_at) >= since);
}

/** The whole report, from each part's check. */
export function report(results: Partial<Record<ComponentKey, ProbeResult | null>>, now: Date, incidents = INCIDENTS): StatusReport {
  const components = COMPONENTS.map((info) => componentStatus(info, results[info.key] ?? null));
  const recent = recentIncidents(incidents, now);
  return { checked_at: now.toISOString(), overall: summarize(components, recent), components, incidents: recent };
}

/** Words for a part's state. */
export const STATE_LABEL: Record<ComponentState, string> = {
  up: "Operational",
  degraded: "Degraded",
  down: "Down",
  unmonitored: "Not monitored yet",
};

/** The dot's colour for a state, as a Tailwind background class. */
export function dotClass(state: ComponentState | OverallState | null | undefined): string {
  switch (state) {
    case "up":
      return "bg-accent";
    case "degraded":
      return "bg-warn";
    case "down":
      return "bg-danger";
    default:
      return "bg-faint";
  }
}
