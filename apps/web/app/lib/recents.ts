/**
 * Sessions in Chat's sidebar (components/chat/sidebar.tsx): the viewer's
 * agent sessions, newest activity first, in their own section below Direct
 * messages. A conversation (with a person, or with g1t) is not a session:
 * the sessions it starts are linked from it. They come from
 * `-/recents.json` (routes/workspace/recents-json.ts).
 * Pure, so it is tested under Node.
 */
import type { AgentApproval, Harness, SessionKind, WorkspaceSession } from "@g1t/contracts";

import { workspaceSessionTitle } from "./sessions.ts";

/** Sessions shown before Show all; one waiting on the viewer, or open, always shows. */
export const RECENTS_SHOWN = 10;

/**
 * Where a session stands, as its dot says: working (live), waiting on the
 * viewer (a call they may answer waits), idle (between turns), or ended.
 */
export type RecentStatus = "working" | "waiting" | "idle" | "ended";

/** One agent session in Recents. */
export type RecentSession = {
  /** `ses_…`: it opens at `-/chat/sessions/:id`. */
  id: string;
  kind: SessionKind;
  harness: Harness | null;
  title: string;
  status: RecentStatus;
  /** RFC 3339: its latest activity. */
  at: string;
};

/** What Recents' sessions are read from. */
export type RecentsInput = {
  /** The viewer's username. */
  me: string;
  /** The sessions the viewer runs, newest first. */
  mine: WorkspaceSession[];
  /** The workspace's sessions going now, whoever runs them. */
  live: WorkspaceSession[];
  /** The work items assigned to the viewer, by number. */
  items: readonly number[];
  /** The calls waiting on the viewer's answer; null when they could not be read. */
  approvals: AgentApproval[] | null;
};

/** At most this many sessions are sent to the sidebar. */
export const MAX_RECENT_SESSIONS = 20;

/**
 * The viewer's agent sessions for Recents: those they started, those on
 * their work items, and any waiting on their answer; harness and hosted
 * sessions only, which have a page of their own. Each once, newest
 * activity first, with its status.
 */
export function recentSessions(input: RecentsInput, max = MAX_RECENT_SESSIONS): RecentSession[] {
  const me = input.me.toLowerCase();
  const items = new Set(input.items);
  const waiting = new Set((input.approvals ?? []).filter((approval) => approval.status === "waiting").map((approval) => approval.sessionId));
  const seen = new Set<string>();
  const out: RecentSession[] = [];
  for (const session of [...input.mine, ...input.live]) {
    if (seen.has(session.id) || (session.kind !== "harness" && session.kind !== "hosted")) continue;
    const ours = session.actor?.toLowerCase() === me || (session.item != null && items.has(session.item)) || waiting.has(session.id);
    if (!ours) continue;
    seen.add(session.id);
    out.push({
      id: session.id,
      kind: session.kind,
      harness: session.harness,
      title: workspaceSessionTitle(session),
      status: waiting.has(session.id) ? "waiting" : session.state === "active" ? "working" : session.state,
      at: session.lastActivityAt,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}

/**
 * The sessions the sidebar's filter and search leave: every one under All,
 * those waiting on the viewer under Unread (they want an answer), none
 * under Mentions; a search matches their titles.
 */
export function filterSessions(sessions: RecentSession[], filter: "all" | "unread" | "mentions", query: string): RecentSession[] {
  const q = query.trim().toLowerCase();
  return sessions.filter(
    (session) => (filter === "all" || (filter === "unread" && session.status === "waiting")) && (!q || session.title.toLowerCase().includes(q)),
  );
}

/**
 * The rows shown while the list is short: the first `max`, and after them
 * any that must stay in view (`keep`: a session waiting on the viewer, or
 * open). How many more Show all reveals.
 */
export function shortRecents<T>(rows: T[], max: number, keep: (row: T) => boolean): { shown: T[]; more: number } {
  const shown = rows.filter((row, index) => index < max || keep(row));
  return { shown, more: rows.length - shown.length };
}
