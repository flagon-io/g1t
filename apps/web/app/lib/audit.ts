/**
 * The audit log, as the site shows and exports it: who may see what, the
 * filters a page's address carries, and the CSV and JSON it downloads.
 * Pure, so it can be tested; the server side is in audit.server.ts.
 */

import type {
  ActorKind,
  AuditEntry,
  AuditOutcome,
  AuditQuery,
  AuditVisibility,
  Role,
} from "@g1t/contracts";

/**
 * How much of a workspace's log a viewer sees: an owner everything; a
 * member what was done to the workspace's projects, and what they did or
 * had done for them; anyone else nothing.
 */
export function visibilityFor(role: Role | null, username: string): AuditVisibility | null {
  if (role === "owner") return { kind: "all" };
  if (role === "member") return { kind: "projects", username };
  return null;
}

/**
 * The earliest time a workspace's log can be read from, given how many
 * days are kept (90 on every plan): the later of what was asked
 * for and the start of the window.
 */
export function retainedSince(since: string | null | undefined, days: number, now = Date.now()): string {
  const start = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  return since && since > start ? since : start;
}

/** The filters a page's address can carry. */
export type AuditFilters = {
  actor: string;
  agent: string;
  action: string;
  project: string;
  outcome: "" | AuditOutcome;
  kind: "" | ActorKind;
  run: string;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  before: string;
};

const OUTCOMES: AuditOutcome[] = ["allowed", "denied"];
const KINDS: ActorKind[] = ["person", "agent", "workspace"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function clean(value: string | null, max = 120): string {
  return (value ?? "").trim().slice(0, max);
}

export function parseFilters(params: URLSearchParams): AuditFilters {
  const outcome = clean(params.get("outcome"));
  const kind = clean(params.get("kind"));
  const day = (name: string) => {
    const value = clean(params.get(name));
    return DAY.test(value) ? value : "";
  };
  return {
    actor: clean(params.get("actor")),
    agent: clean(params.get("agent")),
    action: clean(params.get("action")),
    project: clean(params.get("project")),
    outcome: OUTCOMES.includes(outcome as AuditOutcome) ? (outcome as AuditOutcome) : "",
    kind: KINDS.includes(kind as ActorKind) ? (kind as ActorKind) : "",
    run: clean(params.get("run")),
    from: day("from"),
    to: day("to"),
    before: clean(params.get("before")),
  };
}

/** The day after `day`, for an inclusive end. */
function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** What to ask the log for. `project` is a project's name in `workspace`, or `owner/name`. */
export function toQuery(
  workspace: string,
  visibility: AuditVisibility,
  filters: AuditFilters,
  limit: number,
): AuditQuery {
  const project = filters.project.includes("/") ? filters.project : filters.project ? `${workspace}/${filters.project}` : null;
  return {
    workspace,
    visibility,
    actor: filters.actor || null,
    agent: filters.agent || null,
    action: filters.action || null,
    repo: project,
    outcome: filters.outcome || null,
    actorKind: filters.kind || null,
    runIds: filters.run ? [filters.run] : [],
    since: filters.from ? `${filters.from}T00:00:00.000Z` : null,
    until: filters.to ? `${nextDay(filters.to)}T00:00:00.000Z` : null,
    before: filters.before || null,
    limit,
  };
}

/** The address of the same view with `changes` applied, for links. */
export function filterHref(base: string, filters: AuditFilters, changes: Partial<AuditFilters> = {}): string {
  const merged = { ...filters, ...changes };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

/** Who acted, as people read it: "g1t on behalf of syntaqx". */
export function actorLabel(entry: Pick<AuditEntry, "actor" | "agent" | "onBehalfOf">): string {
  return entry.onBehalfOf ? `${entry.agent ?? entry.actor} on behalf of ${entry.onBehalfOf}` : entry.actor;
}

/** What it was done to: `acme/rocket#12`, with a ref or path when there is one. */
export function targetLabel(entry: Pick<AuditEntry, "workspace" | "repo" | "number" | "gitRef" | "path">): string {
  const where = entry.repo ? `${entry.repo}${entry.number != null ? `#${entry.number}` : ""}` : entry.workspace;
  const what = [entry.gitRef, entry.path].filter(Boolean).join(" ");
  return what ? `${where} ${what}` : where;
}

/** An operation's name as a phrase: `create_issue` is "create issue". */
export function actionLabel(action: string): string {
  if (action === "git.push") return "git push";
  if (action === "git.fetch") return "git fetch";
  return action.replaceAll("_", " ");
}

export const CSV_COLUMNS = [
  "id",
  "time",
  "workspace",
  "actorKind",
  "actor",
  "agent",
  "onBehalfOf",
  "runId",
  "runKind",
  "credentialId",
  "action",
  "surface",
  "repo",
  "number",
  "gitRef",
  "path",
  "outcome",
  "rule",
  "result",
  "message",
  "requestId",
] as const satisfies readonly (keyof AuditEntry)[];

function csvCell(value: unknown): string {
  if (value == null) return "";
  let text = String(value);
  // A spreadsheet runs a cell that starts like a formula; keep it text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV, a header row and one row per entry. */
export function toCsv(entries: AuditEntry[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const entry of entries) rows.push(CSV_COLUMNS.map((column) => csvCell(entry[column])).join(","));
  return `${rows.join("\r\n")}\r\n`;
}

/** The download's file name: `acme-audit-2026-10-04.csv`. */
export function exportName(workspace: string, format: "csv" | "json", now: Date): string {
  return `${workspace}-audit-${now.toISOString().slice(0, 10)}.${format}`;
}

/** Plain words for the rule that decided an entry. */
export function ruleLabel(rule: string): string {
  if (rule === "never") return "never allowed for agents";
  if (rule === "scope:operation") return "not in the run's scope";
  if (rule === "scope:repository") return "outside the run's repository";
  if (rule === "scope:pull") return "outside the run's pull request";
  if (rule === "on-behalf-of:membership") return "the person it works for is not a member";
  if (rule === "git:push") return "no push grant";
  if (rule === "git:read") return "no read grant";
  if (rule === "git:ref") return "branch not granted";
  if (rule === "git:not-a-run") return "tools token used with git";
  if (rule === "service" || rule === "repository") return "refused by the repository's rules";
  if (rule === "person") return "the person's own access";
  if (rule === "workspace-token") return "the workspace token's access";
  const run = /^run:([a-z]+)\/(runner|tools)(?::(push|read))?$/.exec(rule);
  if (run) return `${run[1]} run ${run[2] === "tools" ? "tools" : "runner"}${run[3] ? ` (${run[3]})` : ""}`;
  return rule;
}
