/**
 * `-/recents.json`: the viewer's agent sessions in this workspace for
 * Recents in Chat's sidebar (components/chat/sidebar.tsx), each with its
 * status: those they started, those on the work items assigned to them,
 * and any whose call waits on their answer (lib/recents.ts). Read off the
 * layout, as the sidebar is, when it is drawn, when the window comes back
 * into view and when something tells of a change, never kept.
 */
import { LIST_PAGE, type Result } from "@g1t/contracts";

import type { Route } from "./+types/recents-json";
import { type Failed, orElse, part } from "../../lib/partial";
import { type RecentSession, MAX_RECENT_SESSIONS, recentSessions } from "../../lib/recents";
import { agentSessions, work } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";

/** The workspace's sessions going now that are read, to find those on the viewer's work items or waiting on them. */
const LIVE = 60;

export type RecentsData = {
  /** Null when they could not be read. */
  sessions: RecentSession[] | null;
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const headers = { "cache-control": "private, no-store" };
  const viewer = getViewer(context);
  if (!viewer) return Response.json(null, { status: 401, headers });
  const workspace = params.owner.toLowerCase();
  // A guest has no sessions here: the sidebar shows them none.
  if (!roleIn(viewer, workspace)) return Response.json({ sessions: [] } satisfies RecentsData, { headers });
  const shown = { sessionsOnly: true } as const;
  const [mine, live, items, approvals] = await Promise.all([
    work.listWorkspaceSessions(workspace, viewer, { ...shown, shown: "recent", person: viewer.username, limit: MAX_RECENT_SESSIONS }).catch(() => null),
    // What is going now, whoever runs it, and what the viewer is assigned and may answer:
    // a session missing from these still shows when the viewer started it, so each falls back quietly.
    part(work.listWorkspaceSessions(workspace, viewer, { ...shown, shown: "live", limit: LIVE }), "Live sessions"),
    part(work.listWorkItems(workspace, viewer, { state: "open", assignee: viewer.username, limit: LIST_PAGE }), "Your work items"),
    part(agentSessions.approvals(viewer, workspace), "Calls waiting for approval"),
  ]);
  if (!mine?.ok) return Response.json({ sessions: null } satisfies RecentsData, { headers });
  const value = <T, F>(read: Result<T> | Failed, fallback: F): T | F => {
    const result = orElse(read, null);
    return result?.ok ? result.value : fallback;
  };
  const sessions = recentSessions({
    me: viewer.username,
    mine: mine.value.sessions,
    live: value(live, null)?.sessions ?? [],
    items: (value(items, null) ?? []).map((item) => item.number),
    approvals: value(approvals, null),
  });
  return Response.json({ sessions } satisfies RecentsData, { headers });
}
