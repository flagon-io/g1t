/**
 * Sessions as the site shows them across a workspace: what each is called
 * and where it opens, the filters Sessions keeps in its address, and live
 * ones apart from the rest. Pure, so it is tested under Node.
 */
import type { Harness, SessionKind, WorkSession, WorkspaceSession } from "@g1t/contracts";

import { HARNESS_NAMES, sessionTitle } from "./coordination.ts";
import { sessionPath } from "./work-items.ts";

/** How each kind is named in a filter. */
export const KIND_NAMES: Record<SessionKind, string> = {
  harness: "People's harnesses",
  hosted: "Started on g1t",
  agent: "g1t's agent",
  recorded: "Recorded on pull requests",
};

/** What a session is called, never nothing. */
export function workspaceSessionTitle(session: WorkspaceSession): string {
  if (session.session) {
    const own = session.session;
    if (!own.title?.trim() && own.parentId) return [own.agentType ?? "Subagent", own.task].filter(Boolean).join(": ");
    return sessionTitle(own);
  }
  return session.title?.trim() || session.pullTitle?.trim() || (session.pull != null ? `Pull request #${session.pull}` : "Untitled session");
}

/**
 * What a session is called on a work item's card: its own title, else
 * what it is doing there. Never a bare "Pull request #N", whose number
 * would read as the work item's.
 */
export function onItemSessionTitle(session: WorkspaceSession): string {
  if (session.session || session.title?.trim() || session.pullTitle?.trim()) return workspaceSessionTitle(session);
  return session.pull != null ? `On pull request #${session.pull}` : "Working on it";
}

/** What runs it, in a few words: the harness, g1t's agent, or the agent that recorded it. */
export function runsIn(session: Pick<WorkspaceSession, "kind" | "harness" | "agent">): string {
  if (session.kind === "agent") return "g1t's agent";
  if (session.harness) return HARNESS_NAMES[session.harness] ?? session.harness;
  return session.agent ? `${session.agent}, recorded` : "Recorded";
}

/**
 * Where a session opens: a harness or hosted session's own page; g1t's
 * agent and a recorded session are their pull request's Session tab; one
 * with neither opens nowhere.
 */
export function sessionHref(workspace: string, session: Pick<WorkspaceSession, "kind" | "id" | "repo" | "pull">): string | null {
  if (session.kind === "harness" || session.kind === "hosted") return sessionPath(workspace, session.id);
  return session.pull != null ? `/${session.repo}/pull/${session.pull}/session` : null;
}

/** The filters Sessions keeps in its address. */
export type SessionsFilters = {
  /** `recent`: every session in one list; otherwise Live now, then what ended. */
  state: "live" | "recent";
  repo: string | null;
  person: string | null;
  harness: Harness | null;
  kind: SessionKind | null;
  /** The work item they are on, by number: a work item's own sessions. */
  item: number | null;
};

export function sessionsFilters(query: URLSearchParams): SessionsFilters {
  // Read when asked, not as the module loads: HARNESS_NAMES comes from
  // another module, which a bundle can load after this one.
  const harnesses = Object.keys(HARNESS_NAMES);
  const kinds = Object.keys(KIND_NAMES);
  const harness = query.get("harness");
  const kind = query.get("kind");
  const text = (key: string) => query.get(key)?.trim().replace(/^@/, "") || null;
  return {
    state: query.get("state") === "recent" ? "recent" : "live",
    repo: text("repo"),
    person: text("person"),
    harness: harness && harnesses.includes(harness) ? (harness as Harness) : null,
    kind: kind && kinds.includes(kind) ? (kind as SessionKind) : null,
    item: /^\d+$/.test(query.get("item") ?? "") && Number(query.get("item")) > 0 ? Number(query.get("item")) : null,
  };
}

/** The address of Sessions with `filters`, leaving out what is as it is by default. */
export function sessionsQuery(filters: Partial<SessionsFilters>): string {
  const query = new URLSearchParams();
  if (filters.state === "recent") query.set("state", "recent");
  for (const key of ["repo", "person", "harness", "kind", "item"] as const) {
    const value = filters[key];
    if (value) query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Whether any filter narrows the list. */
export function narrowed(filters: SessionsFilters): boolean {
  return Boolean(filters.repo || filters.person || filters.harness || filters.kind || filters.item);
}

/**
 * Live sessions apart: those going now (active first, then idle, each the
 * most recently heard from first) and those that ended.
 */
export function splitLive(sessions: WorkspaceSession[]): { active: WorkspaceSession[]; idle: WorkspaceSession[]; ended: WorkspaceSession[] } {
  const by = (state: WorkspaceSession["state"]) =>
    sessions.filter((session) => session.state === state).sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  return { active: by("active"), idle: by("idle"), ended: by("ended") };
}

/** The people running sessions in a list, each once, most active first, for its filter. */
export function peopleIn(sessions: WorkspaceSession[]): string[] {
  const counts = new Map<string, number>();
  for (const session of sessions) if (session.actor) counts.set(session.actor, (counts.get(session.actor) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

/**
 * What a session cost, in a few words: "≈ $4.12 at list price", with
 * "some usage priced as unknown" when some of it was for models g1t has no
 * price for. Null when it reported no usage.
 */
export function sessionCost(session: Pick<WorkSession, "costUsd" | "costPartial"> | null | undefined): string | null {
  if (!session) return null;
  const cost = session.costUsd;
  if (cost == null || !Number.isFinite(cost)) return session.costPartial ? "Usage priced as unknown" : null;
  const amount = cost > 0 && cost < 0.01 ? "under $0.01" : `$${cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `≈ ${amount} at list price${session.costPartial ? ", some usage priced as unknown" : ""}`;
}

/** `acme/web` as the workspace `acme` names it: `web`. */
export function repoName(path: string, workspace: string): string {
  const [owner, name] = path.split("/");
  return owner?.toLowerCase() === workspace.toLowerCase() && name ? name : path;
}
