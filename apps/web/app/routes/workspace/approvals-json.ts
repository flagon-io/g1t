/**
 * `-/approvals.json`: the calls of this workspace's hosted sessions that
 * wait for the viewer to allow or deny them, newest first, for Needs
 * attention in Chat's sidebar (components/needs-attention.tsx). Only those
 * the viewer may answer (whoever started the session, and the workspace's
 * members with write access to its repository), as the integrations
 * service decides. Read when the sidebar is drawn and when the window
 * comes back into view, as /inbox.json is.
 */
import type { AgentApproval } from "@g1t/contracts";

import type { Route } from "./+types/approvals-json";
import { agentSessions } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";

export type ApprovalsData = {
  /** Null when they could not be read. */
  approvals: AgentApproval[] | null;
};

export async function loader({ params, context }: Route.LoaderArgs) {
  // Never kept: a call is answered or declined within minutes.
  const headers = { "cache-control": "private, no-store" };
  const viewer = getViewer(context);
  if (!viewer) return Response.json(null, { status: 401, headers });
  const workspace = params.owner.toLowerCase();
  if (!roleIn(viewer, workspace)) return Response.json({ approvals: [] } satisfies ApprovalsData, { headers });
  const listed = await agentSessions.approvals(viewer, workspace).catch(() => null);
  const data: ApprovalsData = { approvals: listed?.ok ? listed.value : null };
  return Response.json(data, { headers });
}
