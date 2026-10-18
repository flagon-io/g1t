/**
 * Sessions: the runs of agents across a workspace, through the REST API
 * (`GET /workspaces/{workspace}/sessions`). Not the app's sign-in, which
 * is lib/session.tsx. As in lib/work.ts these are the API's snake_case
 * shapes (the camelCase ones are in @g1t/contracts), and only the fields
 * the app shows are named. The hooks are in lib/work.ts.
 *
 * Kept free of React Native imports so `npm test` runs it under Node.
 */

export type Harness = "claude_code" | "claude_managed_agents" | "codex" | "cursor" | "copilot" | "other";

/**
 * Someone's own `harness`, one g1t started on the workspace's Anthropic
 * provider (`hosted`), g1t's own `agent` on a pull request, or what a
 * coding agent `recorded` on a pull request with no session of its own.
 */
export type SessionKind = "harness" | "hosted" | "agent" | "recorded";

/** Active: heard from in 15 minutes; idle: not since; ended: ended, or quiet for 30 minutes. */
export type SessionState = "active" | "idle" | "ended";

export type PullStatus = "draft" | "open" | "merged" | "closed";

/** One run of a harness on a repository: a session, or one of its subagents. */
export type ApiSession = {
  id: string;
  repo_id: string;
  item: number | null;
  pull: number | null;
  branch: string | null;
  actor: { id: string; username: string };
  harness: Harness;
  title: string | null;
  state: SessionState;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  end_reason: string | null;
  parent_id?: string | null;
  agent_type?: string | null;
  task?: string | null;
  model?: string | null;
  subagents?: number;
  first_prompt?: string | null;
};

/** One session of a workspace, whatever its kind. */
export type ApiWorkspaceSession = {
  kind: SessionKind;
  /** `ses_…`, `run_…` for g1t's agent, the pull request's id for a recorded one. */
  id: string;
  /** `owner/name`. */
  repo: string;
  repo_id: string;
  title: string | null;
  /** Who runs it, by username; `g1t` for g1t's own. */
  actor: string | null;
  harness: Harness | null;
  /** For g1t's agent and a recorded one: the agent's label. */
  agent: string | null;
  branch: string | null;
  item: number | null;
  item_title: string | null;
  pull: number | null;
  pull_title: string | null;
  pull_status: PullStatus | null;
  state: SessionState;
  started_at: string;
  last_activity_at: string;
  subagents: number;
  /** For g1t's agent: what it is doing now. */
  step: string | null;
  session: ApiSession | null;
  children?: ApiSession[];
};

export type ApiWorkspaceSessions = {
  sessions: ApiWorkspaceSession[];
  repos: { id: string; path: string; default_branch: string }[];
};

/** What the list shows; each is one of the API's filters. */
export type SessionsFilter = {
  /** `live`: going now; `recent`: every one, newest first; `ended`: those that ended. */
  state: "live" | "recent" | "ended";
  /** A username. */
  person?: string;
  /** A repository of the workspace, by name. */
  repo?: string;
  item?: number;
};

export type EntryKind = "prompt" | "message" | "tool_call" | "tool_result" | "note" | "skill";

/** One step a session recorded. */
export type ApiSessionEntry = {
  seq: number;
  kind: EntryKind;
  text: string;
  tool: string | null;
  commit: string | null;
  at: string;
  /** Its text is not shown to this viewer. */
  withheld?: boolean;
};

export type ApiSessionTouch = { session_id: string; kind: "file" | "commit" | "branch" | "pull" | "item"; value: string; at: string };

/** A work item or pull request the session, or one of its subagents, worked on. */
export type ApiSessionLink = { kind: "item" | "pull"; number: number; title: string; state: string; via: string[]; session_ids: string[] };

/** `GET /workspaces/{workspace}/sessions/{id}`: a session, what it recorded, and its repository. */
export type ApiSessionDetail = {
  session: ApiSession;
  entries: ApiSessionEntry[];
  children?: ApiSession[];
  touched?: ApiSessionTouch[];
  links?: ApiSessionLink[];
  skills?: { session_id: string; name: string; uses: number }[];
  root?: ApiSession | null;
  /** The viewer sees that it runs, who runs it and what it is tied to, nothing more. */
  limited?: boolean;
  /** `owner/name`. */
  repo: string;
};

/** How many entries one answer brings at most; more come with `after`. */
export const ENTRY_PAGE = 500;

const HARNESS_NAMES: Record<Harness, string> = {
  claude_code: "Claude Code",
  claude_managed_agents: "Claude Managed Agents",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "Another harness",
};

export function harnessName(harness: Harness | null | undefined): string | null {
  return harness ? (HARNESS_NAMES[harness] ?? harness) : null;
}

/** What runs it: the harness, or the agent's label for g1t's agent and a recorded one. */
export function runsIn(session: Pick<ApiWorkspaceSession, "kind" | "harness" | "agent">): string {
  if (session.kind === "agent") return session.agent ?? "g1t";
  if (session.kind === "recorded") return session.agent ?? "Recorded";
  return harnessName(session.harness) ?? "Session";
}

/** Live: active or idle, not ended. */
export function isLive(session: { state: SessionState }): boolean {
  return session.state !== "ended";
}

/** A session's name: its title, else the task or first prompt it recorded. */
export function sessionTitle(session: Pick<ApiSession, "title" | "task" | "first_prompt" | "agent_type"> | null, fallback?: string | null): string {
  const text = session?.title ?? fallback ?? session?.task ?? session?.first_prompt ?? null;
  const line = text?.trim().split("\n", 1)[0];
  return line || (session?.agent_type ? `${session.agent_type} subagent` : "Untitled session");
}

/** A workspace session's name in a list. */
export function listTitle(session: ApiWorkspaceSession): string {
  if (session.session) return sessionTitle(session.session, session.title);
  return session.title?.trim() || session.pull_title || (session.pull ? `Pull request #${session.pull}` : "Untitled session");
}

/** Whether a session has a page of its own in the app: someone's harness and hosted ones do. */
export function hasPage(session: Pick<ApiWorkspaceSession, "kind">): boolean {
  return session.kind === "harness" || session.kind === "hosted";
}

/**
 * A session's subagents as a tree, in the order they started, each with
 * how deep it is under `root` (1 for its own). Ones whose parent is not
 * in the list sit under the root.
 */
export function subagentTree<T extends { id: string; parent_id?: string | null; started_at: string }>(
  root: string,
  children: T[],
): { session: T; depth: number }[] {
  const ids = new Set(children.map((child) => child.id));
  const under = new Map<string, T[]>();
  for (const child of [...children].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    const parent = child.parent_id && child.parent_id !== child.id && ids.has(child.parent_id) ? child.parent_id : root;
    under.set(parent, [...(under.get(parent) ?? []), child]);
  }
  const out: { session: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    for (const child of under.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ session: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/** The files a session and its subagents touched, once each, in the order first touched. */
export function touchedFiles(touched: ApiSessionTouch[] | undefined): string[] {
  const files = (touched ?? []).filter((one) => one.kind === "file").sort((a, b) => a.at.localeCompare(b.at));
  return [...new Set(files.map((one) => one.value))];
}

/** The query string for a filter. */
export function sessionsQuery(filter: SessionsFilter): string {
  const params = new URLSearchParams({ state: filter.state });
  if (filter.person) params.set("person", filter.person);
  if (filter.repo) params.set("repo", filter.repo);
  if (filter.item) params.set("item", String(filter.item));
  return params.toString();
}
